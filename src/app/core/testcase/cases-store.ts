import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Session } from '../session';
import { Workspace, asGitHubError } from '../workspace';
import { FeatureSelection } from '../feature-selection';
import { GitHubError } from '../github/client';
import {
  CommentNode,
  addComment,
  closeIssue,
  createIssue,
  createLabel,
  fetchIssue,
  fetchProjectIssues,
  fetchBugTarget,
  fetchUserIds,
  reopenIssue,
  updateIssue,
} from '../github/api';
import { LABELS } from '../config/labels';
import { Platform, TeamConfig, includesLogin, sameLogin } from '../config/team-config';
import {
  Status,
  TESTCASE_LABEL,
  TestCase,
  TestCaseDraft,
  describeEdit,
  draftOf,
  fromIssue,
  issueTitle,
  isScenarioChange,
  labelsFor,
  renderBody,
} from './model';
import { closeComment, editComment, lineComment, reviewComment, submitComment } from './comments';
import { Decision, LineNote, historyOf } from './review';
import { BugLink, RunEvent, RunMeta, bugComment, canRun, latestRuns, runComment, runLabels, runsOf, statusFromRuns } from './runs';
import { EvidenceRef, UploadFile, uploadEvidence } from '../evidence/evidence';

export type CasesLoad = { status: 'idle' | 'loading' | 'ready' } | { status: 'error'; error: GitHubError };

export interface CaseDetail {
  testCase: TestCase;
  comments: CommentNode[];
}

const REFRESH_AFTER_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Test cases for the selected feature, and every write the app makes to them. */
@Injectable({ providedIn: 'root' })
export class CasesStore {
  private readonly session = inject(Session);
  private readonly ws = inject(Workspace);
  private readonly features = inject(FeatureSelection);

  readonly cases = signal<TestCase[]>([]);
  /** Bumped after every write, so views like the inbox know to refresh. */
  readonly writes = signal(0);
  readonly load = signal<CasesLoad>({ status: 'idle' });
  private loadedFor: string | null = null;
  private loadedAt = 0;
  private readonly userIds = new Map<string, string>();

  /** Open cases sorted P0 first, then by number. */
  readonly openCases = computed(() =>
    this.cases()
      .filter((c) => !c.closed)
      .sort((a, b) => (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9') || a.number - b.number),
  );

  constructor() {
    effect(() => {
      const project = this.features.project();
      const repo = this.ws.repo();
      untracked(() => {
        const key = project && repo ? `${repo.nameWithOwner}#${project.id}` : null;
        if (key !== this.loadedFor) {
          this.cases.set([]);
          this.loadedFor = key;
          if (key) void this.refresh();
          else this.load.set({ status: 'idle' });
        }
      });
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - this.loadedAt > REFRESH_AFTER_MS) {
          void this.refresh(true);
        }
      });
    }
  }

  async refresh(quiet = false): Promise<void> {
    const project = this.features.project();
    const repo = this.ws.repo();
    if (!project || !repo) return;
    const key = `${repo.nameWithOwner}#${project.id}`;
    if (!quiet) this.load.set({ status: 'loading' });
    try {
      const issues = await fetchProjectIssues(this.session.requireClient(), project.id, repo.nameWithOwner);
      if (key !== this.loadedFor) return; // the feature changed meanwhile
      this.cases.set(
        issues.filter((i) => i.labels.nodes.some((l) => l.name.toLowerCase() === TESTCASE_LABEL)).map(fromIssue),
      );
      this.loadedAt = Date.now();
      this.load.set({ status: 'ready' });
    } catch (e) {
      if (!quiet) this.load.set({ status: 'error', error: asGitHubError(e) });
    }
  }

  byNumber(n: number): TestCase | null {
    return this.cases().find((c) => c.number === n) ?? null;
  }

  async detail(number: number): Promise<CaseDetail> {
    const repo = this.requireRepo();
    const { issue, comments } = await fetchIssue(this.session.requireClient(), repo.owner, repo.name, number);
    const testCase = fromIssue(issue);
    this.upsert(testCase);
    return { testCase, comments };
  }

  // ---- writes ------------------------------------------------------------------

  /** AU-3: creates the issue on the feature board, as Draft (or straight into review). */
  async create(draft: TestCaseDraft, opts: { submitTo?: string[] } = {}): Promise<TestCase> {
    const repo = this.requireRepo();
    const project = this.features.project();
    const me = this.requireMe();
    const status: Status = opts.submitTo ? 'in-review' : 'draft';
    const assignees = opts.submitTo?.length ? opts.submitTo : [me];
    const gh = this.session.requireClient();
    const issue = await createIssue(gh, {
      repositoryId: repo.id,
      title: issueTitle(draft.title),
      body: renderBody(draft),
      labelIds: await this.labelIds(labelsFor([], { ...draft, status, regression: false })),
      assigneeIds: await this.idsFor(assignees),
      projectV2Ids: project ? [project.id] : [],
    });
    if (opts.submitTo) await addComment(gh, issue.id, submitComment(opts.submitTo, false));
    return this.upsert(fromIssue(issue));
  }

  /**
   * Creates many drafts one after another (IM-3). GitHub limits how fast content can be
   * created, so requests are spaced out, and a rate-limit error waits and retries.
   * Already-created cases stay created if the run stops; a re-run skips them by name.
   */
  async createMany(
    drafts: TestCaseDraft[],
    progress: (p: { done: number; total: number; waiting: boolean }) => void,
    cancelled: () => boolean,
    spacingMs = 1000,
  ): Promise<{ created: TestCase[]; error: GitHubError | null }> {
    const created: TestCase[] = [];
    for (const draft of drafts) {
      if (cancelled()) break;
      const started = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          created.push(await this.create(draft));
          break;
        } catch (e) {
          const err = asGitHubError(e);
          if (err.kind !== 'rate_limited' || attempt >= 2) return { created, error: err };
          progress({ done: created.length, total: drafts.length, waiting: true });
          await sleep(60_000 * (attempt + 1));
        }
      }
      progress({ done: created.length, total: drafts.length, waiting: false });
      const wait = spacingMs - (Date.now() - started);
      if (wait > 0 && created.length < drafts.length) await sleep(wait);
    }
    return { created, error: null };
  }

  /**
   * Saves an edit. A scenario change on a case past review sends it back to In review
   * with a comment (AU-5, AU-8); changes-requested cases wait for an explicit resubmit.
   */
  async save(tc: TestCase, draft: TestCaseDraft): Promise<TestCase> {
    const before = draftOf(tc);
    const changes = describeEdit(before, draft);
    if (!changes.length) return tc;
    const reviewed = tc.status === 'approved' || tc.status === 'passed' || tc.status === 'failed' || tc.status === 'blocked';
    const backToReview = reviewed && isScenarioChange(before, draft);
    const status: Status = backToReview ? 'in-review' : (tc.status ?? 'draft');
    const reviewers = backToReview ? this.suggestReviewers({ ...tc, platforms: draft.platforms }) : [];
    const gh = this.session.requireClient();
    const issue = await updateIssue(gh, {
      id: tc.id,
      title: issueTitle(draft.title),
      body: renderBody(draft, tc.extraBody),
      labelIds: await this.labelIds(
        labelsFor(tc.labels, { ...draft, status, regression: tc.regression, ...(backToReview ? { runLabels: [] } : {}) }),
      ),
      ...(backToReview ? { assigneeIds: await this.idsFor(reviewers) } : {}),
    });
    if (tc.status !== 'draft') {
      await addComment(gh, tc.id, editComment(changes, backToReview, reviewers));
    }
    return this.upsert(fromIssue(issue));
  }

  /** AU-4 / RV-4: Draft or Changes requested → In review, assigned to the reviewers (5.3a). */
  async submit(tc: TestCase, reviewers: string[]): Promise<TestCase> {
    const resubmit = tc.status === 'changes-requested';
    const gh = this.session.requireClient();
    const issue = await updateIssue(gh, {
      id: tc.id,
      labelIds: await this.labelIds(this.labelsWithStatus(tc, 'in-review')),
      assigneeIds: await this.idsFor(reviewers),
    });
    await addComment(gh, tc.id, submitComment(reviewers, resubmit));
    return this.upsert(fromIssue(issue));
  }

  /** AU-7: close as Won't test. */
  async close(tc: TestCase, reason: string): Promise<TestCase> {
    const gh = this.session.requireClient();
    await addComment(gh, tc.id, closeComment(reason));
    return this.upsert(fromIssue(await closeIssue(gh, tc.id)));
  }

  /** AU-7: reopening returns a case to Draft, assigned to whoever reopened it. */
  async reopen(tc: TestCase): Promise<TestCase> {
    const gh = this.session.requireClient();
    await reopenIssue(gh, tc.id);
    const issue = await updateIssue(gh, {
      id: tc.id,
      labelIds: await this.labelIds(this.labelsWithStatus(tc, 'draft')),
      assigneeIds: await this.idsFor([this.requireMe()]),
    });
    return this.upsert(fromIssue(issue));
  }

  // ---- review (5.3) ----------------------------------------------------------------

  /**
   * Records a review (RV-2, RV-3). One approval moves the case to Approved and assigns it
   * to one engineer per platform to run (5.3a); a change request sends it to the author.
   */
  async review(tc: TestCase, decision: Decision, note: string, platform: Platform): Promise<TestCase> {
    const gh = this.session.requireClient();
    const approve = decision === 'approve';
    const assignees = approve ? this.suggestExecutors(tc) : tc.author ? [tc.author] : [];
    await addComment(gh, tc.id, reviewComment(platform, decision, note));
    const issue = await updateIssue(gh, {
      id: tc.id,
      labelIds: await this.labelIds(this.labelsWithStatus(tc, approve ? 'approved' : 'changes-requested')),
      assigneeIds: await this.idsFor(assignees),
    });
    return this.upsert(fromIssue(issue));
  }

  /** LR-1 / LR-2: a comment on one step, optionally with suggested wording. */
  async commentOnStep(tc: TestCase, step: number, note: string, suggestion?: string): Promise<void> {
    const original = tc.steps[step]?.text ?? '';
    await addComment(this.session.requireClient(), tc.id, lineComment(step, original, note, suggestion));
    this.writes.update((n) => n + 1);
  }

  /** LR-2: accepting a suggestion is an edit like any other (AU-8). */
  async applySuggestion(tc: TestCase, note: LineNote): Promise<TestCase> {
    if (note.suggestion === null || !tc.steps[note.step]) return tc;
    const draft = draftOf(tc);
    draft.steps[note.step] = { ...draft.steps[note.step], text: note.suggestion };
    return this.save(tc, draft);
  }

  /** Manual reassignment (AS-2, AS-3). */
  async assign(tc: TestCase, logins: string[]): Promise<TestCase> {
    const issue = await updateIssue(this.session.requireClient(), {
      id: tc.id,
      assigneeIds: await this.idsFor(logins),
    });
    return this.upsert(fromIssue(issue));
  }

  /**
   * One engineer per target platform to run the case (5.3a), each the platform engineer
   * with the fewest cases waiting to be run; different people where possible (AS-4).
   */
  suggestExecutors(tc: Pick<TestCase, 'platforms'>): string[] {
    const config = this.ws.config();
    if (!config) return [];
    const toRun = (login: string) =>
      this.openCases().filter(
        (c) => ['approved', 'failed', 'blocked'].includes(c.status ?? '') && c.assignees.some((a) => sameLogin(a.login, login)),
      ).length;
    const chosen: string[] = [];
    for (const p of tc.platforms) {
      const pool = config.team[p];
      if (!pool.length) continue;
      const ranked = [...pool].sort(
        (a, b) => Number(includesLogin(chosen, a)) - Number(includesLogin(chosen, b)) || toRun(a) - toRun(b),
      );
      if (!includesLogin(chosen, ranked[0])) chosen.push(ranked[0]);
    }
    return chosen;
  }

  // ---- runs (5.5) ---------------------------------------------------------------

  /**
   * Records a run (EX-1 to EX-5): uploads evidence, posts the run comment, then works out
   * each platform's result on the target version and updates status, run labels and the
   * runners (whoever passed a platform is unassigned from it, 5.3a).
   */
  async recordRun(
    tc: TestCase,
    meta: RunMeta,
    notes: string,
    files: UploadFile[],
    onProgress: (stage: string) => void = () => {},
  ): Promise<{ testCase: TestCase; run: RunEvent | null }> {
    if (!canRun(tc)) throw new GitHubError('conflict', 'Only approved test cases can be run.');
    const repo = this.requireRepo();
    const gh = this.session.requireClient();
    let evidence: EvidenceRef[] = [];
    if (files.length) {
      onProgress(`Uploading evidence (0/${files.length})…`);
      evidence = await uploadEvidence(
        gh,
        repo.nameWithOwner,
        files,
        `Evidence for #${tc.number} on ${meta.platform}`,
        (done, total) => onProgress(`Uploading evidence (${done}/${total})…`),
      );
    }
    onProgress('Saving the run…');
    const posted = await addComment(gh, tc.id, runComment(repo.nameWithOwner, meta, notes, evidence));
    return { testCase: await this.syncRunState(tc, meta), run: runsOf([posted])[0] ?? null };
  }

  /** Recomputes status, run labels and runners from the case's comments. */
  async syncRunState(tc: TestCase, lastRun?: RunMeta): Promise<TestCase> {
    const repo = this.requireRepo();
    const gh = this.session.requireClient();
    const { comments } = await fetchIssue(gh, repo.owner, repo.name, tc.number);
    const since = historyOf(comments).versionStart;
    const target = this.features.settings()?.targetVersion ?? null;
    const latest = latestRuns(runsOf(comments), tc.platforms, target, since);
    const status = statusFromRuns(tc.platforms, latest);
    const config = this.ws.config();
    const me = this.requireMe();

    // Runners: one per platform still to pass; nobody for platforms that passed.
    const assignees: string[] = [];
    for (const p of tc.platforms) {
      if (latest[p]?.result === 'pass') continue;
      const onPlatform = (l: string) => !!config && includesLogin(config.team[p], l);
      const current = tc.assignees.map((a) => a.login).find(onPlatform);
      // Whoever just ran it and didn't pass takes the slot (AS-3).
      const runner = lastRun?.platform === p && lastRun.result !== 'pass' && onPlatform(me) ? me : current;
      if (runner && !includesLogin(assignees, runner)) assignees.push(runner);
    }
    const issue = await updateIssue(gh, {
      id: tc.id,
      labelIds: await this.labelIds(
        labelsFor(tc.labels, {
          priority: tc.priority ?? 'P2',
          platforms: tc.platforms,
          status,
          regression: tc.regression,
          runLabels: runLabels(latest),
        }),
      ),
      assigneeIds: await this.idsFor(assignees),
    });
    return this.upsert(fromIssue(issue));
  }

  /** EX-6: files a bug for a failed run in bugs.repo (or the testbank repo) and links it. */
  async fileBug(tc: TestCase, platform: Platform | null, title: string, body: string): Promise<BugLink> {
    const repo = this.requireRepo();
    const gh = this.session.requireClient();
    const target = this.ws.config()?.bugs.repo ?? repo.nameWithOwner;
    const [owner, name] = target.split('/');
    const { id, bugLabelId } = await fetchBugTarget(gh, owner, name);
    const issue = await createIssue(gh, {
      repositoryId: id,
      title,
      body,
      labelIds: bugLabelId ? [bugLabelId] : [],
      assigneeIds: [],
    });
    const link: BugLink = { platform, issue: `${target}#${issue.number}`, url: issue.url };
    await addComment(gh, tc.id, bugComment(link));
    this.writes.update((n) => n + 1);
    return link;
  }

  /** AS-5: one Android and one iOS runner for many approved cases at once. */
  async assignRunners(
    cases: TestCase[],
    picks: Partial<Record<Platform, string>>,
    progress: (done: number) => void = () => {},
  ): Promise<void> {
    for (const [i, tc] of cases.entries()) {
      const logins = tc.platforms
        .map((p) => picks[p] ?? tc.assignees.map((a) => a.login).find((l) => includesLogin(this.ws.config()?.team[p] ?? [], l)))
        .filter((l): l is string => !!l);
      await this.assign(tc, logins.filter((l, j) => logins.findIndex((x) => sameLogin(x, l)) === j));
      progress(i + 1);
    }
  }

  // ---- reviewers (5.3a) ------------------------------------------------------------

  /** Engineers allowed to review a case (RV-2). */
  eligibleReviewers(platforms: Platform[], config: TeamConfig | null = this.ws.config()): string[] {
    if (!config) return [];
    const pool = platforms.flatMap((p) => config.team[p]);
    return pool.filter((l, i) => pool.findIndex((x) => sameLogin(x, l)) === i);
  }

  /**
   * One reviewer by default: the configured default reviewer for the case's platform,
   * else the eligible engineer with the fewest cases waiting on them (AS-4).
   */
  suggestReviewers(tc: Pick<TestCase, 'platforms' | 'author'>): string[] {
    const config = this.ws.config();
    if (!config || !tc.platforms.length) return [];
    const eligible = this.eligibleReviewers(tc.platforms, config);
    if (!eligible.length) return [];
    for (const p of tc.platforms) {
      const d = config.assignment.defaultReviewer[p];
      if (d && includesLogin(eligible, d)) return [d];
    }
    const me = this.session.viewer()?.login ?? '';
    const load = (login: string) =>
      this.openCases().filter((c) => c.status === 'in-review' && c.assignees.some((a) => sameLogin(a.login, login))).length;
    const ranked = [...eligible].sort((a, b) => Number(sameLogin(a, me)) - Number(sameLogin(b, me)) || load(a) - load(b));
    return [ranked[0]];
  }

  // ---- helpers -----------------------------------------------------------------

  private labelsWithStatus(tc: TestCase, status: Status): string[] {
    return labelsFor(tc.labels, {
      priority: tc.priority ?? 'P2',
      platforms: tc.platforms,
      status,
      regression: tc.regression,
    });
  }

  /** Label ids for names, creating any the repo is missing (e.g. deleted by hand). */
  private async labelIds(names: string[]): Promise<string[]> {
    const repo = this.requireRepo();
    const ids: string[] = [];
    for (const name of names) {
      let id = repo.labelIds[name.toLowerCase()];
      if (!id) {
        const spec = LABELS.find((l) => l.name.toLowerCase() === name.toLowerCase());
        id = await createLabel(this.session.requireClient(), repo.id, {
          name,
          color: spec?.color ?? 'ededed',
          description: spec?.description ?? '',
        });
        repo.labelIds[name.toLowerCase()] = id;
      }
      ids.push(id);
    }
    return ids;
  }

  private async idsFor(logins: string[]): Promise<string[]> {
    const missing = logins.filter((l) => !this.userIds.has(l.toLowerCase()));
    if (missing.length) {
      const found = await fetchUserIds(this.session.requireClient(), missing);
      for (const [login, id] of Object.entries(found)) this.userIds.set(login, id);
    }
    return logins.map((l) => this.userIds.get(l.toLowerCase())).filter((x): x is string => !!x);
  }

  private upsert(tc: TestCase): TestCase {
    this.writes.update((n) => n + 1);
    this.cases.update((list) => {
      const i = list.findIndex((c) => c.number === tc.number);
      if (i < 0) return [...list, tc];
      const next = [...list];
      next[i] = tc;
      return next;
    });
    return tc;
  }

  private requireRepo() {
    const r = this.ws.repo();
    if (!r) throw new GitHubError('not_found', 'No repo is open.');
    return r;
  }

  private requireMe(): string {
    const v = this.session.viewer();
    if (!v) throw new GitHubError('auth', 'Not signed in.');
    return v.login;
  }
}

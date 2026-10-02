import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Workspace, asGitHubError } from '../../core/workspace';
import { Session } from '../../core/session';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { CommentNode, fetchProjectComments } from '../../core/github/api';
import { PRIORITIES, Platform, Priority, setFeatureSettings } from '../../core/config/team-config';
import { saveConfigFile } from '../../core/config/save-config';
import { PLATFORM_NAMES, STATUSES, STATUS_LABELS, TestCase } from '../../core/testcase/model';
import {
  blockers,
  burndown,
  changesSince,
  platformProgress,
  readinessReport,
  slotResult,
  statusGrid,
  verdict,
} from '../../core/testcase/readiness';
import { BugLink, RunEvent, bugsOf, latestRuns, runsOf } from '../../core/testcase/runs';
import { historyOf } from '../../core/testcase/review';
import { timeAgo } from '../../core/time';
import { PriorityBadge } from '../cases/badges';
import { EvidenceThumb } from '../runs/evidence-thumb';
import { PlatformBar } from './platform-bar';
import { BurndownChart } from './burndown-chart';

const SEEN_KEY = 'tcm.dashboardSeen.';

interface Problem {
  tc: TestCase;
  platform: Platform;
  result: 'fail' | 'blocked';
  run: RunEvent | null;
  bugs: BugLink[];
}

/** The tech lead's view of a feature (PRD 5.4, RR-1 to RR-4). */
@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, PriorityBadge, EvidenceThumb, PlatformBar, BurndownChart],
  template: `
    <main class="page stack">
      <div class="row wrap">
        <div class="stack" style="gap: 2px">
          <h1>{{ features.project()?.title ?? 'Dashboard' }}</h1>
          <span class="muted small">
            @if (target(); as v) { Target v{{ v }} } @else { No target version }
            · @if (release(); as d) { release {{ d }} } @else { no release date }
            @if (canEdit()) {
              · <button class="btn btn-link small" type="button" (click)="editing.set(!editing())">edit</button>
            }
          </span>
        </div>
        <span class="spacer"></span>
        <button class="btn" type="button" (click)="copyReport()" [disabled]="!features.project()">
          {{ copied() ? 'Copied ✓' : 'Copy readiness report' }}
        </button>
      </div>

      @if (editing()) {
        <form class="card row wrap settings" (submit)="$event.preventDefault(); saveSettings(tv.value, rd.value)">
          <label class="field small">Target app version <input #tv type="text" [value]="target() ?? ''" placeholder="4.12.0" /></label>
          <label class="field small">Release date <input #rd type="date" [value]="release() ?? ''" /></label>
          <button class="btn btn-primary" type="submit" [disabled]="savingSettings()">Save</button>
          <button class="btn" type="button" (click)="editing.set(false)">Cancel</button>
          @if (settingsError()) { <span class="small bad">{{ settingsError() }}</span> }
          <span class="muted small">Saved to the team config. Runs on other versions are kept but don't count.</span>
        </form>
      }

      @if (!features.project()) {
        <section class="card"><p class="muted">Link a GitHub Project board to this repo to see its dashboard.</p></section>
      } @else if (store.load().status === 'loading' && !store.cases().length) {
        <div class="row muted"><span class="spinner" aria-hidden="true"></span> Loading…</div>
      } @else {
        <section [class]="'verdict card ' + (v().ready ? 'ok' : 'no')" aria-live="polite">
          <div class="verdict-icon" aria-hidden="true">{{ v().ready ? '✓' : '!' }}</div>
          <div class="stack" style="gap: 6px">
            <h2 class="headline">{{ v().headline }}</h2>
            @if (v().warnings.length) {
              <p class="small">Also: {{ v().warnings.join(', ') }} (not blocking).</p>
            }
            <p class="muted small">
              Rule: every {{ blockingLabel() }} case passes on every target platform{{ target() ? ' on v' + target() : '' }}.
              @if (!target()) { Set a target version so only runs on that build count. }
            </p>
          </div>
        </section>

        @if (blockerList().length) {
          <section class="card stack" aria-labelledby="blockers-h">
            <h2 class="h-small" id="blockers-h">Blocking release <span class="count">{{ blockerList().length }}</span></h2>
            <ul class="blockers">
              @for (b of shownBlockers(); track b.tc.number) {
                <li>
                  <app-priority [value]="b.tc.priority" />
                  <a [routerLink]="['../cases', b.tc.number]" queryParamsHandling="preserve">#{{ b.tc.number }} {{ b.tc.title }}</a>
                  <span class="gaps">
                    @if (b.unapproved) {
                      <span class="badge badge-outline">not approved yet</span>
                    }
                    @for (g of b.gaps; track g.platform) {
                      <span [class]="'badge gap-' + g.state">{{ gapIcon[g.state] }} {{ names[g.platform] }} {{ gapWord[g.state] }}</span>
                    }
                  </span>
                  <span class="small muted owner">
                    @if (b.tc.assignees.length) { {{ ownerNames(b.tc) }} } @else { nobody assigned }
                  </span>
                </li>
              }
            </ul>
            @if (blockerList().length > shownBlockers().length) {
              <button class="btn btn-link small" type="button" (click)="allBlockers.set(true)">Show all {{ blockerList().length }}</button>
            }
          </section>
        }

        <section class="two">
          <div class="card stack">
            <h2 class="h-small">Runs per platform</h2>
            @for (p of progress(); track p.platform) {
              <app-platform-bar [p]="p" />
            }
          </div>
          <div class="card stack">
            <h2 class="h-small">Burndown</h2>
            @if (bd(); as b) {
              <app-burndown-chart [data]="b" />
            } @else if (loadingComments()) {
              <div class="row muted small"><span class="spinner" aria-hidden="true"></span> Loading run history…</div>
            } @else {
              <p class="muted small">Nothing to run yet: the burndown starts once cases are approved.</p>
            }
          </div>
        </section>

        <section class="card stack">
          <h2 class="h-small">Test cases by priority and status</h2>
          <div class="scroll-x wide-only">
          <table class="grid-table">
            <thead>
              <tr>
                <th scope="col">Priority</th>
                @for (s of statuses; track s) { <th scope="col">{{ statusLabels[s] }}</th> }
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              @for (p of priorities; track p) {
                <tr>
                  <th scope="row"><app-priority [value]="p" /></th>
                  @for (s of statuses; track s) {
                    <td>
                      @if (grid()[p][s]; as n) {
                        <a [class]="'cell c-' + s" routerLink="../cases" [queryParams]="{ priority: p, status: s }" queryParamsHandling="merge">{{ n }}</a>
                      } @else {
                        <span class="zero">·</span>
                      }
                    </td>
                  }
                  <td class="total">{{ rowTotal(p) }}</td>
                </tr>
              }
            </tbody>
          </table>
          </div>
          <!-- Phones: statuses down the side so the table fits without scrolling sideways. -->
          <table class="grid-table narrow-only">
            <thead>
              <tr>
                <th scope="col">Status</th>
                @for (p of priorities; track p) { <th scope="col"><app-priority [value]="p" /></th> }
              </tr>
            </thead>
            <tbody>
              @for (s of statuses; track s) {
                <tr>
                  <th scope="row">{{ statusLabels[s] }}</th>
                  @for (p of priorities; track p) {
                    <td>
                      @if (grid()[p][s]; as n) {
                        <a [class]="'cell c-' + s" routerLink="../cases" [queryParams]="{ priority: p, status: s }" queryParamsHandling="merge">{{ n }}</a>
                      } @else {
                        <span class="zero">·</span>
                      }
                    </td>
                  }
                </tr>
              }
              <tr>
                <th scope="row">Total</th>
                @for (p of priorities; track p) { <td class="total">{{ rowTotal(p) }}</td> }
              </tr>
            </tbody>
          </table>
        </section>

        <section class="card stack">
          <h2 class="h-small">Failing and blocked</h2>
          @if (problems().length) {
            <ul class="problems">
              @for (pr of problems(); track pr.tc.number + pr.platform) {
                <li>
                  <div class="row wrap">
                    <app-priority [value]="pr.tc.priority" />
                    <span [class]="'badge res-' + pr.result">{{ pr.result === 'fail' ? '✗ Failed' : '⛔ Blocked' }} on {{ names[pr.platform] }}</span>
                    <a [routerLink]="['../cases', pr.tc.number]" queryParamsHandling="preserve"><strong>#{{ pr.tc.number }} {{ pr.tc.title }}</strong></a>
                  </div>
                  @if (pr.run; as r) {
                    <div class="small muted">
                      v{{ r.appVersion }}{{ r.build ? ' (' + r.build + ')' : '' }} · {{ r.device || 'device not given' }} · {{ r.author }} · {{ ago(r.executedAt) }}
                    </div>
                    @if (r.notes) { <div class="small">{{ r.notes }}</div> }
                    @if (r.evidence.length) { <app-evidence-thumb [ref]="r.evidence[0]" /> }
                  }
                  @if (pr.bugs.length) {
                    <div class="small">Bug:
                      @for (b of pr.bugs; track b.url) { <a [href]="b.url" target="_blank" rel="noopener">{{ b.issue }}</a>&nbsp; }
                    </div>
                  } @else if (pr.result === 'fail') {
                    <div class="small muted">No bug filed yet.</div>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="muted small">Nothing failing or blocked{{ target() ? ' on v' + target() : '' }}.</p>
          }
        </section>

        <section class="card stack">
          <div class="row">
            <h2 class="h-small">What changed</h2>
            <span class="muted small">since your last visit, {{ ago(seenBefore()) }}</span>
          </div>
          @if (loadingComments()) {
            <div class="row muted small"><span class="spinner" aria-hidden="true"></span> Loading…</div>
          } @else if (changes().length) {
            @for (g of changeGroups(); track g.day) {
              <h3 class="day">{{ g.day }}</h3>
              <ul class="changes">
                @for (c of g.items; track c.at + c.caseNumber + c.kind) {
                  <li>
                    <span [class]="'dot k-' + c.kind" aria-hidden="true"></span>
                    <strong>{{ c.who }}</strong> {{ c.text }}
                    <a [routerLink]="['../cases', c.caseNumber]" queryParamsHandling="preserve">#{{ c.caseNumber }} {{ c.caseTitle }}</a>
                  </li>
                }
              </ul>
            }
            @if (changes().length > shownChanges()) {
              <button class="btn btn-link small" type="button" (click)="shownChanges.set(changes().length)">
                Show all {{ changes().length }}
              </button>
            }
          } @else {
            <p class="muted small">No reviews, runs or bugs since then.</p>
          }
        </section>
        @if (commentsError()) {
          <div class="banner banner-warn small">Run history couldn't be loaded: {{ commentsError() }}</div>
        }
      }
    </main>
  `,
  styles: `
    .wrap { flex-wrap: wrap; }
    .settings { gap: 12px; align-items: flex-end; }
    .settings input { width: 160px; }
    .bad { color: var(--bad); }
    .h-small { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); }
    .verdict { display: flex; gap: 16px; align-items: flex-start; border-left-width: 6px; }
    .verdict.ok { border-left-color: var(--good); background: var(--good-soft); }
    .verdict.no { border-left-color: var(--bad); background: var(--bad-soft); }
    .verdict-icon { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 800; color: #fff; flex: none; }
    .ok .verdict-icon { background: var(--good); }
    .no .verdict-icon { background: var(--bad); }
    .headline { font-size: 20px; }
    .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 16px; }
    @media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
    .scroll-x { overflow-x: auto; }
    .narrow-only { display: none; }
    @media (max-width: 600px) {
      .wide-only { display: none; }
      .narrow-only { display: table; min-width: 0; }
    }
    .grid-table { min-width: 640px; width: 100%; border-collapse: collapse; font-size: 13px; }
    .grid-table th, .grid-table td { padding: 6px 8px; text-align: center; border-bottom: 1px solid var(--border); }
    .grid-table th:first-child { text-align: left; }
    .grid-table thead th { color: var(--text-2); font-weight: 600; font-size: 12px; }
    .cell { display: inline-block; min-width: 28px; padding: 2px 6px; border-radius: 6px; font-weight: 700; text-decoration: none; color: var(--text); background: var(--surface-2); }
    .cell:hover { outline: 2px solid var(--accent); }
    .c-failed { background: var(--bad-soft); color: var(--bad); }
    .c-blocked { background: var(--warn-soft); color: var(--warn); }
    .c-passed { background: var(--good-soft); color: var(--good); }
    .zero { color: var(--border-strong); }
    .total { font-weight: 700; }
    .problems, .changes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .problems li { display: flex; flex-direction: column; gap: 4px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
    .problems li:last-child { border-bottom: none; padding-bottom: 0; }
    .res-fail { background: var(--bad-soft); color: var(--bad); }
    .count { text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--text); margin-left: 4px; }
    .blockers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .blockers li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .blockers li:last-child { border-bottom: none; }
    .gaps { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .owner { margin-left: auto; }
    .gap-fail { background: var(--bad-soft); color: var(--bad); }
    .gap-blocked { background: var(--warn-soft); color: var(--warn); }
    .gap-none { background: var(--surface-2); color: var(--text-2); }
    .res-blocked { background: var(--warn-soft); color: var(--warn); }
    .changes { gap: 6px; font-size: 13.5px; }
    .day { font-size: 12px; font-weight: 600; color: var(--text-2); margin-top: 4px; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--text-2); }
    .k-pass, .k-approved { background: var(--good); }
    .k-fail, .k-changes { background: var(--bad); }
    .k-blocked { background: var(--warn); }
    .k-bug { background: var(--bad); }
  `,
})
export class DashboardPage {
  protected readonly ws = inject(Workspace);
  protected readonly features = inject(FeatureSelection);
  protected readonly store = inject(CasesStore);
  private readonly session = inject(Session);

  protected readonly priorities = PRIORITIES;
  protected readonly statuses = STATUSES;
  protected readonly statusLabels = STATUS_LABELS;
  protected readonly names = PLATFORM_NAMES;
  protected readonly ago = (iso: string) => timeAgo(iso);

  private readonly comments = signal<Map<number, CommentNode[]>>(new Map());
  protected readonly loadingComments = signal(false);
  protected readonly commentsError = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly editing = signal(false);
  protected readonly savingSettings = signal(false);
  protected readonly settingsError = signal<string | null>(null);
  /** When the user last looked at this feature's dashboard (RR-3). */
  protected readonly seenBefore = signal(new Date(Date.now() - 7 * 864e5).toISOString());

  protected readonly target = computed(() => this.features.settings()?.targetVersion ?? null);
  protected readonly release = computed(() => this.features.settings()?.releaseDate ?? null);
  protected readonly blocking = computed<Priority[]>(() => this.ws.config()?.readiness.blockingPriorities ?? ['P0']);
  protected readonly blockingLabel = computed(() => this.blocking().join('/'));
  protected readonly canEdit = computed(() => this.ws.canEditTeam());

  protected readonly v = computed(() => verdict(this.store.cases(), this.blocking(), this.target()));
  /** RR-1 by name: which cases stand between the feature and "ready", and who has them. */
  protected readonly blockerList = computed(() => blockers(this.store.cases(), this.blocking()));
  protected readonly allBlockers = signal(false);
  protected readonly shownBlockers = computed(() => (this.allBlockers() ? this.blockerList() : this.blockerList().slice(0, 8)));
  protected readonly gapIcon = { fail: '✗', blocked: '⛔', none: '○' } as const;
  protected readonly gapWord = { fail: 'failed', blocked: 'blocked', none: 'not run' } as const;
  protected ownerNames(tc: TestCase): string {
    return tc.assignees.map((a) => a.login).join(', ');
  }
  protected readonly grid = computed(() => statusGrid(this.store.cases()));
  protected readonly progress = computed(() =>
    platformProgress(this.store.cases()).filter((p) => p.total > 0 || this.store.cases().some((c) => c.platforms.includes(p.platform))),
  );
  protected readonly bd = computed(() =>
    this.loadingComments() ? null : burndown(this.store.cases(), this.comments(), this.target(), this.release(), new Date().toISOString().slice(0, 10)),
  );
  protected readonly changes = computed(() => changesSince(this.store.cases(), this.comments(), this.seenBefore()));
  protected readonly shownChanges = signal(10);
  /** UX 12: newest first, grouped by day (Today, Yesterday, then dates). */
  protected readonly changeGroups = computed(() => {
    const groups: { day: string; items: ReturnType<typeof changesSince> }[] = [];
    const label = (iso: string) => {
      const d = new Date(iso);
      const today = new Date();
      const yesterday = new Date(Date.now() - 864e5);
      if (d.toDateString() === today.toDateString()) return 'Today';
      if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    };
    for (const c of this.changes().slice(0, this.shownChanges())) {
      const day = label(c.at);
      const g = groups.at(-1);
      if (g && g.day === day) g.items.push(c);
      else groups.push({ day, items: [c] });
    }
    return groups;
  });

  protected readonly problems = computed<Problem[]>(() => {
    const out: Problem[] = [];
    const order = (pr: string | null) => PRIORITIES.indexOf((pr ?? 'P3') as 'P0');
    for (const tc of [...this.store.cases()].sort((a, b) => order(a.priority) - order(b.priority))) {
      if (tc.closed) continue;
      const cs = this.comments().get(tc.number) ?? [];
      const latest = latestRuns(runsOf(cs), tc.platforms, this.target(), historyOf(cs).versionStart);
      for (const p of tc.platforms) {
        const r = slotResult(tc, p);
        if (r !== 'fail' && r !== 'blocked') continue;
        out.push({ tc, platform: p, result: r, run: latest[p] ?? null, bugs: bugsOf(cs).filter((b) => !b.platform || b.platform === p) });
      }
    }
    return out;
  });

  constructor() {
    // Load comments for the board whenever the feature or the cases change.
    effect(() => {
      const project = this.features.project();
      this.store.writes();
      const repo = this.ws.repo();
      untracked(() => {
        if (project && repo) void this.loadComments(project.id, repo.nameWithOwner);
      });
    });
    // Remember this visit, but show changes since the previous one.
    effect(() => {
      const repo = this.ws.repo();
      const project = this.features.project();
      if (!repo || !project) return;
      untracked(() => {
        const key = `${SEEN_KEY}${repo.nameWithOwner}#${project.number}@${this.session.viewer()?.login ?? ''}`;
        const prev = localStorage.getItem(key);
        if (prev) this.seenBefore.set(prev);
        localStorage.setItem(key, new Date().toISOString());
      });
    });
  }

  protected rowTotal(p: (typeof PRIORITIES)[number]): number {
    return STATUSES.reduce((sum, s) => sum + this.grid()[p][s], 0);
  }

  protected async copyReport(): Promise<void> {
    const md = readinessReport({
      feature: this.features.project()?.title ?? 'Feature',
      targetVersion: this.target(),
      releaseDate: this.release(),
      verdict: this.v(),
      grid: this.grid(),
      progress: platformProgress(this.store.cases()),
      problems: this.problems(),
      generatedAt: new Date().toISOString().slice(0, 10),
    });
    await navigator.clipboard.writeText(md);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  protected async saveSettings(targetVersion: string, releaseDate: string): Promise<void> {
    const repo = this.ws.repo();
    const state = this.ws.configState();
    const project = this.features.project();
    if (!repo || !project || state.kind !== 'ok') return;
    this.savingSettings.set(true);
    this.settingsError.set(null);
    try {
      const result = await saveConfigFile(
        this.session.requireClient(),
        repo,
        setFeatureSettings(state.raw, project.number, { targetVersion, releaseDate }),
        `Update feature settings: ${project.title}`,
        `Target version ${targetVersion || 'none'}, release date ${releaseDate || 'none'}. Saved from Test Case Manager.`,
      );
      if (result.kind === 'pull-request') {
        this.settingsError.set(`The branch is protected, so this was proposed in pull request #${result.number}.`);
      } else {
        await this.ws.reload();
        this.editing.set(false);
      }
    } catch (e) {
      const err = asGitHubError(e);
      this.settingsError.set(err.kind === 'conflict' ? 'The config changed meanwhile; reload and try again.' : err.message);
    } finally {
      this.savingSettings.set(false);
    }
  }

  private async loadComments(projectId: string, nameWithOwner: string): Promise<void> {
    this.loadingComments.set(this.comments().size === 0);
    this.commentsError.set(null);
    try {
      this.comments.set(await fetchProjectComments(this.session.requireClient(), projectId, nameWithOwner));
    } catch (e) {
      this.commentsError.set(asGitHubError(e).message);
    } finally {
      this.loadingComments.set(false);
    }
  }
}

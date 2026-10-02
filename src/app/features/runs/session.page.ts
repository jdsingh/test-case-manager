import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Workspace } from '../../core/workspace';
import { Session } from '../../core/session';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { RunQueue } from '../../core/testcase/run-queue';
import { Platform, includesLogin } from '../../core/config/team-config';
import { PLATFORM_NAMES, TestCase } from '../../core/testcase/model';
import { Environment, RunEvent, RunMeta, RunResult, canRun, runsOf } from '../../core/testcase/runs';
import { timeAgo } from '../../core/time';
import { loadRunDefaults, saveRunDefaults } from '../../core/testcase/run-defaults';
import { bugBody, bugTitle } from '../../core/testcase/bug-report';
import { asGitHubError } from '../../core/workspace';
import { PriorityBadge } from '../cases/badges';
import { EvidencePicker } from './evidence-picker';

interface SessionSetup {
  platform: Platform;
  appVersion: string;
  build: string;
  device: string;
  os: string;
  env: Environment;
  cases: number[];
}

const KEY = 'tcm.session';

/**
 * Test session mode (TS-1 to TS-7): the engineer runs cases on a test phone and records
 * them here on a laptop. Large type, tickable steps, one key per result, background uploads.
 */
@Component({
  selector: 'app-session-page',
  imports: [RouterLink, PriorityBadge, EvidencePicker],
  template: `
    @if (!setup()) {
      <main class="page-narrow stack">
        <h1>Start a test session</h1>
        <p class="muted">
          Pick the build you're testing. The session lists the approved cases in
          <strong>{{ features.project()?.title ?? 'this feature' }}</strong> assigned to you, and keeps these
          details for every run.
        </p>
        <form class="card stack" (submit)="$event.preventDefault(); start()">
          <label class="field">
            Platform
            <select (change)="pickPlatform($any($event.target).value)">
              @for (p of platforms; track p) {
                <option [value]="p" [selected]="p === form.platform()">{{ names[p] }}</option>
              }
            </select>
          </label>
          <div class="grid">
            <label class="field">App version <input type="text" [value]="form.appVersion()" (input)="form.appVersion.set($any($event.target).value)" required /></label>
            <label class="field">Build <input type="text" [value]="form.build()" (input)="form.build.set($any($event.target).value)" /></label>
            <label class="field">Device <input type="text" [value]="form.device()" (input)="form.device.set($any($event.target).value)" /></label>
            <label class="field">OS version <input type="text" [value]="form.os()" (input)="form.os.set($any($event.target).value)" /></label>
          </div>
          <label class="field">
            Environment
            <select (change)="form.env.set($any($event.target).value)">
              <option value="staging" [selected]="form.env() === 'staging'">Staging</option>
              <option value="production" [selected]="form.env() === 'production'">Production</option>
            </select>
          </label>
          <label class="row small">
            <input type="checkbox" [checked]="includeOthers()" (change)="includeOthers.set(!includeOthers())" />
            Also include cases assigned to other engineers
          </label>
          <p class="small">
            <strong>{{ candidates().length }}</strong> case{{ candidates().length === 1 ? '' : 's' }} to run on {{ names[form.platform()] }}.
          </p>
          <div class="row">
            <button class="btn btn-primary" type="submit" [disabled]="!candidates().length || !form.appVersion().trim()">Start session</button>
            <a class="btn" routerLink="../cases" queryParamsHandling="preserve">Cancel</a>
          </div>
        </form>
      </main>
    } @else {
      <div class="session">
        <header class="bar">
          <strong>{{ names[setup()!.platform] }}</strong>
          <span>v{{ setup()!.appVersion }}{{ setup()!.build ? ' (' + setup()!.build + ')' : '' }}</span>
          <span class="muted">{{ setup()!.device }} {{ setup()!.os }} · {{ setup()!.env }}</span>
          <span class="spacer"></span>
          <span class="small">{{ doneCount() }} of {{ sessionCases().length }} recorded</span>
          @if (queue.pending()) {
            <span class="small muted"><span class="spinner inline" aria-hidden="true"></span> uploading {{ queue.pending() }}</span>
          }
          <button class="btn" type="button" (click)="end()">End session</button>
        </header>

        <div class="body">
          <nav class="list" aria-label="Session cases">
            <ol>
              @for (tc of sessionCases(); track tc.number; let i = $index) {
                <li>
                  <button type="button" [class.on]="i === index()" (click)="go(i)">
                    <span class="state" [attr.aria-label]="stateLabel(tc)">{{ stateIcon(tc) }}</span>
                    <span class="t">#{{ tc.number }} {{ tc.title }}</span>
                  </button>
                </li>
              }
            </ol>
          </nav>

          @if (current(); as tc) {
            <article class="main" [attr.aria-label]="'Test case ' + tc.number">
              <div class="row">
                <app-priority [value]="tc.priority" />
                <span class="muted">#{{ tc.number }}</span>
              </div>
              <h1 class="case-title">{{ tc.title }}</h1>
              @if (tc.preconditions) {
                <p class="pre"><span class="muted">Before you start:</span> {{ tc.preconditions }}</p>
              }
              @if (lastRun(); as lr) {
                <div [class]="'banner small ' + (lr.result === 'fail' ? 'banner-bad' : 'banner-warn')" role="note">
                  <div>
                    <strong>Last run on {{ names[lr.platform] }}: {{ lr.result === 'fail' ? 'failed' : 'blocked' }}</strong>
                    <span class="muted"> · v{{ lr.appVersion }}{{ lr.build ? ' (' + lr.build + ')' : '' }} · {{ lr.author }} · {{ ago(lr.executedAt) }}</span>
                    @if (lr.notes) {
                      <div>{{ lr.notes }}</div>
                    }
                  </div>
                </div>
              }
              <ol class="steps">
                @for (s of tc.steps; track $index; let i = $index) {
                  <li [class.done]="ticked().has(i)" [class.next]="i === nextStep()" (click)="toggleTick(i)">
                    <span class="box" aria-hidden="true">{{ ticked().has(i) ? '✓' : '' }}</span>
                    <span><span class="kw">{{ s.keyword }}</span> {{ s.text }}</span>
                  </li>
                }
              </ol>

              @if (queue.latestFor(tc.number); as job) {
                @if (job.status === 'error') {
                  <div class="banner banner-bad small" role="alert">
                    Couldn't save the {{ job.meta.result }} run: {{ job.message }}
                    <button class="btn btn-link small" type="button" (click)="queue.retry(job.id)">Retry</button>
                  </div>
                } @else if (job.status === 'done') {
                  <div class="banner banner-good small">Recorded: {{ job.meta.result }}. {{ job.message !== 'Saved' ? job.message : '' }}</div>
                } @else {
                  <div class="banner small">Saving the {{ job.meta.result }} run in the background… {{ job.message }}</div>
                }
              }

              @if (bugFor() === tc.number) {
                <form class="card stack" (submit)="$event.preventDefault(); fileBug(tc)">
                  <strong>File a bug for this failure?</strong>
                  <input type="text" aria-label="Bug title" [value]="bugTitleText()" (input)="bugTitleText.set($any($event.target).value)" />
                  <textarea rows="6" class="mono" aria-label="Bug description" [value]="bugText()" (input)="bugText.set($any($event.target).value)"></textarea>
                  @if (bugError()) {
                    <div class="banner banner-bad small">{{ bugError() }}</div>
                  }
                  <div class="row">
                    <button class="btn btn-primary" type="submit" [disabled]="bugBusy()">File bug</button>
                    <button class="btn" type="button" (click)="bugFor.set(null); advance()">Skip</button>
                  </div>
                </form>
              } @else {
                <label class="field small">
                  Notes
                  <textarea rows="2" [value]="notes()" (input)="notes.set($any($event.target).value)" placeholder="Anything worth knowing (required for Fail and Blocked)"></textarea>
                </label>
                <app-evidence-picker [(files)]="files" />
                <div class="row actions">
                  <button class="btn res pass" type="button" (click)="record('pass')">Pass <span class="kbd">P</span></button>
                  <button class="btn res fail" type="button" (click)="record('fail')">Fail <span class="kbd">F</span></button>
                  <button class="btn res blocked" type="button" (click)="record('blocked')">Blocked <span class="kbd">B</span></button>
                  <span class="spacer"></span>
                  <span class="muted small"><span class="kbd">Space</span> tick step · <span class="kbd">J</span>/<span class="kbd">K</span> next/previous</span>
                </div>
                @if (hint()) {
                  <p class="small warn-text">{{ hint() }}</p>
                }
              }
            </article>
          } @else {
            <article class="main stack">
              <h1 class="case-title">All done</h1>
              <p class="muted">Every case in this session has a result{{ queue.pending() ? '; uploads are still finishing' : '' }}.</p>
              <div><button class="btn btn-primary" type="button" (click)="end()">End session</button></div>
            </article>
          }
        </div>
      </div>
    }
  `,
  styles: `
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .session { display: flex; flex-direction: column; min-height: calc(100vh - 53px); }
    .bar { display: flex; align-items: center; gap: 12px; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 52px; z-index: 5; flex-wrap: wrap; }
    .spinner.inline { display: inline-block; width: 12px; height: 12px; vertical-align: -1px; }
    .body { display: grid; grid-template-columns: 260px minmax(0, 1fr); flex: 1; }
    @media (max-width: 860px) { .body { grid-template-columns: 1fr; } .list { display: none; } }
    .list { border-right: 1px solid var(--border); padding: 8px; overflow: auto; }
    .list ol { list-style: none; margin: 0; padding: 0; }
    .list button { display: flex; gap: 8px; width: 100%; text-align: left; border: none; background: none; color: inherit; font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .list button.on { background: var(--accent-soft); }
    .state { width: 16px; flex: none; }
    .main { padding: 24px 32px 48px; max-width: 980px; display: flex; flex-direction: column; gap: 16px; }
    .case-title { font-size: 28px; }
    .pre { font-size: 17px; }
    .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .steps li { display: flex; gap: 14px; align-items: flex-start; font-size: 21px; line-height: 1.45; padding: 10px 14px; border-radius: 10px; cursor: pointer; border: 2px solid transparent; }
    .steps li.next { border-color: var(--accent); background: var(--accent-soft); }
    .steps li.done { color: var(--text-2); }
    .steps li.done .kw { color: var(--text-2); }
    .box { width: 26px; height: 26px; flex: none; border: 2px solid var(--border-strong); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 16px; margin-top: 3px; }
    .steps li.done .box { background: var(--good); border-color: var(--good); color: #fff; }
    .kw { font-weight: 700; color: var(--accent); }
    .actions { gap: 10px; }
    .res { height: 48px; padding: 0 22px; font-size: 16px; font-weight: 700; }
    .res.pass { background: var(--good); border-color: var(--good); color: #fff; }
    .res.fail { background: var(--bad); border-color: var(--bad); color: #fff; }
    .res.blocked { background: var(--warn); border-color: var(--warn); color: #fff; }
    .res .kbd { color: #fff; border-color: rgb(255 255 255 / 0.6); }
    .mono { font-family: var(--mono); font-size: 12.5px; }
    .warn-text { color: var(--warn); }
  `,
})
export class SessionPage {
  protected readonly ws = inject(Workspace);
  protected readonly features = inject(FeatureSelection);
  protected readonly queue = inject(RunQueue);
  private readonly store = inject(CasesStore);
  private readonly session = inject(Session);

  protected readonly names = PLATFORM_NAMES;
  protected readonly setup = signal<SessionSetup | null>(load());
  protected readonly includeOthers = signal(false);
  protected readonly index = signal(0);
  protected readonly ticked = signal<Set<number>>(new Set());
  protected readonly notes = signal('');
  protected readonly files = signal<File[]>([]);
  protected readonly hint = signal<string | null>(null);
  /** Results recorded in this session, by case number. */
  private readonly results = signal<Record<number, RunResult>>({});

  protected readonly bugFor = signal<number | null>(null);
  protected readonly bugTitleText = signal('');
  protected readonly bugText = signal('');
  protected readonly bugBusy = signal(false);
  protected readonly bugError = signal<string | null>(null);

  private readonly me = computed(() => this.session.viewer()?.login ?? '');
  /** The platforms the user works on (all, if they aren't on either). */
  protected readonly platforms: Platform[] = (() => {
    const config = this.ws.config();
    const me = this.session.viewer()?.login ?? '';
    const mine = (['android', 'ios'] as const).filter((p) => !!config && includesLogin(config.team[p], me));
    return mine.length ? [...mine] : ['android', 'ios'];
  })();

  protected readonly form = {
    platform: signal<Platform>('android'),
    appVersion: signal(''),
    build: signal(''),
    device: signal(''),
    os: signal(''),
    env: signal<Environment>('staging'),
  };

  /** Approved cases on the platform, assigned to me (unless widened), not yet passed on it. */
  protected readonly candidates = computed(() => {
    const p = this.form.platform();
    const config = this.ws.config();
    return this.store
      .openCases()
      .filter((c) => canRun(c) && c.platforms.includes(p))
      .filter((c) => !c.labels.includes(`run:${p}:passed`))
      .filter(
        (c) =>
          this.includeOthers() ||
          c.assignees.some((a) => a.login.toLowerCase() === this.me().toLowerCase()) ||
          (!c.assignees.some((a) => config && includesLogin(config.team[p], a.login))),
      );
  });

  protected readonly sessionCases = computed(() => {
    const s = this.setup();
    if (!s) return [];
    return s.cases.map((n) => this.store.byNumber(n)).filter((c): c is TestCase => !!c);
  });
  protected readonly current = computed(() => this.sessionCases()[this.index()] ?? null);
  protected readonly doneCount = computed(() => Object.keys(this.results()).length);
  protected readonly nextStep = computed(() => {
    const steps = this.current()?.steps ?? [];
    const i = steps.findIndex((_, j) => !this.ticked().has(j));
    return i;
  });

  /** The previous failed or blocked run of the current case on this platform (UX 8). */
  protected readonly lastRun = signal<RunEvent | null>(null);
  protected readonly ago = (iso: string) => timeAgo(iso);

  constructor() {
    this.pickPlatform(this.platforms[0]);
    effect(() => {
      const tc = this.current();
      const platform = this.setup()?.platform;
      untracked(() => {
        this.lastRun.set(null);
        if (!tc || !platform || !tc.labels.some((l) => l === `run:${platform}:failed` || l === `run:${platform}:blocked`)) return;
        void this.store.detail(tc.number).then(({ comments }) => {
          if (this.current()?.number !== tc.number) return;
          const last = runsOf(comments).filter((r) => r.platform === platform).at(-1) ?? null;
          this.lastRun.set(last && last.result !== 'pass' ? last : null);
        });
      });
    });
    // A fresh case starts with no ticks, notes or files.
    effect(() => {
      this.current();
      untracked(() => {
        this.ticked.set(new Set());
        this.notes.set('');
        this.files.set([]);
        this.hint.set(null);
      });
    });
  }

  protected pickPlatform(p: Platform): void {
    this.form.platform.set(p);
    const d = loadRunDefaults(p);
    this.form.appVersion.set(d.appVersion || this.features.settings()?.targetVersion || '');
    this.form.build.set(d.build);
    this.form.device.set(d.device);
    this.form.os.set(d.os);
    this.form.env.set(d.env);
  }

  protected start(): void {
    const s: SessionSetup = {
      platform: this.form.platform(),
      appVersion: this.form.appVersion().trim().replace(/^v/i, ''),
      build: this.form.build().trim(),
      device: this.form.device().trim(),
      os: this.form.os().trim(),
      env: this.form.env(),
      cases: this.candidates().map((c) => c.number),
    };
    saveRunDefaults(s.platform, { appVersion: s.appVersion, build: s.build, device: s.device, os: s.os, env: s.env });
    sessionStorage.setItem(KEY, JSON.stringify(s));
    this.results.set({});
    this.index.set(0);
    this.setup.set(s);
  }

  protected end(): void {
    if (this.queue.pending() && !confirm('Uploads are still running. End the session anyway? They keep going in the background.')) return;
    sessionStorage.removeItem(KEY);
    this.setup.set(null);
  }

  protected go(i: number): void {
    if (i >= 0 && i < this.sessionCases().length) this.index.set(i);
  }

  protected toggleTick(i: number): void {
    this.ticked.update((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  protected stateIcon(tc: TestCase): string {
    const job = this.queue.latestFor(tc.number);
    if (job?.status === 'error') return '⚠';
    const r = this.results()[tc.number];
    return r === 'pass' ? '✅' : r === 'fail' ? '❌' : r === 'blocked' ? '⛔' : '○';
  }

  protected stateLabel(tc: TestCase): string {
    const r = this.results()[tc.number];
    return r ? `Recorded: ${r}` : 'Not run yet';
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (!this.setup() || this.bugFor() !== null || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; // let buttons click
    const k = e.key.toLowerCase();
    if (k === 'p' || k === 'f' || k === 'b') {
      e.preventDefault();
      this.record(k === 'p' ? 'pass' : k === 'f' ? 'fail' : 'blocked');
    } else if (k === 'j') {
      e.preventDefault();
      this.go(this.index() + 1);
    } else if (k === 'k') {
      e.preventDefault();
      this.go(this.index() - 1);
    } else if (e.key === ' ') {
      e.preventDefault();
      const n = this.nextStep();
      if (n >= 0) this.toggleTick(n);
    }
  }

  protected record(result: RunResult): void {
    const tc = this.current();
    const s = this.setup();
    if (!tc || !s) return;
    if (result !== 'pass' && !this.notes().trim()) {
      this.hint.set(`Add a note saying why it ${result === 'fail' ? 'failed' : 'is blocked'}, then press ${result === 'fail' ? 'F' : 'B'} again.`);
      return;
    }
    const meta: RunMeta = {
      platform: s.platform,
      result,
      appVersion: s.appVersion,
      build: s.build,
      device: s.device,
      os: s.os,
      env: s.env,
      executedAt: new Date().toISOString(),
    };
    this.queue.enqueue(tc.number, meta, this.notes(), this.files());
    this.results.update((r) => ({ ...r, [tc.number]: result }));
    if (result === 'fail') {
      // TS-6: offer the bug right here, before moving on.
      this.bugTitleText.set(bugTitle(tc, s.platform));
      this.bugText.set(bugBody(tc, meta, this.notes(), [], this.ws.repo()?.nameWithOwner ?? ''));
      this.bugError.set(null);
      this.bugFor.set(tc.number);
      return;
    }
    this.advance();
  }

  protected async fileBug(tc: TestCase): Promise<void> {
    this.bugBusy.set(true);
    this.bugError.set(null);
    try {
      await this.store.fileBug(tc, this.setup()!.platform, this.bugTitleText().trim(), this.bugText());
      this.bugFor.set(null);
      this.advance();
    } catch (e) {
      this.bugError.set(asGitHubError(e).message);
    } finally {
      this.bugBusy.set(false);
    }
  }

  /** Next case without a result, or past the end ("All done"). */
  protected advance(): void {
    const cases = this.sessionCases();
    const results = this.results();
    const after = cases.findIndex((c, i) => i > this.index() && !results[c.number]);
    const any = cases.findIndex((c) => !results[c.number]);
    this.index.set(after >= 0 ? after : any >= 0 ? any : cases.length);
  }
}

function load(): SessionSetup | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    return v && Array.isArray(v.cases) ? (v as SessionSetup) : null;
  } catch {
    return null;
  }
}

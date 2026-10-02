import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Workspace, asGitHubError } from '../../core/workspace';
import { Session } from '../../core/session';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { Platform, includesLogin } from '../../core/config/team-config';
import { PLATFORM_NAMES, TestCase } from '../../core/testcase/model';
import { Environment, RESULT_LABELS, RunEvent, RunResult } from '../../core/testcase/runs';
import { loadRunDefaults, saveRunDefaults } from '../../core/testcase/run-defaults';
import { prepareFiles } from '../../core/evidence/prepare';
import { bugBody, bugTitle } from '../../core/testcase/bug-report';
import { EvidencePicker } from './evidence-picker';
import { Toasts } from '../../core/toast';

/** Record a run with metadata and evidence (EX-1 to EX-5); offer a bug on Fail (EX-6). */
@Component({
  selector: 'app-run-form',
  imports: [EvidencePicker],
  template: `
    @if (!bug()) {
      <form class="stack" (submit)="$event.preventDefault(); submit()">
        <div class="row wrap gap">
          <label class="field small">
            Platform
            <select (change)="setPlatform($any($event.target).value)" [disabled]="busy()">
              @for (p of tc().platforms; track p) {
                <option [value]="p" [selected]="p === platform()">{{ names[p] }}</option>
              }
            </select>
          </label>
          <fieldset class="small">
            <legend>Result</legend>
            <div class="seg" role="radiogroup" aria-label="Result">
              @for (r of results; track r) {
                <button type="button" role="radio" [attr.aria-checked]="result() === r" [class]="'r-' + r" [class.on]="result() === r" (click)="result.set(r)">
                  {{ resultLabels[r] }}
                </button>
              }
            </div>
          </fieldset>
        </div>

        <div class="grid">
          <label class="field small">
            App version
            <input type="text" [value]="appVersion()" (input)="appVersion.set($any($event.target).value)" [placeholder]="target() ?? '4.12.0'" required />
          </label>
          <label class="field small">
            Build number
            <input type="text" [value]="build()" (input)="build.set($any($event.target).value)" placeholder="41207" />
          </label>
          <label class="field small">
            Device
            <input type="text" [value]="device()" (input)="device.set($any($event.target).value)" [placeholder]="platform() === 'ios' ? 'iPhone 15' : 'Pixel 8'" />
          </label>
          <label class="field small">
            OS version
            <input type="text" [value]="os()" (input)="os.set($any($event.target).value)" [placeholder]="platform() === 'ios' ? 'iOS 18.1' : 'Android 15'" />
          </label>
          <label class="field small">
            Environment
            <select (change)="env.set($any($event.target).value)">
              <option value="staging" [selected]="env() === 'staging'">Staging</option>
              <option value="production" [selected]="env() === 'production'">Production</option>
            </select>
          </label>
          <label class="field small">
            Run at
            <input type="datetime-local" [value]="executedAt()" (input)="executedAt.set($any($event.target).value)" />
          </label>
        </div>

        @if (versionMismatch()) {
          <div class="banner banner-warn small">
            The feature's target version is {{ target() }}. A run on {{ appVersion() }} is kept but doesn't count toward readiness.
          </div>
        }

        <label class="field small">
          Notes {{ result() === 'pass' ? '(optional)' : '(what went wrong?)' }}
          <textarea rows="2" [value]="notes()" (input)="notes.set($any($event.target).value)"></textarea>
        </label>

        <app-evidence-picker [(files)]="files" />

        @if (problems().length) {
          <div class="banner banner-warn small">
            <ul>@for (p of problems(); track p) { <li>{{ p }}</li> }</ul>
          </div>
        }
        @if (error()) {
          <div class="banner banner-bad small" role="alert">{{ error() }}</div>
        }

        <div class="row">
          <button class="btn btn-primary" type="submit" [disabled]="busy() || !appVersion().trim()">
            @if (busy()) { <span class="spinner" aria-hidden="true"></span> {{ stage() }} } @else { Record {{ resultLabels[result()].toLowerCase() }} run }
          </button>
          <button class="btn" type="button" (click)="cancelled.emit()" [disabled]="busy()">Cancel</button>
          <span class="muted small">Recorded as {{ me() }}.</span>
        </div>
      </form>
    } @else {
      <form class="stack" (submit)="$event.preventDefault(); fileBug()">
        <div class="banner banner-bad small">The run was recorded as {{ resultLabels[result()].toLowerCase() }}. File a bug for it?</div>
        <label class="field small">
          Bug title
          <input type="text" [value]="bugTitle()" (input)="bugTitle.set($any($event.target).value)" />
        </label>
        <label class="field small">
          Description <span class="muted">(prefilled from the run; edit freely)</span>
          <textarea rows="10" class="mono" [value]="bugText()" (input)="bugText.set($any($event.target).value)"></textarea>
        </label>
        <p class="muted small">Filed in {{ bugRepo() }}.</p>
        @if (error()) {
          <div class="banner banner-bad small" role="alert">{{ error() }}</div>
        }
        <div class="row">
          <button class="btn btn-primary" type="submit" [disabled]="busy() || !bugTitle().trim()">
            @if (busy()) { <span class="spinner" aria-hidden="true"></span> } File bug
          </button>
          <button class="btn" type="button" (click)="done.emit()" [disabled]="busy()">Skip</button>
        </div>
      </form>
    }
  `,
  styles: `
    .wrap { flex-wrap: wrap; }
    .gap { gap: 16px; align-items: flex-end; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
    fieldset { border: none; margin: 0; padding: 0; }
    legend { font-weight: 500; margin-bottom: 6px; padding: 0; }
    select { width: auto; min-width: 120px; }
    .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
    .seg button { border: none; background: var(--surface); color: var(--text-2); font: inherit; font-weight: 600; padding: 0 14px; height: 34px; cursor: pointer; }
    .seg button + button { border-left: 1px solid var(--border); }
    .seg .r-pass.on { background: var(--good); color: #fff; }
    .seg .r-fail.on { background: var(--bad); color: #fff; }
    .seg .r-blocked.on { background: var(--warn); color: #fff; }
    .mono { font-family: var(--mono); font-size: 12.5px; }
  `,
})
export class RunForm {
  private readonly store = inject(CasesStore);
  private readonly ws = inject(Workspace);
  private readonly session = inject(Session);
  private readonly features = inject(FeatureSelection);
  private readonly toasts = inject(Toasts);

  readonly tc = input.required<TestCase>();
  /** Platform to start on; defaults to the user's own. */
  readonly platform$ = input<Platform | null>(null, { alias: 'platform' });
  /** The viewer's last run on this platform; fills device and OS when this browser has none saved. */
  readonly previous = input<RunEvent | null>(null);
  readonly recorded = output<RunEvent | null>();
  readonly done = output<void>();
  readonly cancelled = output<void>();

  protected readonly names = PLATFORM_NAMES;
  protected readonly results: RunResult[] = ['pass', 'fail', 'blocked'];
  protected readonly resultLabels = RESULT_LABELS;

  protected readonly platform = signal<Platform>('android');
  protected readonly result = signal<RunResult>('pass');
  protected readonly appVersion = signal('');
  protected readonly build = signal('');
  protected readonly device = signal('');
  protected readonly os = signal('');
  protected readonly env = signal<Environment>('staging');
  protected readonly executedAt = signal(localNow());
  protected readonly notes = signal('');
  protected readonly files = signal<File[]>([]);
  protected readonly busy = signal(false);
  protected readonly stage = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<string[]>([]);

  protected readonly bug = signal(false);
  protected readonly bugTitle = signal('');
  protected readonly bugText = signal('');

  protected readonly me = computed(() => this.session.viewer()?.login ?? '');
  protected readonly target = computed(() => this.features.settings()?.targetVersion ?? null);
  protected readonly versionMismatch = computed(() => {
    const t = this.target();
    const v = this.appVersion().trim().replace(/^v/i, '');
    return !!t && !!v && v !== t.replace(/^v/i, '');
  });
  protected readonly bugRepo = computed(() => this.ws.config()?.bugs.repo ?? this.ws.repo()?.nameWithOwner ?? '');

  constructor() {
    // Default to the platform the user works on, then fill in what they used last time.
    effect(() => {
      const tc = this.tc();
      this.platform$();
      untracked(() => {
        const config = this.ws.config();
        const mine = tc.platforms.find((p) => config && includesLogin(config.team[p], this.me()));
        this.setPlatform(this.platform$() ?? mine ?? tc.platforms[0] ?? 'android');
      });
    });
  }

  protected setPlatform(p: Platform): void {
    this.platform.set(p);
    const d = loadRunDefaults(p);
    const prev = this.previous()?.platform === p ? this.previous() : null;
    this.appVersion.set(d.appVersion || this.target() || '');
    this.build.set(d.build);
    this.device.set(d.device || prev?.device || '');
    this.os.set(d.os || prev?.os || '');
    this.env.set(d.device ? d.env : (prev?.env ?? d.env));
  }

  protected async submit(): Promise<void> {
    const tc = this.tc();
    this.busy.set(true);
    this.error.set(null);
    this.problems.set([]);
    try {
      const at = new Date(this.executedAt());
      const prepared = await prepareFiles(this.files(), tc.number, this.platform(), at);
      if (prepared.rejected.length) {
        this.problems.set(prepared.rejected);
        return;
      }
      this.problems.set(prepared.warnings);
      const meta = {
        platform: this.platform(),
        result: this.result(),
        appVersion: this.appVersion().trim().replace(/^v/i, ''),
        build: this.build().trim(),
        device: this.device().trim(),
        os: this.os().trim(),
        env: this.env(),
        executedAt: at.toISOString(),
      };
      saveRunDefaults(meta.platform, { appVersion: meta.appVersion, build: meta.build, device: meta.device, os: meta.os, env: meta.env });
      const { run } = await this.store.recordRun(tc, meta, this.notes(), prepared.uploads, (s) => this.stage.set(s));
      this.recorded.emit(run);
      this.toasts.show(`${RESULT_LABELS[meta.result]} run recorded on ${PLATFORM_NAMES[meta.platform]}.`);
      if (meta.result === 'pass') {
        this.done.emit();
      } else {
        this.bugTitle.set(bugTitle(tc, meta.platform));
        this.bugText.set(bugBody(tc, meta, this.notes(), run?.evidence ?? [], this.ws.repo()?.nameWithOwner ?? ''));
        this.bug.set(true);
      }
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async fileBug(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const link = await this.store.fileBug(this.tc(), this.platform(), this.bugTitle().trim(), this.bugText());
      this.toasts.show(`Bug filed: ${link.issue}.`, 'good', { url: link.url, label: 'Open' });
      this.done.emit();
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}

/** "2026-10-14T10:32" in local time, for datetime-local inputs. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

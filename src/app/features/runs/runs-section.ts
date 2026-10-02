import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Workspace } from '../../core/workspace';
import { FeatureSelection } from '../../core/feature-selection';
import { CommentNode } from '../../core/github/api';
import { Platform, includesLogin, sameLogin } from '../../core/config/team-config';
import { Session } from '../../core/session';
import { PLATFORM_NAMES, TestCase } from '../../core/testcase/model';
import { RESULT_LABELS, RunEvent, bugsOf, canRun, latestRuns, runsOf, sameVersion } from '../../core/testcase/runs';
import { historyOf } from '../../core/testcase/review';
import { githubAttachments } from '../../core/evidence/evidence';
import { parseMarker } from '../../core/testcase/comments';
import { timeAgo } from '../../core/time';
import { EvidenceThumb } from './evidence-thumb';
import { RunForm } from './run-form';

/** Results per platform, run history with evidence, bugs and GitHub attachments (5.5). */
@Component({
  selector: 'app-runs-section',
  imports: [EvidenceThumb, RunForm],
  template: `
    <section class="stack" aria-labelledby="runs-h">
      <h2 class="h-small" id="runs-h">Runs @if (target(); as t) { <span class="ver">on v{{ t }}</span> }</h2>

      <div class="results">
        @for (p of tc().platforms; track p) {
          <div [class]="'result card res-' + (latest()[p]?.result ?? 'none')">
            <div class="small muted">{{ names[p] }}</div>
            @if (latest()[p]; as r) {
              <div class="big">{{ resultLabels[r.result] }}</div>
              <div class="small">v{{ r.appVersion }}{{ r.build ? ' (' + r.build + ')' : '' }} · {{ r.device || 'device not given' }}</div>
              <div class="small muted">{{ r.author }} · {{ ago(r.executedAt) }}</div>
            } @else {
              <div class="big muted">Not run</div>
              <div class="small muted">{{ target() ? 'No run on v' + target() + ' yet' : 'No run yet' }}</div>
            }
            @if (runnable() && formPlatform() !== p) {
              @switch (latest()[p]?.result) {
                @case ('pass') {
                  <button class="btn btn-link small card-action" type="button" (click)="openFor(p)">Run again</button>
                }
                @case (undefined) {
                  <button class="btn small card-action" [class.btn-primary]="mine(p)" type="button" (click)="openFor(p)">Record {{ names[p] }} run</button>
                }
                @default {
                  <button class="btn small card-action" [class.btn-primary]="mine(p)" type="button" (click)="openFor(p)">Re-run on {{ names[p] }}</button>
                }
              }
            }
          </div>
        }
      </div>

      @if (formPlatform(); as fp) {
        <div class="card" id="run-form">
          <app-run-form
            [tc]="tc()"
            [platform]="fp"
            [previous]="previousRun(fp)"
            (recorded)="changed.emit()"
            (done)="formPlatform.set(null); changed.emit()"
            (cancelled)="formPlatform.set(null)"
          />
        </div>
      }

      @if (runs().length) {
        <ol class="history">
          @for (r of runsNewestFirst(); track r.id) {
            <li [class.dim]="!counts(r)">
              <div class="row wrap small">
                <span [class]="'badge res-badge-' + r.result">{{ resultLabels[r.result] }}</span>
                <strong>{{ names[r.platform] }}</strong>
                <span>v{{ r.appVersion }}{{ r.build ? ' (' + r.build + ')' : '' }}</span>
                <span class="muted">{{ [r.device, r.os].filter(nonEmpty).join(', ') }} · {{ r.env }}</span>
                <span class="muted">· {{ r.author }} · {{ ago(r.executedAt) }}</span>
                @if (!counts(r)) {
                  <span class="badge badge-outline">{{ whyNotCounted(r) }}</span>
                }
                <a class="muted" [href]="r.url" target="_blank" rel="noopener">view</a>
              </div>
              @if (r.notes) {
                <p class="small notes">{{ r.notes }}</p>
              }
              @if (r.evidence.length) {
                <div class="thumbs">
                  @for (e of r.evidence; track e.path) {
                    <app-evidence-thumb [ref]="e" />
                  }
                </div>
              }
            </li>
          }
        </ol>
      }

      @if (bugs().length) {
        <div class="small">
          <strong>Bugs filed:</strong>&nbsp;
          @for (b of bugs(); track b.url) {
            <a [href]="b.url" target="_blank" rel="noopener">{{ b.issue }}</a>{{ b.platform ? ' (' + names[b.platform] + ')' : '' }}&nbsp;
          }
        </div>
      }

      @if (attachments().length) {
        <div class="small stack" style="gap: 4px">
          <strong>Attached on GitHub</strong>
          <span class="muted">These were added in GitHub's own editor; open them there.</span>
          <ul class="attach">
            @for (a of attachments(); track a.url) {
              <li><a [href]="a.url" target="_blank" rel="noopener">{{ a.name }}</a> <span class="muted">· {{ a.author }}</span></li>
            }
          </ul>
        </div>
      }
    </section>
  `,
  styles: `
    .h-small { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); }
    .ver { text-transform: none; letter-spacing: 0; font-weight: 500; }
    .results { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
    .result { padding: 12px 14px; border-left-width: 4px; display: flex; flex-direction: column; gap: 2px; }
    .card-action { align-self: flex-start; margin-top: 8px; }
    .res-pass { border-left-color: var(--good); }
    .res-fail { border-left-color: var(--bad); }
    .res-blocked { border-left-color: var(--warn); }
    .big { font-size: 18px; font-weight: 700; }
    .history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
    .history li { padding-left: 10px; border-left: 3px solid var(--border); }
    .history li.dim { opacity: 0.6; }
    .wrap { flex-wrap: wrap; }
    .res-badge-pass { background: var(--good-soft); color: var(--good); }
    .res-badge-fail { background: var(--bad-soft); color: var(--bad); }
    .res-badge-blocked { background: var(--warn-soft); color: var(--warn); }
    .notes { white-space: pre-wrap; margin-top: 4px; }
    .thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .attach { margin: 0; padding-left: 18px; }
  `,
})
export class RunsSection {
  private readonly ws = inject(Workspace);
  private readonly features = inject(FeatureSelection);
  private readonly session = inject(Session);

  readonly tc = input.required<TestCase>();
  readonly comments = input<CommentNode[]>([]);
  readonly changed = output<void>();

  protected readonly names = PLATFORM_NAMES;
  protected readonly resultLabels = RESULT_LABELS;
  /** The platform whose run form is open, if any. */
  protected readonly formPlatform = signal<Platform | null>(null);

  /** Opens the run form for a platform and brings it into view. */
  openFor(p: Platform): void {
    this.formPlatform.set(p);
    setTimeout(() => document.getElementById('run-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  protected readonly ago = (iso: string) => timeAgo(iso);
  protected readonly nonEmpty = (s: string) => !!s;

  protected readonly target = computed(() => this.features.settings()?.targetVersion ?? null);
  protected readonly runs = computed(() => runsOf(this.comments()));
  protected readonly runsNewestFirst = computed(() => [...this.runs()].reverse());
  private readonly since = computed(() => historyOf(this.comments()).versionStart);
  protected readonly latest = computed<Partial<Record<Platform, RunEvent>>>(() =>
    latestRuns(this.runs(), this.tc().platforms, this.target(), this.since()),
  );
  protected readonly bugs = computed(() => bugsOf(this.comments()));
  protected readonly attachments = computed(() =>
    this.comments()
      .filter((c) => !parseMarker(c.body))
      .flatMap((c) => githubAttachments(c.body).map((a) => ({ ...a, author: c.author?.login ?? 'ghost' }))),
  );
  protected readonly runnable = computed(() => canRun(this.tc()) && this.ws.canWriteRepo() && !this.ws.isViewerOnly());

  /** Only the viewer's own platforms get a primary button; others can still record. */
  protected mine(p: Platform): boolean {
    const me = this.session.viewer()?.login ?? '';
    return includesLogin(this.ws.config()?.team[p] ?? [], me);
  }

  /** The viewer's own latest run on a platform, to prefill device and OS. */
  protected previousRun(p: Platform): RunEvent | null {
    const me = this.session.viewer()?.login ?? '';
    return this.runs().filter((r) => r.platform === p && sameLogin(r.author, me)).at(-1) ?? null;
  }

  protected counts(r: RunEvent): boolean {
    return Object.values(this.latest()).some((l) => l?.id === r.id);
  }

  protected whyNotCounted(r: RunEvent): string {
    const t = this.target();
    if (t && !sameVersion(r.appVersion, t)) return 'other version';
    const since = this.since();
    if (since && r.postedAt < since) return 'before the latest edit';
    return 'superseded';
  }
}

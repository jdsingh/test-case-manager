import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Workspace, asGitHubError } from '../../core/workspace';
import { Session } from '../../core/session';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { CommentNode } from '../../core/github/api';
import { TestCase } from '../../core/testcase/model';
import { historyOf } from '../../core/testcase/review';
import { timeAgo } from '../../core/time';
import { includesLogin, sameLogin } from '../../core/config/team-config';
import { PlatformBadges, PriorityBadge } from '../cases/badges';
import { StepNotes } from './step-notes';
import { ReviewPanel } from './review-panel';

/** Review mode: work through the cases waiting for you (RV-1) with A / R / J / K (LR-3). */
@Component({
  selector: 'app-review-page',
  imports: [RouterLink, PriorityBadge, PlatformBadges, StepNotes, ReviewPanel],
  template: `
    <main class="page stack">
      <div class="row">
        <div class="stack" style="gap: 2px">
          <h1>Review</h1>
          <span class="muted small">
            {{ queue().length }} waiting in {{ features.project()?.title ?? 'this feature' }}
            · <span class="kbd">A</span> approve · <span class="kbd">R</span> request changes · <span class="kbd">J</span>/<span class="kbd">K</span> next / previous
          </span>
        </div>
      </div>

      @if (lastDone(); as d) {
        <div class="banner banner-good" role="status">{{ d }}</div>
      }

      @if (store.load().status === 'loading') {
        <div class="row muted"><span class="spinner" aria-hidden="true"></span> Loading…</div>
      } @else if (!eligibleToReview()) {
        <section class="card stack">
          <h2>Reviews are done by mobile engineers</h2>
          <p class="muted">You're not listed as an Android or iOS engineer, so there's nothing for you to review here.</p>
        </section>
      } @else if (!queue().length) {
        <section class="card stack">
          <h2>Nothing to review</h2>
          <p class="muted">No test cases in this feature are waiting for your review. Nice.</p>
          <div><a class="btn" routerLink="../inbox" queryParamsHandling="preserve">Go to your inbox</a></div>
        </section>
      } @else {
        <div class="layout">
          <nav class="queue card" aria-label="Review queue">
            <ol>
              @for (tc of queue(); track tc.number; let i = $index) {
                <li>
                  <button type="button" [class.on]="tc.number === current()?.number" (click)="select(tc.number)">
                    <span class="row small">
                      <app-priority [value]="tc.priority" />
                      <span class="muted">#{{ tc.number }}</span>
                      @if (assignedToMe(tc)) {
                        <span class="mine">assigned to you</span>
                      } @else if (tc.assignees.length) {
                        <span class="muted small">assigned to {{ assigneeNames(tc) }}</span>
                      }
                    </span>
                    <span class="t">{{ tc.title }}</span>
                  </button>
                </li>
              }
            </ol>
          </nav>

          @if (current(); as tc) {
            <article class="stack" [attr.aria-label]="'Test case ' + tc.number">
              <div class="stack" style="gap: 6px">
                <h2 class="title">
                  <a [routerLink]="['../cases', tc.number]" queryParamsHandling="preserve">#{{ tc.number }}</a> {{ tc.title }}
                </h2>
                <div class="row">
                  <app-priority [value]="tc.priority" />
                  <app-platforms [value]="tc.platforms" />
                  @if (tc.regression) {
                    <span class="badge badge-outline">regression</span>
                  }
                  <span class="muted small">by {{ tc.author ?? 'unknown' }}</span>
                </div>
              </div>
              @if (tc.preconditions) {
                <p><span class="muted small">Preconditions:</span> {{ tc.preconditions }}</p>
              }
              @if (lastAsk(); as ask) {
                <div class="banner small" role="note">
                  <div>
                    <strong>Last round, {{ ask.author }} asked for changes:</strong> {{ ask.note || '(no comment)' }}
                    <div class="muted">Check that this version addresses it.</div>
                  </div>
                </div>
              }
              @if (earlier().length) {
                <details class="small">
                  <summary>Earlier reviews ({{ earlier().length }})</summary>
                  <ul class="earlier">
                    @for (r of earlier(); track r.id) {
                      <li>
                        <strong>{{ r.author }}</strong>
                        {{ r.decision === 'approve' ? 'approved' : 'requested changes' }}
                        <span class="muted">· {{ ago(r.createdAt) }}</span>
                        @if (r.note) { <div class="muted">{{ r.note }}</div> }
                      </li>
                    }
                  </ul>
                </details>
              }
              @if (loadingDetail()) {
                <div class="row muted small"><span class="spinner" aria-hidden="true"></span> Loading comments…</div>
              }
              <app-step-notes [tc]="tc" [notes]="history().lineNotes" [canAccept]="false" (changed)="loadDetail(tc.number)" />
              <p class="muted small">Hover a step and click 💬 to comment on it or suggest new wording.</p>
              <!-- Always mounted, so a background reload never throws away a half-written review. -->
              <app-review-panel
                [tc]="tc"
                [history]="history()"
                [shortcuts]="!loadingDetail()"
                [showReason]="commentsFor() === tc.number"
                (decided)="afterDecision(tc, $event)"
              />
              @if (error()) {
                <div class="banner banner-bad" role="alert">{{ error() }}</div>
              }
            </article>
          }
        </div>
      }
    </main>
  `,
  styles: `
    .layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 24px; align-items: start; }
    @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
    .queue { padding: 6px; position: sticky; top: 72px; max-height: calc(100vh - 100px); overflow: auto; }
    .queue ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .queue button { width: 100%; text-align: left; border: none; background: none; color: inherit; font: inherit; padding: 8px 10px; border-radius: 6px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
    .queue button:hover { background: var(--surface-2); }
    .queue button.on { background: var(--accent-soft); }
    .t { font-weight: 500; }
    .mine { color: var(--accent); font-size: 11.5px; }
    .title a { color: var(--text-2); text-decoration: none; }
    .earlier { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
  `,
})
export class ReviewPage {
  protected readonly ws = inject(Workspace);
  protected readonly features = inject(FeatureSelection);
  protected readonly store = inject(CasesStore);
  private readonly session = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly caseParam = toSignal(this.route.queryParamMap.pipe(map((q) => Number(q.get('case')) || null)), {
    requireSync: true,
  });
  private readonly comments = signal<CommentNode[]>([]);
  protected readonly commentsFor = signal<number | null>(null);
  protected readonly loadingDetail = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly lastDone = signal<string | null>(null);

  private readonly me = computed(() => this.session.viewer()?.login ?? '');

  protected readonly eligibleToReview = computed(() => {
    const config = this.ws.config();
    return !!config && (includesLogin(config.team.android, this.me()) || includesLogin(config.team.ios, this.me()));
  });

  /** In-review cases the user's platform covers; assigned-to-me first, then by priority. */
  protected readonly queue = computed(() => {
    const config = this.ws.config();
    if (!config) return [];
    return this.store
      .openCases()
      .filter((c) => c.status === 'in-review' && c.platforms.some((p) => includesLogin(config.team[p], this.me())))
      .sort(
        (a, b) =>
          Number(this.assignedToMe(b)) - Number(this.assignedToMe(a)) ||
          (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9') ||
          a.number - b.number,
      );
  });

  protected readonly current = computed<TestCase | null>(() => {
    const q = this.queue();
    return q.find((c) => c.number === this.caseParam()) ?? q[0] ?? null;
  });

  protected readonly history = computed(() =>
    historyOf(this.commentsFor() === this.current()?.number ? this.comments() : []),
  );

  /** Reviews of earlier versions of this case (RV-4), newest first (UX 11). */
  protected readonly earlier = computed(() => [...this.history().reviews].filter((r) => !r.current).reverse());
  protected readonly lastAsk = computed(() => this.earlier().find((r) => r.decision === 'request_changes') ?? null);
  protected readonly ago = (iso: string) => timeAgo(iso);

  constructor() {
    effect(() => {
      const n = this.current()?.number;
      untracked(() => {
        if (n && n !== this.commentsFor()) void this.loadDetail(n);
      });
    });
  }

  protected assigneeNames(tc: TestCase): string {
    return tc.assignees.map((a) => a.login).join(', ');
  }

  protected assignedToMe(tc: TestCase): boolean {
    return tc.assignees.some((a) => sameLogin(a.login, this.me()));
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      this.step(e.key === 'j' ? 1 : -1);
    }
  }

  protected select(n: number): void {
    this.lastDone.set(null);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { case: n }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected afterDecision(tc: TestCase, decision: 'approve' | 'request_changes'): void {
    const q = this.queue(); // already without the decided case
    const next = q.find((c) => c.number > tc.number) ?? q[0] ?? null;
    this.lastDone.set(
      `${decision === 'approve' ? 'Approved' : 'Requested changes on'} #${tc.number} ${tc.title}.${next ? '' : ' That was the last one.'}`,
    );
    if (next) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: { case: next.number }, queryParamsHandling: 'merge', replaceUrl: true });
    }
  }

  async loadDetail(n: number): Promise<void> {
    this.loadingDetail.set(true);
    this.error.set(null);
    try {
      const d = await this.store.detail(n);
      if (this.current()?.number === n) {
        this.comments.set(d.comments);
        this.commentsFor.set(n);
      }
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.loadingDetail.set(false);
    }
  }

  private step(delta: number): void {
    const q = this.queue();
    const i = q.findIndex((c) => c.number === this.current()?.number);
    const next = q[i + delta];
    if (next) this.select(next.number);
  }
}

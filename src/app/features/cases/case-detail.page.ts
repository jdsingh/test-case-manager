import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Workspace, asGitHubError } from '../../core/workspace';
import { CasesStore } from '../../core/testcase/cases-store';
import { CommentNode } from '../../core/github/api';
import { TestCase, draftOf } from '../../core/testcase/model';
import { TcmMarker, commentText, parseMarker } from '../../core/testcase/comments';
import { includesLogin } from '../../core/config/team-config';
import { timeAgo } from '../../core/time';
import { avatarAt } from '../../core/avatar';
import { Avatars, PlatformBadges, PriorityBadge, StatusBadge } from './badges';
import { StepNotes } from '../review/step-notes';
import { RunsSection } from '../runs/runs-section';
import { Stepper } from './stepper';
import { Toasts } from '../../core/toast';
import { canRun, runsOf } from '../../core/testcase/runs';
import { canReview } from '../../core/testcase/review';
import { ReviewPanel } from '../review/review-panel';
import { historyOf } from '../../core/testcase/review';
import { BankStore } from '../../core/testcase/bank-store';
import { copyInfo, isOutOfDate, visibleExtra } from '../../core/testcase/bank';
import { Session } from '../../core/session';
import { Platform, sameLogin } from '../../core/config/team-config';
import { PLATFORM_NAMES } from '../../core/testcase/model';

interface ActivityItem {
  id: string;
  url: string;
  author: string;
  avatarUrl: string;
  createdAt: string;
  marker: TcmMarker | null;
  stale: boolean;
  headline: string;
  rest: string;
}

/** One test case: scenario, state, actions and its review history. */
@Component({
  selector: 'app-case-detail-page',
  imports: [RouterLink, StepNotes, ReviewPanel, RunsSection, Stepper, PriorityBadge, StatusBadge, PlatformBadges, Avatars],
  template: `
    <main class="page stack">
      <a class="small back" routerLink=".." queryParamsHandling="preserve">← Test cases</a>

      @if (error()) {
        <div class="banner banner-bad" role="alert">{{ error() }}</div>
      }

      @if (tc(); as tc) {
        <header class="stack" style="gap: 10px">
          <h1><span class="muted">#{{ tc.number }}</span> {{ tc.title }}</h1>
          <div class="row wrap">
            <app-status [value]="tc.status" [closed]="tc.closed" />
            <app-priority [value]="tc.priority" />
            <app-platforms [value]="tc.platforms" />
            @if (tc.regression) {
              <span class="badge badge-outline">regression</span>
            }
            <span class="muted small sep">·</span>
            @if (tc.assignees.length) {
              <span class="row small">
                <app-avatars [people]="tc.assignees" />
                {{ assigneeNames(tc) }}
              </span>
            } @else {
              <span class="muted small">Unassigned</span>
            }
            <span class="muted small">· updated {{ ago(tc.updatedAt) }}</span>
          </div>
        </header>

        <app-stepper [tc]="tc" />

        @if (ws.canWriteRepo() && !ws.isViewerOnly()) {
          <div class="row wrap actions">
            @switch (next()?.kind) {
              @case ('submit') {
                <button class="btn btn-primary" type="button" (click)="openSubmit()" [disabled]="busy()">Submit for review</button>
              }
              @case ('fix') {
                <a class="btn btn-primary" routerLink="edit" queryParamsHandling="preserve">Edit and resubmit</a>
              }
              @case ('review') {
                <button class="btn btn-primary" type="button" (click)="scrollToReview()">Review this case</button>
              }
              @case ('run') {
                <button class="btn btn-primary" type="button" (click)="runs()?.openFor(next()!.platform!)">
                  {{ next()!.label }}
                </button>
              }
              @case ('reopen') {
                <button class="btn btn-primary" type="button" (click)="reopen(tc)" [disabled]="busy()">Reopen</button>
              }
            }
            @if (!tc.closed && next()?.kind !== 'fix') {
              <a class="btn" routerLink="edit" queryParamsHandling="preserve">Edit</a>
            }
            <details class="menu" #more (keydown.escape)="more.open = false">
              <summary class="btn">More <span aria-hidden="true">▾</span></summary>
              <div class="menu-list" role="menu" (click)="more.open = false">
                @if (tc.status === 'changes-requested' && !tc.closed) {
                  <button role="menuitem" type="button" (click)="openSubmit()">Resubmit without changes</button>
                }
                @if (!tc.closed) {
                  <button role="menuitem" type="button" (click)="duplicate(tc)">Duplicate</button>
                  @if (!copy()) {
                    <button role="menuitem" type="button" (click)="toggleRegression(tc)">
                      {{ tc.regression ? 'Remove from regression bank' : 'Add to regression bank' }}
                    </button>
                  }
                  <button role="menuitem" type="button" (click)="openAssign(tc)">Change assignees</button>
                  <button role="menuitem" type="button" class="danger" (click)="closeDialog.showModal()">Close as won't test</button>
                }
                <a role="menuitem" [href]="tc.url" target="_blank" rel="noopener">Open in GitHub ↗</a>
              </div>
            </details>
            @if (next()?.hint) {
              <span class="muted small">{{ next()!.hint }}</span>
            }
          </div>
        } @else {
          <div class="row actions"><a class="small" [href]="tc.url" target="_blank" rel="noopener">Open in GitHub</a></div>
        }

        @if (copy(); as cp) {
          <div [class]="outdatedSource() ? 'banner banner-warn' : 'banner'" role="status">
            <div>
              Copied from the regression bank:
              <a [routerLink]="['..', cp.source]" queryParamsHandling="preserve">#{{ cp.source }}</a>.
              @if (outdatedSource(); as src) {
                The original has changed since it was copied.
                @if (ws.canWriteRepo() && !tc.closed) {
                  <button class="btn btn-link" type="button" (click)="updateCopy(tc, src)" [disabled]="busy()">Update this copy</button>
                  <span class="muted small">(a scenario change, so it goes back to review)</span>
                }
              }
            </div>
          </div>
        }

        @if (tc.status === 'in-review') {
          <div id="review-panel">
            <app-review-panel [tc]="tc" [history]="history()" [showReason]="true" (decided)="onReviewed($event)" />
          </div>
        }

        @if (changeRequest(); as cr) {
          <div class="banner banner-bad" role="status">
            <div>
              <strong>{{ cr.author }} requested changes</strong>
              <span class="muted small"> · {{ ago(cr.createdAt) }}</span>
              @if (cr.rest) {
                <p class="cr">{{ cr.rest }}</p>
              }
              <p class="small muted">Edit the case to address this, then resubmit it for review.</p>
            </div>
          </div>
        }

        @if (!tc.parsed) {
          <div class="banner banner-warn">
            This issue isn't in the app's test case format yet, so its steps can't be shown. Edit it to add
            Given/When/Then steps; the existing text is kept below them.
          </div>
        }

        @if (tc.preconditions) {
          <section class="stack" style="gap: 4px">
            <h2 class="h-small">Preconditions</h2>
            <p>{{ tc.preconditions }}</p>
          </section>
        }
        @if (tc.steps.length) {
          <app-step-notes [tc]="tc" [notes]="history().lineNotes" [canAccept]="canAccept()" (changed)="reload()" />
        }
        @if (notesText()) {
          <section class="stack" style="gap: 4px">
            <h2 class="h-small">Notes</h2>
            <p class="notes">{{ notesText() }}</p>
          </section>
        }

        @if (showRuns()) {
          <app-runs-section [tc]="tc" [comments]="comments()" (changed)="reload()" />
        }

        <section class="stack" style="gap: 8px">
          <h2 class="h-small">Activity</h2>
          @if (activity().length) {
            <ol class="activity">
              @for (a of activity(); track a.id) {
                <li [class]="'act act-' + (a.marker?.kind ?? 'comment')">
                  <img class="avatar" [src]="sized(a.avatarUrl)" alt="" />
                  <div class="stack" style="gap: 2px">
                    <div class="small">
                      <strong>{{ a.author }}</strong>
                      <span class="muted"> · {{ ago(a.createdAt) }} · </span>
                      <a class="muted" [href]="a.url" target="_blank" rel="noopener">view</a>
                      @if (a.stale) {
                        <span class="badge badge-outline small stale">earlier version</span>
                      }
                    </div>
                    <div>{{ a.headline }}</div>
                    @if (a.rest) {
                      <div class="muted small rest">{{ a.rest }}</div>
                    }
                  </div>
                </li>
              }
            </ol>
          } @else {
            <p class="muted small">No activity yet.</p>
          }
        </section>

        <dialog #submitDialog aria-labelledby="submit-title" (close)="busy.set(false)">
          <form method="dialog" class="stack" (submit)="$event.preventDefault(); submit(tc)">
            <h2 id="submit-title">{{ tc.status === 'changes-requested' ? 'Resubmit for review' : 'Submit for review' }}</h2>
            <p class="muted small">
              Choose who reviews it. They're assigned to the issue and mentioned in a comment.
              {{ tc.platforms.length > 1 ? 'Any Android or iOS engineer can review a cross-platform case.' : '' }}
            </p>
            @if (eligible().length) {
              <fieldset class="people">
                <legend class="sr-only">Reviewers</legend>
                @for (login of eligible(); track login) {
                  <label class="row">
                    <input type="checkbox" [checked]="reviewers().includes(login)" (change)="toggleReviewer(login)" />
                    {{ login }}
                    @if (login === suggested()) {
                      <span class="muted small">suggested</span>
                    }
                  </label>
                }
              </fieldset>
            } @else {
              <div class="banner banner-warn small">
                Nobody on the team can review {{ tc.platforms.length ? 'this platform' : 'a case with no platform' }} yet.
                Add engineers in Team settings.
              </div>
            }
            <div class="row">
              <span class="spacer"></span>
              <button class="btn" type="button" (click)="submitDialog.close()">Cancel</button>
              <button class="btn btn-primary" type="submit" [disabled]="busy() || !reviewers().length">
                @if (busy()) { <span class="spinner" aria-hidden="true"></span> }
                Submit
              </button>
            </div>
          </form>
        </dialog>

        <dialog #assignDialog aria-labelledby="assign-title">
          <form method="dialog" class="stack" (submit)="$event.preventDefault(); saveAssign(tc)">
            <h2 id="assign-title">{{ assignTitle() }}</h2>
            @if (assignSlots().length) {
              @for (slot of assignSlots(); track slot.platform) {
                <label class="field small">
                  {{ slot.name }}
                  <select (change)="setSlot(slot.platform, $any($event.target).value)">
                    <option value="" [selected]="!slotPick()[slot.platform]">Nobody</option>
                    @for (login of slot.people; track login) {
                      <option [value]="login" [selected]="slotPick()[slot.platform] === login">{{ login }}</option>
                    }
                  </select>
                </label>
              }
            } @else {
              <fieldset class="people">
                <legend class="sr-only">Assignees</legend>
                @for (login of assignOptions(); track login) {
                  <label class="row">
                    <input type="checkbox" [checked]="assignPick().includes(login)" (change)="toggleAssign(login)" />
                    {{ login }}
                  </label>
                } @empty {
                  <p class="muted small">Nobody on the team fits this stage yet. Add people in Team settings.</p>
                }
              </fieldset>
            }
            <div class="row">
              <span class="spacer"></span>
              <button class="btn" type="button" (click)="assignDialog.close()">Cancel</button>
              <button class="btn btn-primary" type="submit" [disabled]="busy()">Save</button>
            </div>
          </form>
        </dialog>

        <dialog #closeDialog aria-labelledby="close-title">
          <form method="dialog" class="stack" (submit)="$event.preventDefault(); close(tc, reason.value)">
            <h2 id="close-title">Close as won't test</h2>
            <p class="muted small">The case drops out of the plan and the dashboard. You can reopen it later.</p>
            <label class="field small">
              Reason (optional)
              <textarea #reason placeholder="e.g. Feature cut from this release"></textarea>
            </label>
            <div class="row">
              <span class="spacer"></span>
              <button class="btn" type="button" (click)="closeDialog.close()">Cancel</button>
              <button class="btn btn-primary" type="submit" [disabled]="busy()">Close case</button>
            </div>
          </form>
        </dialog>
      } @else if (!error()) {
        <div class="row muted"><span class="spinner" aria-hidden="true"></span> Loading…</div>
      }
    </main>
  `,
  styles: `
    .back { text-decoration: none; }
    .wrap { flex-wrap: wrap; }
    .sep { margin: 0 2px; }
    .actions { padding: 10px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .menu { position: relative; }
    .menu > summary { list-style: none; }
    .menu > summary::-webkit-details-marker { display: none; }
    .menu-list { position: absolute; z-index: 6; top: 40px; left: 0; min-width: 230px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); display: flex; flex-direction: column; }
    .menu-list > button, .menu-list > a { text-align: left; border: none; background: none; color: var(--text); font: inherit; padding: 8px 10px; border-radius: 6px; cursor: pointer; text-decoration: none; }
    .menu-list > button:hover, .menu-list > a:hover { background: var(--surface-2); }
    .menu-list .danger { color: var(--bad); }
    .h-small { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); }
    .notes, .rest, .cr { white-space: pre-wrap; }
    .cr { margin-top: 4px; }
    .activity { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
    .act { display: flex; gap: 10px; align-items: flex-start; padding-left: 10px; border-left: 3px solid var(--border); }
    .act-review { border-left-color: var(--accent); }
    .act-submit { border-left-color: var(--warn); }
    .act-edit { border-left-color: var(--text-2); }
    .act .avatar { margin-top: 2px; }
    .stale { margin-left: 6px; }
    .people { border: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  `,
})
export class CaseDetailPage {
  protected readonly ws = inject(Workspace);
  private readonly store = inject(CasesStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly assignDialogRef = viewChild<ElementRef<HTMLDialogElement>>('assignDialog');
  private readonly submitDialog = viewChild<ElementRef<HTMLDialogElement>>('submitDialog');
  private readonly closeDialogRef = viewChild<ElementRef<HTMLDialogElement>>('closeDialog');

  private readonly number = toSignal(this.route.paramMap.pipe(map((p) => Number(p.get('number')))), {
    requireSync: true,
  });
  protected readonly comments = signal<CommentNode[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly reviewers = signal<string[]>([]);

  protected readonly tc = computed(() => this.store.byNumber(this.number()));
  protected readonly history = computed(() => historyOf(this.comments()));
  private readonly toasts = inject(Toasts);
  protected readonly runs = viewChild(RunsSection);

  protected readonly showRuns = computed(() => {
    const tc = this.tc();
    return !!tc && (canRun(tc) || runsOf(this.comments()).length > 0);
  });

  /**
   * The one thing this person should most likely do next (UX 4), from the case's state
   * and their role.
   */
  protected readonly next = computed<{ kind: 'submit' | 'fix' | 'review' | 'run' | 'reopen'; label?: string; platform?: Platform; hint?: string } | null>(() => {
    const tc = this.tc();
    const config = this.ws.config();
    const me = this.session.viewer()?.login ?? '';
    if (!tc || !this.ws.canWriteRepo()) return null;
    if (tc.closed) return { kind: 'reopen' };
    if (tc.status === 'draft' || tc.status === null) return { kind: 'submit' };
    if (tc.status === 'changes-requested') return { kind: 'fix', hint: 'Address the request below, then resubmit.' };
    if (tc.status === 'in-review') {
      const check = canReview(tc, this.history(), config, me);
      return check.ok ? { kind: 'review' } : null;
    }
    if (canRun(tc) && config) {
      const mine = tc.platforms.filter((p) => includesLogin(config.team[p], me));
      const todo = mine.find((p) => !tc.labels.includes(`run:${p}:passed`));
      if (todo) {
        const failed = tc.labels.some((l) => l === `run:${todo}:failed` || l === `run:${todo}:blocked`);
        return { kind: 'run', platform: todo, label: `${failed ? 'Re-run' : 'Record run'} on ${PLATFORM_NAMES[todo]}` };
      }
    }
    return null;
  });
  private readonly bank = inject(BankStore);
  protected readonly copy = computed(() => {
    const tc = this.tc();
    return tc ? copyInfo(tc) : null;
  });
  protected readonly outdatedSource = computed(() => {
    const tc = this.tc();
    return tc && this.copy() ? isOutOfDate(tc, this.bank.bankCases()) : null;
  });
  protected readonly notesText = computed(() => {
    const tc = this.tc();
    // The copy note is shown as the banner above; the rest are people's notes.
    return tc ? visibleExtra(tc.extraBody).replace(/^_Copied from the regression bank: #\d+\._$/m, '').trim() : '';
  });
  /** Suggestions are accepted by the PM or whoever wrote the case. */
  protected readonly canAccept = computed(() => {
    const me = this.session.viewer()?.login ?? '';
    const tc = this.tc();
    return this.ws.canWriteRepo() && (this.ws.roles().includes('pm') || (!!tc?.author && sameLogin(tc.author, me)));
  });

  // Manual assignment (AS-2): reviewers while in review, one runner per platform once approved.
  protected readonly assignPick = signal<string[]>([]);
  protected readonly slotPick = signal<Partial<Record<Platform, string>>>({});
  protected readonly assignSlots = computed(() => {
    const tc = this.tc();
    const config = this.ws.config();
    if (!tc || !config || !['approved', 'passed', 'failed', 'blocked'].includes(tc.status ?? '')) return [];
    return tc.platforms.map((p) => ({ platform: p, name: `Runs on ${PLATFORM_NAMES[p]}`, people: config.team[p] }));
  });
  protected readonly assignOptions = computed(() => {
    const tc = this.tc();
    const config = this.ws.config();
    if (!tc || !config) return [];
    if (tc.status === 'in-review') return this.store.eligibleReviewers(tc.platforms);
    const all = [...config.team.pm, ...config.team.techLead, ...config.team.android, ...config.team.ios];
    return all.filter((l, i) => all.findIndex((x) => sameLogin(x, l)) === i);
  });
  protected readonly assignTitle = computed(() =>
    this.tc()?.status === 'in-review' ? 'Who reviews it' : this.assignSlots().length ? 'Who runs it' : 'Assignees',
  );
  protected readonly ago = (iso: string) => timeAgo(iso);
  protected readonly sized = (url: string) => avatarAt(url, 44);

  protected readonly activity = computed<ActivityItem[]>(() =>
    this.comments()
      .map((c) => {
        const marker = parseMarker(c.body);
        const text = marker ? commentText(c.body) : c.body.trim();
        // Evidence links read as noise here; the Runs section shows the files themselves.
        const evidence = text.split('\n').filter((l) => /^!?\[[^\]]*\]\(https:\/\/github\.com\/[^)]*\/blob\/tcm-evidence\//.test(l.trim()));
        const cleaned = text
          .split('\n')
          .filter((l) => !evidence.includes(l))
          .join('\n')
          .concat(evidence.length ? `\n${evidence.length} evidence file${evidence.length === 1 ? '' : 's'}` : '');
        const [first, ...rest] = cleaned.split(/\n+/);
        return {
          id: c.id,
          url: c.url,
          author: c.author?.login ?? 'ghost',
          avatarUrl: c.author?.avatarUrl ?? '',
          createdAt: c.createdAt,
          marker,
          stale: marker?.kind === 'review' && !!this.history().reviews.find((r) => r.id === c.id && !r.current),
          headline: stripMd(first ?? ''),
          rest: stripMd(rest.join('\n')),
        };
      })
      .reverse(),
  );

  /** The latest change request, shown prominently while the case waits on the author. */
  protected readonly changeRequest = computed(() => {
    const tc = this.tc();
    if (!tc || tc.status !== 'changes-requested') return null;
    return this.activity().find((a) => a.marker?.kind === 'review' && a.marker.data['decision'] === 'request_changes') ?? null;
  });

  protected readonly eligible = computed(() => {
    const tc = this.tc();
    return tc ? this.store.eligibleReviewers(tc.platforms) : [];
  });
  protected readonly suggested = computed(() => {
    const tc = this.tc();
    return tc ? (this.store.suggestReviewers(tc)[0] ?? null) : null;
  });

  constructor() {
    effect(() => {
      if (this.copy()) untracked(() => void this.bank.ensure());
    });
    effect(() => {
      const n = this.number();
      untracked(() => void this.loadDetail(n));
    });
  }

  protected assigneeNames(tc: TestCase): string {
    return tc.assignees.map((a) => a.login).join(', ');
  }

  protected openAssign(tc: TestCase): void {
    const current = tc.assignees.map((a) => a.login);
    this.assignPick.set(current);
    const config = this.ws.config();
    const slots: Partial<Record<Platform, string>> = {};
    for (const p of tc.platforms) {
      slots[p] = current.find((l) => config?.team[p].some((x) => sameLogin(x, l)));
    }
    this.slotPick.set(slots);
    this.assignDialogRef()?.nativeElement.showModal();
  }

  protected toggleAssign(login: string): void {
    this.assignPick.update((r) => (r.some((x) => sameLogin(x, login)) ? r.filter((x) => !sameLogin(x, login)) : [...r, login]));
  }

  protected setSlot(p: Platform, login: string): void {
    this.slotPick.update((s) => ({ ...s, [p]: login || undefined }));
  }

  protected async saveAssign(tc: TestCase): Promise<void> {
    const logins = this.assignSlots().length
      ? Object.values(this.slotPick()).filter((l): l is string => !!l)
      : this.assignPick();
    const unique = logins.filter((l, i) => logins.findIndex((x) => sameLogin(x, l)) === i);
    const ok = await this.act(async () => {
      await this.store.assign(tc, unique);
      this.assignDialogRef()?.nativeElement.close();
    });
    if (ok) this.toasts.show(unique.length ? `Assigned to ${unique.join(', ')}.` : 'Unassigned.');
  }

  protected async toggleRegression(tc: TestCase): Promise<void> {
    const on = !tc.regression;
    if (await this.act(() => this.store.setRegression(tc, on))) {
      this.toasts.show(on ? 'Added to the regression bank.' : 'Removed from the regression bank.');
    }
  }

  protected async updateCopy(tc: TestCase, source: TestCase): Promise<void> {
    if (await this.act(() => this.store.updateCopy(tc, source))) this.toasts.show('Copy updated from the bank. It goes back to review.');
  }

  /** Menus close when you click anywhere else. */
  @HostListener('document:click', ['$event'])
  protected closeMenus(e: MouseEvent): void {
    document.querySelectorAll<HTMLDetailsElement>('details.menu[open]').forEach((d) => {
      if (!d.contains(e.target as Node)) d.open = false;
    });
  }

  protected scrollToReview(): void {
    document.getElementById('review-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('#review-panel textarea')?.focus(), 300);
  }

  protected onReviewed(decision: 'approve' | 'request_changes'): void {
    this.toasts.show(decision === 'approve' ? 'Approved. The runners have been assigned.' : 'Changes requested. Sent back to the author.');
    this.reload();
  }

  protected reload(): void {
    void this.loadDetail(this.number());
  }

  protected openSubmit(): void {
    const s = this.suggested();
    this.reviewers.set(s ? [s] : []);
    this.submitDialog()?.nativeElement.showModal();
  }

  protected toggleReviewer(login: string): void {
    this.reviewers.update((r) => (includesLogin(r, login) ? r.filter((x) => x !== login) : [...r, login]));
  }

  protected async submit(tc: TestCase): Promise<void> {
    const ok = await this.act(async () => {
      await this.store.submit(tc, this.reviewers());
      this.submitDialog()?.nativeElement.close();
    });
    if (ok) this.toasts.show(`Submitted for review to ${this.reviewers().join(', ')}.`);
  }

  protected async close(tc: TestCase, reason: string): Promise<void> {
    const ok = await this.act(async () => {
      await this.store.close(tc, reason);
      this.closeDialogRef()?.nativeElement.close();
    });
    if (ok) this.toasts.show("Closed as won't test.");
  }

  protected async reopen(tc: TestCase): Promise<void> {
    if (await this.act(() => this.store.reopen(tc))) this.toasts.show('Reopened as a draft.');
  }

  protected duplicate(tc: TestCase): void {
    const draft = { ...draftOf(tc), title: `${tc.title} (copy)` };
    void this.router.navigate(['../new'], { relativeTo: this.route, queryParamsHandling: 'preserve', state: { draft } });
  }

  /** Runs an action, then reloads the case. Returns whether it worked. */
  private async act(fn: () => Promise<unknown>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
      await this.loadDetail(this.number());
      return true;
    } catch (e) {
      this.error.set(asGitHubError(e).message);
      this.toasts.show(asGitHubError(e).message, 'bad');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private async loadDetail(n: number): Promise<void> {
    try {
      const d = await this.store.detail(n);
      if (n === this.number()) this.comments.set(d.comments);
    } catch (e) {
      this.error.set(asGitHubError(e).kind === 'not_found' ? `Test case #${n} wasn't found.` : asGitHubError(e).message);
    }
  }
}

/** Plain text for display: drop bold markers and leading emoji markers' asterisks. */
function stripMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').trim();
}

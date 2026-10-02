import { Component, ElementRef, HostListener, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Workspace, asGitHubError } from '../../core/workspace';
import { canRun } from '../../core/testcase/runs';
import { BankStore } from '../../core/testcase/bank-store';
import { copyInfo, isOutOfDate } from '../../core/testcase/bank';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { PRIORITIES, Platform, Priority } from '../../core/config/team-config';
import { STATUSES, STATUS_LABELS, Status, TestCase } from '../../core/testcase/model';
import { timeAgo } from '../../core/time';
import { casesToCsv, download } from '../../core/import/export';
import { Avatars, PlatformBadges, PriorityBadge, StatusBadge } from './badges';

interface Filters {
  q: string;
  priorities: Priority[];
  status: Status | '';
  platform: Platform | '';
  regression: boolean;
  closed: boolean;
}

/** The test case list for the selected feature (M2). Filters live in the URL. */
@Component({
  selector: 'app-cases-list-page',
  imports: [RouterLink, PriorityBadge, StatusBadge, PlatformBadges, Avatars],
  template: `
    <main class="page stack">
      <div class="row">
        <div class="stack" style="gap: 2px">
          <h1>Test cases</h1>
          @if (features.project(); as p) {
            <span class="muted small">
              {{ p.title }}
              @if (features.settings()?.targetVersion; as v) { · target v{{ v }} }
              @if (features.settings()?.releaseDate; as d) { · release {{ d }} }
            </span>
          }
        </div>
        <span class="spacer"></span>
        @if (features.project() && store.cases().length) {
          <button class="btn" type="button" (click)="exportCsv()" title="Download the cases shown below as CSV">Export CSV</button>
        }
        @if (ws.canWriteRepo() && features.project() && isEngineer()) {
          <a class="btn" routerLink="../session" queryParamsHandling="preserve">Start test session</a>
        }
        @if (ws.canWriteRepo() && features.project()) {
          <a class="btn" routerLink="bank" queryParamsHandling="preserve">Add from bank</a>
          <a class="btn" routerLink="import" queryParamsHandling="preserve">Import</a>
          <a class="btn btn-primary" routerLink="new" queryParamsHandling="preserve" title="New test case (N)">
            New test case
          </a>
        }
      </div>

      @if (!features.project()) {
        <section class="card stack">
          <h2>No feature board yet</h2>
          <p class="muted">
            Each feature's test plan is a GitHub Project board. Create a project for the feature, then link it
            to {{ ws.repo()?.nameWithOwner }} from the project's settings (<em>Settings › Linked repositories</em>).
          </p>
        </section>
      } @else {
        <div class="filters">
          <input
            #search
            type="search"
            placeholder="Search title or steps  ( / )"
            aria-label="Search test cases"
            [value]="filters().q"
            (input)="set({ q: $any($event.target).value })"
          />
          <div class="seg" role="group" aria-label="Priority">
            @for (p of priorities; track p) {
              <button
                type="button"
                [class.on]="filters().priorities.includes(p)"
                [attr.aria-pressed]="filters().priorities.includes(p)"
                (click)="togglePriority(p)"
              >
                {{ p }}
              </button>
            }
          </div>
          <select aria-label="Status" (change)="set({ status: $any($event.target).value })">
            <option value="" [selected]="!filters().status">Any status</option>
            @for (s of statuses; track s) {
              <option [value]="s" [selected]="filters().status === s">{{ statusLabels[s] }}</option>
            }
          </select>
          <select aria-label="Platform" (change)="set({ platform: $any($event.target).value })">
            <option value="" [selected]="!filters().platform">Any platform</option>
            <option value="android" [selected]="filters().platform === 'android'">Android</option>
            <option value="ios" [selected]="filters().platform === 'ios'">iOS</option>
          </select>
          <label class="row small">
            <input type="checkbox" [checked]="filters().regression" (change)="set({ regression: $any($event.target).checked })" />
            Regression
          </label>
          <label class="row small">
            <input type="checkbox" [checked]="filters().closed" (change)="set({ closed: $any($event.target).checked })" />
            Show closed
          </label>
        </div>

        @switch (store.load().status) {
          @case ('loading') {
            <div class="row muted"><span class="spinner" aria-hidden="true"></span> Loading test cases…</div>
          }
          @case ('error') {
            <div class="banner banner-bad" role="alert">
              Couldn't load test cases: {{ loadError() }}
              <button class="btn btn-link" type="button" (click)="store.refresh()">Retry</button>
            </div>
          }
          @default {
            <div class="counts" aria-label="Counts by status">
              @for (c of statusCounts(); track c.status) {
                <button type="button" class="count" [class.on]="filters().status === c.status" (click)="toggleStatus(c.status)">
                  <strong>{{ c.count }}</strong> {{ statusLabels[c.status] }}
                </button>
              }
            </div>

            @if (store.cases().length === 0) {
              <section class="card stack empty">
                <h2>No test cases yet</h2>
                <p class="muted">
                  Write the first one, import your existing Google Sheet, or paste a batch of Gherkin scenarios.
                </p>
                @if (ws.canWriteRepo()) {
                  <div class="row">
                    <a class="btn btn-primary" routerLink="new" queryParamsHandling="preserve">New test case</a>
                    <a class="btn" routerLink="import" queryParamsHandling="preserve">Import a sheet</a>
                  </div>
                }
              </section>
            } @else if (shown().length === 0) {
              <p class="muted">
                No test cases match these filters.
                <button class="btn btn-link" type="button" (click)="clear()">Clear filters</button>
              </p>
            } @else {
              @if (selected().size) {
                <div class="bulk card row" role="region" aria-label="Bulk actions">
                  <strong>{{ selected().size }} selected</strong>
                  <span class="muted small">Assign runners:</span>
                  @for (p of bulkPlatforms; track p.id) {
                    <label class="row small">
                      {{ p.name }}
                      <select (change)="setBulk(p.id, $any($event.target).value)" [attr.aria-label]="p.name + ' runner'">
                        <option value="">Keep current</option>
                        @for (login of team(p.id); track login) {
                          <option [value]="login">{{ login }}</option>
                        }
                      </select>
                    </label>
                  }
                  <button class="btn btn-primary" type="button" (click)="applyBulk()" [disabled]="bulkBusy() || !hasBulkPick()">
                    @if (bulkBusy()) { <span class="spinner" aria-hidden="true"></span> {{ bulkDone() }}/{{ selected().size }} } @else { Apply }
                  </button>
                  <button class="btn btn-link small" type="button" (click)="clearSelection()">Clear</button>
                </div>
              }
              @if (bulkError()) {
                <div class="banner banner-bad" role="alert">{{ bulkError() }}</div>
              }
              <table class="cases card">
                <thead>
                  <tr>
                    @if (canBulk()) {
                      <th scope="col" class="sel">
                        <input type="checkbox" aria-label="Select all runnable cases" [checked]="allSelected()" (change)="toggleAll()" />
                      </th>
                    }
                    <th scope="col" class="num">#</th>
                    <th scope="col">Test case</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Platforms</th>
                    <th scope="col">Status</th>
                    <th scope="col">Assignees</th>
                    <th scope="col" class="upd">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  @for (tc of shown(); track tc.number) {
                    <tr>
                      @if (canBulk()) {
                        <td class="sel">
                          @if (runnable(tc)) {
                            <input type="checkbox" [attr.aria-label]="'Select #' + tc.number" [checked]="selected().has(tc.number)" (change)="toggleSelect(tc.number)" />
                          }
                        </td>
                      }
                      <td class="num muted">{{ tc.number }}</td>
                      <td>
                        <a class="title" [routerLink]="[tc.number]" queryParamsHandling="preserve">{{ tc.title }}</a>
                        @if (tc.regression) {
                          <span class="badge badge-outline small">regression</span>
                        }
                        @if (outdated().has(tc.number)) {
                          <span class="badge status-in-review small" title="The bank original changed after this copy was made">out of date</span>
                        }
                      </td>
                      <td><app-priority [value]="tc.priority" /></td>
                      <td><app-platforms [value]="tc.platforms" /></td>
                      <td><app-status [value]="tc.status" [closed]="tc.closed" /></td>
                      <td><app-avatars [people]="tc.assignees" /></td>
                      <td class="upd muted small">{{ ago(tc.updatedAt) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              <p class="muted small">
                Showing {{ shown().length }} of {{ store.cases().length }}.
                <span class="kbd">/</span> search · <span class="kbd">N</span> new test case
              </p>
            }
          }
        }
      }
    </main>
  `,
  styles: `
    .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .filters input[type='search'] { flex: 1 1 240px; width: auto; }
    .filters select { width: auto; }
    .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
    .seg button { border: none; background: var(--surface); color: var(--text-2); font: inherit; font-weight: 600; padding: 0 10px; height: 34px; cursor: pointer; }
    .seg button + button { border-left: 1px solid var(--border); }
    .seg button.on { background: var(--accent-soft); color: var(--accent); }
    .counts { display: flex; flex-wrap: wrap; gap: 6px; }
    .count { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); border-radius: 16px; padding: 3px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .count.on { border-color: var(--accent); color: var(--accent); }
    .count strong { color: var(--text); }
    .cases { width: 100%; border-collapse: collapse; padding: 0; overflow: hidden; }
    .cases th { text-align: left; font-size: 12px; font-weight: 600; color: var(--text-2); padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .cases td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .cases tr:last-child td { border-bottom: none; }
    .cases tbody tr:hover { background: var(--surface-2); }
    .num { width: 44px; }
    .sel { width: 32px; }
    .bulk { flex-wrap: wrap; gap: 12px; padding: 10px 14px; border-color: var(--accent); }
    .bulk select { width: auto; height: 30px; }
    .upd { white-space: nowrap; }
    .title { color: var(--text); font-weight: 500; text-decoration: none; margin-right: 6px; }
    .title:hover { color: var(--accent); text-decoration: underline; }
    .empty { align-items: flex-start; }
  `,
})
export class CasesListPage {
  protected readonly ws = inject(Workspace);
  protected readonly features = inject(FeatureSelection);
  protected readonly store = inject(CasesStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly priorities = PRIORITIES;
  protected readonly statuses = STATUSES;
  protected readonly statusLabels = STATUS_LABELS;
  protected readonly ago = (iso: string) => timeAgo(iso);

  protected readonly filters = toSignal(
    this.route.queryParamMap.pipe(
      map(
        (q): Filters => ({
          q: q.get('q') ?? '',
          priorities: (q.get('priority') ?? '').split(',').filter((p): p is Priority => (PRIORITIES as readonly string[]).includes(p)),
          status: ((STATUSES as readonly string[]).includes(q.get('status') ?? '') ? q.get('status') : '') as Status | '',
          platform: (['android', 'ios'].includes(q.get('platform') ?? '') ? q.get('platform') : '') as Platform | '',
          regression: q.get('regression') === '1',
          closed: q.get('closed') === '1',
        }),
      ),
    ),
    { requireSync: true },
  );

  /** Cases that pass every filter except status (so status counts stay meaningful). */
  private readonly base = computed(() => {
    const f = this.filters();
    const q = f.q.trim().toLowerCase();
    return this.store
      .cases()
      .filter((c) => f.closed || !c.closed)
      .filter((c) => !f.priorities.length || (c.priority && f.priorities.includes(c.priority)))
      .filter((c) => !f.platform || c.platforms.includes(f.platform))
      .filter((c) => !f.regression || c.regression)
      .filter((c) => !q || matches(c, q))
      .sort((a, b) => Number(a.closed) - Number(b.closed) || (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9') || a.number - b.number);
  });

  protected readonly shown = computed(() => {
    const s = this.filters().status;
    return this.base().filter((c) => !s || (c.status === s && !c.closed));
  });

  protected readonly statusCounts = computed(() =>
    STATUSES.map((status) => ({ status, count: this.base().filter((c) => !c.closed && c.status === status).length })).filter(
      (c) => c.count > 0 || c.status === this.filters().status,
    ),
  );

  // ---- bulk runner assignment (AS-5) ----
  protected readonly selected = signal<Set<number>>(new Set());
  private readonly bulkPick = signal<Partial<Record<Platform, string>>>({});
  protected readonly bulkBusy = signal(false);
  protected readonly bulkDone = signal(0);
  protected readonly bulkError = signal<string | null>(null);
  protected readonly bulkPlatforms: { id: Platform; name: string }[] = [
    { id: 'android', name: 'Android' },
    { id: 'ios', name: 'iOS' },
  ];
  protected readonly canBulk = computed(() => this.ws.canWriteRepo() && !this.ws.isViewerOnly());
  protected readonly runnable = (tc: TestCase) => canRun(tc);
  protected readonly allSelected = computed(() => {
    const r = this.shown().filter(canRun);
    return r.length > 0 && r.every((c) => this.selected().has(c.number));
  });
  protected readonly hasBulkPick = computed(() => Object.values(this.bulkPick()).some(Boolean));
  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected team(p: Platform): string[] {
    return this.ws.config()?.team[p] ?? [];
  }

  protected toggleSelect(n: number): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.shown().filter(canRun).map((c) => c.number)));
  }

  protected setBulk(p: Platform, login: string): void {
    this.bulkPick.update((b) => ({ ...b, [p]: login || undefined }));
  }

  protected async applyBulk(): Promise<void> {
    const cases = [...this.selected()].map((n) => this.store.byNumber(n)).filter((c): c is TestCase => !!c);
    this.bulkBusy.set(true);
    this.bulkDone.set(0);
    this.bulkError.set(null);
    try {
      await this.store.assignRunners(cases, this.bulkPick(), (d) => this.bulkDone.set(d));
      this.selected.set(new Set());
    } catch (e) {
      this.bulkError.set(`Stopped after ${this.bulkDone()} of ${cases.length}: ${asGitHubError(e).message}`);
    } finally {
      this.bulkBusy.set(false);
    }
  }

  private readonly bank = inject(BankStore);
  /** Copies whose bank original has changed since (RB-5). */
  protected readonly outdated = computed(() => {
    const bank = this.bank.bankCases();
    return new Set(this.store.cases().filter((c) => isOutOfDate(c, bank)).map((c) => c.number));
  });

  protected readonly isEngineer = computed(() => this.ws.roles().includes('android') || this.ws.roles().includes('ios'));

  protected readonly loadError = computed(() => {
    const l = this.store.load();
    return l.status === 'error' ? l.error.message : '';
  });

  constructor() {
    // Only needed when the feature has copies from the bank.
    effect(() => {
      if (this.store.cases().some((c) => copyInfo(c))) untracked(() => void this.bank.ensure());
    });
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.key === '/') {
      e.preventDefault();
      this.search()?.nativeElement.focus();
    } else if ((e.key === 'n' || e.key === 'N') && this.ws.canWriteRepo() && this.features.project()) {
      e.preventDefault();
      void this.router.navigate(['new'], { relativeTo: this.route, queryParamsHandling: 'preserve' });
    }
  }

  protected set(patch: Partial<Filters>): void {
    const f = { ...this.filters(), ...patch };
    void this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParamsHandling: 'merge',
      queryParams: {
        q: f.q || null,
        priority: f.priorities.length ? f.priorities.join(',') : null,
        status: f.status || null,
        platform: f.platform || null,
        regression: f.regression ? '1' : null,
        closed: f.closed ? '1' : null,
      },
    });
  }

  protected togglePriority(p: Priority): void {
    const list = this.filters().priorities;
    this.set({ priorities: list.includes(p) ? list.filter((x) => x !== p) : [...list, p].sort() });
  }

  protected toggleStatus(s: Status): void {
    this.set({ status: this.filters().status === s ? '' : s });
  }

  protected exportCsv(): void {
    const feature = this.features.project()?.title ?? 'test-cases';
    const slug = feature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    download(`${slug}-test-cases-${new Date().toISOString().slice(0, 10)}.csv`, casesToCsv(this.shown()));
  }

  protected clear(): void {
    this.set({ q: '', priorities: [], status: '', platform: '', regression: false, closed: false });
  }
}

function matches(c: TestCase, q: string): boolean {
  return (
    String(c.number) === q.replace('#', '') ||
    c.title.toLowerCase().includes(q) ||
    c.preconditions.toLowerCase().includes(q) ||
    c.steps.some((s) => s.text.toLowerCase().includes(q))
  );
}

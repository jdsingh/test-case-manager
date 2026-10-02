import { Component, ElementRef, HostListener, computed, inject, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Workspace } from '../../core/workspace';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { PRIORITIES, Platform, Priority } from '../../core/config/team-config';
import { STATUSES, STATUS_LABELS, Status, TestCase } from '../../core/testcase/model';
import { timeAgo } from '../../core/time';
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
        @if (ws.canWriteRepo() && features.project()) {
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
                  Write the first one, or draft a batch with the Claude Code skill in this repo.
                </p>
                @if (ws.canWriteRepo()) {
                  <div><a class="btn btn-primary" routerLink="new" queryParamsHandling="preserve">New test case</a></div>
                }
              </section>
            } @else if (shown().length === 0) {
              <p class="muted">
                No test cases match these filters.
                <button class="btn btn-link" type="button" (click)="clear()">Clear filters</button>
              </p>
            } @else {
              <table class="cases card">
                <thead>
                  <tr>
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
                      <td class="num muted">{{ tc.number }}</td>
                      <td>
                        <a class="title" [routerLink]="[tc.number]" queryParamsHandling="preserve">{{ tc.title }}</a>
                        @if (tc.regression) {
                          <span class="badge badge-outline small">regression</span>
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

  protected readonly loadError = computed(() => {
    const l = this.store.load();
    return l.status === 'error' ? l.error.message : '';
  });

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

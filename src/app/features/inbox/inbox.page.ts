import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Workspace } from '../../core/workspace';
import { InboxItem, InboxStore } from '../../core/testcase/inbox-store';
import { timeAgo } from '../../core/time';
import { PlatformBadges, PriorityBadge, StatusBadge } from '../cases/badges';

interface Group {
  key: string;
  title: string;
  hint: string;
  items: InboxItem[];
  /** Where an item opens: the review queue or the case itself. */
  target: 'review' | 'case';
}

/** Everything assigned to you, grouped by what to do (IN-1). */
@Component({
  selector: 'app-inbox-page',
  imports: [RouterLink, PriorityBadge, PlatformBadges, StatusBadge],
  template: `
    <main class="page stack">
      <div class="row">
        <div class="stack" style="gap: 2px">
          <h1>Inbox</h1>
          <span class="muted small">Test cases assigned to you in {{ ws.repo()?.nameWithOwner }}, across all features.</span>
        </div>
        <span class="spacer"></span>
        @if (inbox.loading()) {
          <span class="spinner" aria-label="Refreshing"></span>
        }
        <button class="btn btn-link small" type="button" (click)="inbox.refresh()">Refresh</button>
      </div>

      @if (inbox.error()) {
        <div class="banner banner-bad" role="alert">Couldn't load your inbox: {{ inbox.error() }}</div>
      }

      @if (!anything() && !inbox.loading()) {
        <section class="card stack">
          <h2>You're all caught up</h2>
          <p class="muted">Nothing is assigned to you right now. When a case needs your review or a run, it shows up here.</p>
        </section>
      }

      @for (g of groups(); track g.key) {
        @if (g.items.length) {
          <section class="stack group" [attr.aria-labelledby]="'g-' + g.key">
            <div class="row">
              <h2 [id]="'g-' + g.key">{{ g.title }}</h2>
              <span class="count">{{ g.items.length }}</span>
              <span class="muted small">{{ g.hint }}</span>
              @if (g.key === 'android' || g.key === 'ios') {
                <span class="spacer"></span>
                <a class="btn small-btn" routerLink="../session">Start test session</a>
              }
            </div>
            <ul class="items card">
              @for (i of g.items; track i.testCase.number) {
                <li>
                  <a
                    [routerLink]="g.target === 'review' ? '../review' : ['../cases', i.testCase.number]"
                    [queryParams]="link(i, g.target)"
                  >
                    <span class="muted num">#{{ i.testCase.number }}</span>
                    <span class="t">{{ i.testCase.title }}</span>
                  </a>
                  <span class="meta">
                    <app-priority [value]="i.testCase.priority" />
                    <app-platforms [value]="i.testCase.platforms" />
                    <app-status [value]="i.testCase.status" />
                    @if (i.feature) {
                      <span class="muted small">{{ i.feature.title }}</span>
                    }
                    <span class="muted small">{{ ago(i.testCase.updatedAt) }}</span>
                  </span>
                </li>
              }
            </ul>
          </section>
        }
      }
    </main>
  `,
  styles: `
    .group { gap: 8px; }
    .count { font-size: 12px; font-weight: 700; padding: 0 8px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); }
    .items { list-style: none; margin: 0; padding: 0; }
    .items li { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .items li:last-child { border-bottom: none; }
    .items a { flex: 1 1 280px; display: flex; gap: 8px; text-decoration: none; color: var(--text); }
    .items a:hover .t { color: var(--accent); text-decoration: underline; }
    .t { font-weight: 500; }
    .num { min-width: 32px; }
    .meta { display: flex; align-items: center; gap: 8px; }
    .small-btn { height: 28px; font-size: 13px; }
  `,
})
export class InboxPage {
  protected readonly ws = inject(Workspace);
  protected readonly inbox = inject(InboxStore);
  protected readonly ago = (iso: string) => timeAgo(iso);

  protected readonly groups = computed<Group[]>(() => {
    const g = this.inbox.groups();
    return [
      { key: 'review', title: 'To review', hint: 'Approve or request changes', items: g.review, target: 'review' },
      { key: 'android', title: 'To run on Android', hint: 'Run them on a test device and record the results', items: g.run.android, target: 'case' },
      { key: 'ios', title: 'To run on iOS', hint: 'Run them on a test device and record the results', items: g.run.ios, target: 'case' },
      { key: 'changes', title: 'Changes requested on your cases', hint: 'Edit, then resubmit', items: g.changes, target: 'case' },
      { key: 'drafts', title: 'Your drafts', hint: 'Not yet submitted for review', items: g.drafts, target: 'case' },
    ];
  });

  protected readonly anything = computed(() => this.inbox.items().length > 0);

  protected link(i: InboxItem, target: 'review' | 'case'): Record<string, string | number> {
    const q: Record<string, string | number> = {};
    if (i.feature) q['feature'] = i.feature.number;
    if (target === 'review') q['case'] = i.testCase.number;
    return q;
  }
}

import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Session } from '../session';
import { Workspace, asGitHubError } from '../workspace';
import { CasesStore } from './cases-store';
import { searchAssignedCases } from '../github/api';
import { Platform, sameLogin } from '../config/team-config';
import { TestCase, fromIssue } from './model';
import { InboxCount } from '../title';

export interface InboxItem {
  testCase: TestCase;
  feature: { number: number; title: string } | null;
}

export interface InboxGroups {
  review: InboxItem[];
  run: Record<Platform, InboxItem[]>;
  changes: InboxItem[];
  drafts: InboxItem[];
}

const REFRESH_AFTER_MS = 60_000;

/** Everything assigned to the signed-in user in the repo (IN-1), grouped by what to do. */
@Injectable({ providedIn: 'root' })
export class InboxStore {
  private readonly session = inject(Session);
  private readonly ws = inject(Workspace);
  private readonly cases = inject(CasesStore);

  readonly items = signal<InboxItem[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private loadedAt = 0;
  private key: string | null = null;

  readonly groups = computed<InboxGroups>(() => {
    const config = this.ws.config();
    const me = this.session.viewer()?.login ?? '';
    const onTeam = (p: Platform) => !!config && config.team[p].some((l) => sameLogin(l, me));
    const items = this.items();
    const runFor = (p: Platform) =>
      items.filter(
        (i) =>
          ['approved', 'failed', 'blocked'].includes(i.testCase.status ?? '') &&
          i.testCase.platforms.includes(p) &&
          onTeam(p),
      );
    return {
      review: items.filter((i) => i.testCase.status === 'in-review'),
      run: { android: runFor('android'), ios: runFor('ios') },
      changes: items.filter((i) => i.testCase.status === 'changes-requested'),
      drafts: items.filter((i) => i.testCase.status === 'draft' || i.testCase.status === null),
    };
  });

  /** What needs action now; drafts are the user's own work in progress and don't count. */
  readonly count = computed(() => {
    const g = this.groups();
    const run = new Set([...g.run.android, ...g.run.ios].map((i) => i.testCase.number));
    return g.review.length + run.size + g.changes.length;
  });

  constructor() {
    const shared = inject(InboxCount);
    effect(() => shared.value.set(this.count()));
    effect(() => {
      const repo = this.ws.repo();
      const me = this.session.viewer()?.login;
      this.cases.writes(); // refresh after any change made in the app
      untracked(() => {
        const key = repo && me ? `${repo.nameWithOwner}@${me}` : null;
        if (key !== this.key) {
          this.items.set([]);
          this.key = key;
        }
        if (key) void this.refresh();
      });
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - this.loadedAt > REFRESH_AFTER_MS) void this.refresh();
      });
    }
  }

  async refresh(): Promise<void> {
    const repo = this.ws.repo();
    const me = this.session.viewer()?.login;
    if (!repo || !me) return;
    const key = `${repo.nameWithOwner}@${me}`;
    this.loading.set(true);
    try {
      const res = await searchAssignedCases(this.session.requireClient(), repo.nameWithOwner, me);
      if (key !== this.key) return;
      this.items.set(
        res.items.map(({ issue, projects }) => ({
          testCase: fromIssue(issue),
          feature: projects[0] ? { number: projects[0].number, title: projects[0].title } : null,
        })),
      );
      this.error.set(null);
      this.loadedAt = Date.now();
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.loading.set(false);
    }
  }
}

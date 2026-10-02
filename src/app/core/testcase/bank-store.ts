import { Injectable, inject, signal } from '@angular/core';
import { Session } from '../session';
import { Workspace, asGitHubError } from '../workspace';
import { CasesStore } from './cases-store';
import { searchBank } from '../github/api';
import { TestCase, fromIssue } from './model';

export interface BankCase {
  testCase: TestCase;
  features: string[];
}

/** The regression bank across all features (RB-1). Loaded when a screen asks for it. */
@Injectable({ providedIn: 'root' })
export class BankStore {
  private readonly session = inject(Session);
  private readonly ws = inject(Workspace);
  private readonly cases = inject(CasesStore);

  readonly items = signal<BankCase[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private loadedFor: string | null = null;
  private loadedAtWrite = -1;

  /** Loads the bank for the open repo, unless it's already fresh. */
  async ensure(): Promise<void> {
    const repo = this.ws.repo();
    if (!repo) return;
    const writes = this.cases.writes();
    if (this.loadedFor === repo.nameWithOwner && this.loadedAtWrite === writes) return;
    this.loading.set(true);
    try {
      const res = await searchBank(this.session.requireClient(), repo.nameWithOwner);
      this.items.set(res.items.map(({ issue, projects }) => ({ testCase: fromIssue(issue), features: projects.map((p) => p.title) })));
      this.loadedFor = repo.nameWithOwner;
      this.loadedAtWrite = writes;
      this.error.set(null);
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.loading.set(false);
    }
  }

  bankCases(): TestCase[] {
    return this.items().map((i) => i.testCase);
  }
}

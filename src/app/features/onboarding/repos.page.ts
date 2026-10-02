import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Session } from '../../core/session';
import { asGitHubError } from '../../core/workspace';
import { RepoSummary, listViewerRepos } from '../../core/github/api';

const TESTBANK_SUFFIX = '-testbank';

/** Onboarding step 2: pick the testbank repo (ON-3). */
@Component({
  selector: 'app-repos-page',
  imports: [FormsModule],
  template: `
    <main class="page-narrow stack">
      <div class="stack" style="gap: 6px">
        <h1>Choose the testbank repo</h1>
        <p class="muted">
          Test cases live as issues in a dedicated repo named <code>&lt;app&gt;-testbank</code>.
          Repos with that suffix are listed first.
        </p>
      </div>

      <input
        type="search"
        placeholder="Filter, or type owner/name"
        aria-label="Filter repositories"
        [ngModel]="filter()"
        (ngModelChange)="filter.set($event)"
        (keydown.enter)="openTyped()"
      />

      @if (error()) {
        <div class="banner banner-bad" role="alert">{{ error() }}</div>
      }

      @if (loading()) {
        <div class="row muted"><span class="spinner" aria-hidden="true"></span> Loading your repos…</div>
      } @else {
        <ul class="repo-list card" role="list">
          @for (r of shown(); track r.nameWithOwner) {
            <li>
              <button class="repo" type="button" (click)="open(r.nameWithOwner)">
                <span class="name">{{ r.nameWithOwner }}</span>
                @if (isTestbank(r)) {
                  <span class="tag">testbank</span>
                }
                @if (r.isPrivate) {
                  <span class="tag muted">private</span>
                }
                <span class="spacer"></span>
                <span class="muted small">{{ permissionLabel(r) }}</span>
              </button>
            </li>
          } @empty {
            <li class="muted empty">
              No matching repos.
              @if (looksLikeRepo()) {
                Press Enter to open <code>{{ filter().trim() }}</code>.
              }
            </li>
          }
        </ul>
      }
    </main>
  `,
  styles: `
    .repo-list {
      list-style: none;
      margin: 0;
      padding: 4px;
      max-height: 60vh;
      overflow: auto;
    }
    .repo {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 12px;
      border: none;
      border-radius: 6px;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .repo:hover {
      background: var(--surface-2);
    }
    .name {
      font-weight: 500;
    }
    .tag {
      font-size: 11.5px;
      padding: 1px 8px;
      border-radius: 10px;
      background: var(--accent-soft);
      color: var(--accent);
    }
    .tag.muted {
      background: var(--surface-2);
    }
    .empty {
      padding: 12px;
    }
  `,
})
export class ReposPage implements OnInit {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  protected readonly filter = signal('');
  protected readonly repos = signal<RepoSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly shown = computed(() => {
    const f = this.filter().trim().toLowerCase();
    return this.repos()
      .filter((r) => !f || r.nameWithOwner.toLowerCase().includes(f))
      .sort((a, b) => Number(this.isTestbank(b)) - Number(this.isTestbank(a)));
  });

  async ngOnInit(): Promise<void> {
    try {
      this.repos.set(await listViewerRepos(this.session.requireClient()));
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.loading.set(false);
    }
  }

  protected isTestbank(r: RepoSummary): boolean {
    return r.nameWithOwner.toLowerCase().endsWith(TESTBANK_SUFFIX);
  }

  protected permissionLabel(r: RepoSummary): string {
    switch (r.viewerPermission) {
      case 'ADMIN':
      case 'MAINTAIN':
      case 'WRITE':
        return 'can write';
      case null:
        return '';
      default:
        return 'read only';
    }
  }

  protected looksLikeRepo(): boolean {
    return /^[\w.-]+\/[\w.-]+$/.test(this.filter().trim());
  }

  protected openTyped(): void {
    if (this.shown().length === 1) this.open(this.shown()[0].nameWithOwner);
    else if (this.looksLikeRepo()) this.open(this.filter().trim());
  }

  protected open(nameWithOwner: string): void {
    void this.router.navigateByUrl(`/r/${nameWithOwner}`);
  }
}

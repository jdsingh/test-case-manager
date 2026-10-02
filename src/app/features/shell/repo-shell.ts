import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Session } from '../../core/session';
import { Workspace } from '../../core/workspace';
import { FeatureSelection } from '../../core/feature-selection';
import { InboxStore } from '../../core/testcase/inbox-store';
import { CommandPalette } from './command-palette';
import { CONFIG_PATH } from '../../core/github/api';
import { ROLE_NAMES } from '../../core/config/team-config';
import { avatarAt } from '../../core/avatar';

/** Layout for everything under /r/:owner/:repo. */
@Component({
  selector: 'app-repo-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommandPalette],
  template: `
    <header class="top">
      <div class="top-inner">
        <a class="brand" [routerLink]="base()">Test Case Manager</a>
        <a class="repo muted" routerLink="/repos" title="Switch repo">{{ repoName() }}</a>

        @if (ws.config()) {
          <nav class="nav" aria-label="Main">
            <a [routerLink]="base() + '/cases'" routerLinkActive="active" queryParamsHandling="preserve">Test cases</a>
            @if (canReview()) {
              <a [routerLink]="base() + '/review'" routerLinkActive="active" queryParamsHandling="preserve">Review</a>
            }
            <a [routerLink]="base() + '/inbox'" routerLinkActive="active" queryParamsHandling="preserve">
              Inbox
              @if (inbox.count()) {
                <span class="nav-count" [attr.aria-label]="inbox.count() + ' need your attention'">{{ inbox.count() }}</span>
              }
            </a>
            <a [routerLink]="base() + '/dashboard'" routerLinkActive="active" queryParamsHandling="preserve">Dashboard</a>
            <a [routerLink]="base() + '/settings/team'" routerLinkActive="active" queryParamsHandling="preserve">Team</a>
          </nav>
        }

        <span class="spacer"></span>

        <button class="btn jump" type="button" (click)="palette.show()" title="Jump to anything (⌘K / Ctrl+K)">
          <span class="jump-label">Jump to…</span> <span class="kbd">⌘K</span>
        </button>

        @if (openProjects().length) {
          <label class="feature">
            <span class="sr-only">Feature</span>
            <select (change)="pickFeature($any($event.target).value)">
              @for (p of openProjects(); track p.number) {
                <option [value]="p.number" [selected]="'' + p.number === features.selected()">{{ p.title }}</option>
              }
            </select>
          </label>
        }

        @if (session.viewer(); as v) {
          <span class="who" [title]="rolesText()">
            <img class="avatar" [src]="sized(v.avatarUrl)" alt="" />
            <span>{{ v.login }}</span>
          </span>
          <button class="btn btn-link small" type="button" (click)="signOut()">Sign out</button>
        }
      </div>
    </header>

    <app-command-palette #palette />

    <div class="banners">
      @if (session.isDemo()) {
        <div class="banner sample-banner" role="status">
          <span><strong>Sample data.</strong> Nothing is saved to GitHub, and it resets when you reload.</span>
          <span class="spacer"></span>
          <label class="row small">
            Viewing as
            <select (change)="switchDemo($any($event.target).value)">
              @for (p of demoPeople; track p.login) {
                <option [value]="p.login" [selected]="p.login === session.viewer()?.login">{{ p.label }}</option>
              }
            </select>
          </label>
          <button class="btn btn-link small" type="button" (click)="signOut()">Exit sample data</button>
        </div>
      }
      @if (missingScopes().length) {
        <div class="banner banner-warn" role="status">
          Your token is missing the {{ missingScopes().join(' and ') }} scope. Some features won't work.
          Create a new token with <code>repo</code> and <code>project</code>, then sign in again.
        </div>
      }
      @switch (ws.configState().kind) {
        @case ('missing') {
          @if (ws.load().status === 'ready' && !ws.canWriteRepo()) {
            <div class="banner banner-warn" role="status">
              This repo hasn't been set up for Test Case Manager yet. Someone with write access needs
              to open it in the app once.
            </div>
          }
        }
        @case ('invalid') {
          <div class="banner banner-bad" role="alert">
            <div>
              <strong>The team config can't be read, so you're in read-only mode.</strong>
              <ul>
                @for (e of configErrors(); track e) {
                  <li>{{ e }}</li>
                }
              </ul>
              <a [href]="configUrl()" target="_blank" rel="noopener">Open {{ configPath }} on GitHub</a>
            </div>
          </div>
        }
        @case ('ok') {
          @if (ws.isViewerOnly()) {
            <div class="banner" role="status">
              You're signed in as <strong>{{ session.viewer()?.login }}</strong>, who isn't on this
              team yet, so the app is read-only. Ask the PM or tech lead to add you in Team settings.
            </div>
          }
        }
      }
      @if (projectsScopeProblem()) {
        <div class="banner banner-warn" role="status">
          Feature boards can't be loaded: {{ projectsScopeProblem() }}
        </div>
      }
    </div>

    @if (loadError(); as err) {
      <main class="page-narrow stack">
        <div class="banner banner-bad" role="alert">{{ err }}</div>
        <div class="row">
          <button class="btn" type="button" (click)="ws.reload()">Try again</button>
          <a class="btn" routerLink="/repos">Choose another repo</a>
        </div>
      </main>
    } @else if (!ws.repo()) {
      <div class="page row muted"><span class="spinner" aria-hidden="true"></span> Loading {{ repoName() }}…</div>
    }
    <!-- One outlet that stays put, so background reloads never recreate the page. -->
    <div [hidden]="!!loadError() || !ws.repo()"><router-outlet /></div>
  `,
  styles: `
    .top {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .top-inner {
      display: flex;
      align-items: center;
      gap: 16px;
      height: 52px;
      padding: 0 20px;
    }
    .brand {
      font-weight: 700;
      color: var(--text);
      text-decoration: none;
    }
    .repo {
      text-decoration: none;
      font-size: 13px;
    }
    .nav {
      display: flex;
      gap: 4px;
      margin-left: 8px;
    }
    .nav a {
      padding: 6px 10px;
      border-radius: 6px;
      color: var(--text-2);
      text-decoration: none;
      font-weight: 500;
    }
    .nav a:hover {
      background: var(--surface-2);
      color: var(--text);
    }
    .nav-count {
      margin-left: 4px;
      padding: 0 6px;
      border-radius: 9px;
      font-size: 11px;
      font-weight: 700;
      background: var(--bad);
      color: #fff;
    }
    .nav a.active {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .jump { height: 32px; color: var(--text-2); font-weight: 400; gap: 8px; }
    .brand, .repo, .nav a, .who { white-space: nowrap; }
    .nav a { display: inline-flex; align-items: center; }
    .feature select { max-width: 190px; }
    @media (max-width: 1320px) {
      .repo, .jump-label { display: none; }
    }
    @media (max-width: 1100px) {
      .who span { display: none; }
    }
    /* Phones: brand and controls on one row, the nav scrolls sideways underneath. */
    @media (max-width: 760px) {
      .top-inner { flex-wrap: wrap; height: auto; padding: 8px 12px; gap: 8px 10px; }
      .nav { order: 3; width: 100%; margin-left: 0; overflow-x: auto; scrollbar-width: none; }
      .jump { display: none; }
      .feature select { max-width: 150px; }
      .banners { padding: 0 12px; }
    }
    .feature select {
      height: 32px;
      max-width: 220px;
    }
    .who {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
    }
    .sample-banner { align-items: center; background: var(--accent-soft); border-color: var(--accent); }
    .sample-banner select { width: auto; height: 28px; }
    .banners {
      max-width: 1080px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .banners:not(:empty) {
      padding-top: 16px;
    }
  `,
})
export class RepoShell {
  protected readonly session = inject(Session);
  protected readonly ws = inject(Workspace);
  protected readonly features = inject(FeatureSelection);
  protected readonly inbox = inject(InboxStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly configPath = CONFIG_PATH;
  /** Only engineers review, so the tab is a dead end for everyone else (UX 4). */
  protected readonly canReview = computed(() => this.ws.roles().some((r) => r === 'android' || r === 'ios'));

  protected readonly repoName = computed(() => this.ws.repo()?.nameWithOwner ?? this.paramsName());
  protected readonly base = computed(() => `/r/${this.repoName()}`);
  protected readonly openProjects = computed(() => this.ws.projects().filter((p) => !p.closed));
  protected readonly configErrors = computed(() => {
    const s = this.ws.configState();
    return s.kind === 'invalid' ? s.errors : [];
  });
  protected readonly missingScopes = computed(() => {
    const s = this.session.state();
    return s.status === 'signed-in' ? s.missingScopes : [];
  });
  protected readonly rolesText = computed(() => {
    const roles = this.ws.roles();
    return roles.length ? `Roles: ${roles.map((r) => ROLE_NAMES[r]).join(', ')}` : 'Viewer';
  });
  protected readonly projectsScopeProblem = computed(() => {
    const e = this.ws.projectsError();
    if (!e || this.missingScopes().length) return null;
    return e.kind === 'forbidden'
      ? 'the token needs the project scope (or Projects access for organization boards).'
      : e.message;
  });
  protected readonly loadError = computed(() => {
    const s = this.ws.load();
    if (s.status !== 'error') return null;
    return s.error.kind === 'not_found'
      ? `${this.paramsName()} wasn't found, or your token can't see it.`
      : s.error.message;
  });

  protected readonly sized = (url: string) => avatarAt(url, 44);

  protected configUrl(): string {
    const r = this.ws.repo();
    return r ? `https://github.com/${r.nameWithOwner}/blob/${r.defaultBranch ?? 'HEAD'}/${CONFIG_PATH}` : '#';
  }

  protected pickFeature(value: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { feature: value || null },
      queryParamsHandling: 'merge',
    });
  }

  protected readonly demoPeople = [
    { login: 'priya-pm', label: 'Product manager (Priya)' },
    { login: 'sam-android', label: 'Android engineer (Sam)' },
    { login: 'jo-ios', label: 'iOS engineer (Jo)' },
    { login: 'alex-lead', label: 'Tech lead (Alex)' },
  ];

  /** Same sample data, seen as someone else: each role lands on its own home screen. */
  protected async switchDemo(login: string): Promise<void> {
    await this.session.signInDemo(login);
    await this.router.navigateByUrl('/r/acme/shop-app-testbank');
  }

  protected signOut(): void {
    this.session.signOut();
    void this.router.navigateByUrl('/connect');
  }

  private paramsName(): string {
    const p = this.route.snapshot.paramMap;
    return `${p.get('owner')}/${p.get('repo')}`;
  }
}

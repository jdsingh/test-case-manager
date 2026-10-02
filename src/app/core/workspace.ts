import { Injectable, computed, inject, signal } from '@angular/core';
import { Session } from './session';
import { GitHubError } from './github/client';
import { Project, RepoInfo, fetchRepo, fetchRepoProjects, filterAssignable } from './github/api';
import { Role, TeamConfig, allLogins, canEditTeam, parseConfig, rolesFor } from './config/team-config';
import { LabelSpec, missingLabels } from './config/labels';

export type ConfigState =
  | { kind: 'missing' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'ok'; config: TeamConfig; raw: Record<string, unknown>; warnings: string[] };

export type LoadState = { status: 'idle' | 'loading' | 'ready' } | { status: 'error'; error: GitHubError };

const REFRESH_AFTER_MS = 30_000;

/** The selected testbank repo, its config and what the signed-in user can do in it. */
@Injectable({ providedIn: 'root' })
export class Workspace {
  private readonly session = inject(Session);

  readonly repo = signal<RepoInfo | null>(null);
  readonly load = signal<LoadState>({ status: 'idle' });
  readonly projects = signal<Project[]>([]);
  readonly projectsError = signal<GitHubError | null>(null);
  /** Lowercased logins from the config that aren't assignable users of the repo (TC-5). */
  readonly unassignable = signal<Set<string>>(new Set());

  private loadedAt = 0;
  private inFlight: Promise<void> | null = null;

  readonly configState = computed<ConfigState>(() => {
    const text = this.repo()?.configText ?? null;
    if (text === null) return { kind: 'missing' };
    const parsed = parseConfig(text);
    return parsed.ok
      ? { kind: 'ok', config: parsed.config, raw: parsed.raw, warnings: parsed.warnings }
      : { kind: 'invalid', errors: parsed.errors };
  });

  readonly config = computed(() => {
    const s = this.configState();
    return s.kind === 'ok' ? s.config : null;
  });

  readonly roles = computed<Role[]>(() => {
    const config = this.config();
    const login = this.session.viewer()?.login;
    return config && login ? rolesFor(config, login) : [];
  });

  readonly isViewerOnly = computed(() => this.roles().length === 0);
  readonly canWriteRepo = computed(() => {
    const p = this.repo()?.viewerPermission;
    return p === 'ADMIN' || p === 'MAINTAIN' || p === 'WRITE';
  });
  readonly canEditTeam = computed(() => this.canWriteRepo() && canEditTeam(this.roles()));
  readonly missingLabels = computed<LabelSpec[]>(() => missingLabels(this.repo()?.labelNames ?? []));
  readonly needsSetup = computed(
    () => this.configState().kind === 'missing' || this.missingLabels().length > 0,
  );

  constructor() {
    // TC-6: pick up config changes when people come back to the tab.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.refreshIfStale();
      });
    }
  }

  isCurrent(owner: string, name: string): boolean {
    const r = this.repo();
    return !!r && r.nameWithOwner.toLowerCase() === `${owner}/${name}`.toLowerCase();
  }

  /** Loads a repo. Resolves once repo + config are in; projects and validation follow. */
  open(owner: string, name: string, force = false): Promise<void> {
    if (!force && this.isCurrent(owner, name) && this.load().status === 'ready') return Promise.resolve();
    if (!this.isCurrent(owner, name)) {
      this.repo.set(null);
      this.projects.set([]);
      this.projectsError.set(null);
      this.unassignable.set(new Set());
    }
    this.load.set({ status: 'loading' });
    this.inFlight = this.fetchAll(owner, name).finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  reload(): Promise<void> {
    const r = this.repo();
    return r ? this.open(r.owner, r.name, true) : Promise.resolve();
  }

  private refreshIfStale(): void {
    const r = this.repo();
    if (r && !this.inFlight && Date.now() - this.loadedAt > REFRESH_AFTER_MS) {
      void this.fetchAll(r.owner, r.name, true);
    }
  }

  private async fetchAll(owner: string, name: string, quiet = false): Promise<void> {
    const gh = this.session.requireClient();
    try {
      const repo = await fetchRepo(gh, owner, name);
      this.repo.set(repo);
      this.loadedAt = Date.now();
      this.load.set({ status: 'ready' });
    } catch (e) {
      if (!quiet) this.load.set({ status: 'error', error: asGitHubError(e) });
      return;
    }
    // Secondary data: failures here don't block the app.
    void fetchRepoProjects(gh, owner, name).then(
      (p) => {
        this.projects.set(p);
        this.projectsError.set(null);
      },
      (e: unknown) => this.projectsError.set(asGitHubError(e)),
    );
    void this.validateLogins(owner, name);
  }

  async validateLogins(owner: string, name: string): Promise<void> {
    const config = this.config();
    if (!config) return;
    const logins = allLogins(config.team);
    try {
      const ok = await filterAssignable(this.session.requireClient(), owner, name, logins);
      this.unassignable.set(new Set(logins.map((l) => l.toLowerCase()).filter((l) => !ok.has(l))));
    } catch {
      this.unassignable.set(new Set());
    }
  }
}

export function asGitHubError(e: unknown): GitHubError {
  return e instanceof GitHubError ? e : new GitHubError('network', (e as Error)?.message ?? String(e));
}

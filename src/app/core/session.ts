import { Injectable, computed, signal } from '@angular/core';
import { TokenStore } from './auth/token-store';
import { GitHubClient, GitHubError } from './github/client';
import { Viewer, fetchViewer } from './github/api';
import { setLoginAvatar } from './avatar';

/** Tokens for sample-data mode; never sent anywhere (the demo's fetch answers them). */
export const DEMO_TOKEN_PREFIX = 'demo:';

/** Scopes a classic PAT needs. Fine-grained tokens report no scopes and are checked by use. */
export const REQUIRED_SCOPES = ['repo', 'project'];

export type SessionState =
  | { status: 'signed-out' }
  | { status: 'checking' }
  | { status: 'signed-in'; viewer: Viewer; missingScopes: string[] };

/** Holds the token, the GitHub client built from it and who it belongs to (ON-1, ON-2, ON-5). */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly store = new TokenStore(localStorage, sessionStorage);
  private readonly token = signal<string | null>(this.store.get());
  readonly state = signal<SessionState>({ status: this.token() ? 'checking' : 'signed-out' });

  /** Sample-data mode (NV-3): the in-memory GitHub's fetch, loaded on demand. */
  private readonly demoFetch = signal<((url: string, init?: RequestInit) => Promise<Response>) | null>(null);
  readonly isDemo = computed(() => this.token()?.startsWith(DEMO_TOKEN_PREFIX) ?? false);

  readonly client = computed(() => {
    const t = this.token();
    if (!t) return null;
    if (t.startsWith(DEMO_TOKEN_PREFIX)) {
      const f = this.demoFetch();
      return f ? new GitHubClient(t, f) : null;
    }
    return new GitHubClient(t);
  });
  readonly viewer = computed(() => {
    const s = this.state();
    return s.status === 'signed-in' ? s.viewer : null;
  });

  private restoring: Promise<void> | null = null;

  /** Validates a stored token once per page load. Called by the auth guard. */
  restore(): Promise<void> {
    if (!this.restoring) {
      this.restoring = this.token()
        ? this.loadDemoIfNeeded().then(() => this.verify()).catch((e: unknown) => {
            // Keep the token on network errors so a flaky connection doesn't sign people out.
            if (e instanceof GitHubError && e.kind === 'auth') this.signOut();
            else this.state.set({ status: 'signed-out' });
          })
        : Promise.resolve();
    }
    return this.restoring;
  }

  /** Checks a new token against GitHub and stores it on success. Throws GitHubError on failure. */
  async signIn(token: string, forgetOnClose: boolean): Promise<void> {
    const trimmed = token.trim();
    const client = new GitHubClient(trimmed);
    const viewer = await fetchViewer(client);
    this.store.set(trimmed, forgetOnClose);
    this.token.set(trimmed);
    this.state.set({ status: 'signed-in', viewer, missingScopes: missingScopes(client.scopes) });
    this.restoring = Promise.resolve();
  }

  /** Signs in to the sample data as one of the sample people (NV-3). */
  async signInDemo(login: string): Promise<void> {
    const token = DEMO_TOKEN_PREFIX + login;
    await this.loadDemo(); // before the token, so there's never a demo token without a client
    this.token.set(token);
    this.store.set(token, true);
    await this.verify();
    this.restoring = Promise.resolve();
  }

  private async loadDemoIfNeeded(): Promise<void> {
    if (this.token()?.startsWith(DEMO_TOKEN_PREFIX)) await this.loadDemo();
  }

  private async loadDemo(): Promise<void> {
    if (this.demoFetch()) return;
    const demo = await import('./demo/demo');
    const { fakeAvatar } = await import('./demo/fake-github');
    setLoginAvatar(fakeAvatar);
    this.demoFetch.set(demo.demoGitHub().fetch);
  }

  signOut(): void {
    if (this.isDemo()) setLoginAvatar(null);
    this.store.clear();
    this.token.set(null);
    this.state.set({ status: 'signed-out' });
    this.restoring = Promise.resolve();
  }

  requireClient(): GitHubClient {
    const c = this.client();
    if (!c) throw new GitHubError('auth', 'Not signed in.');
    return c;
  }

  private async verify(): Promise<void> {
    const client = this.requireClient();
    this.state.set({ status: 'checking' });
    const viewer = await fetchViewer(client);
    this.state.set({ status: 'signed-in', viewer, missingScopes: missingScopes(client.scopes) });
  }
}

function missingScopes(scopes: string[] | null): string[] {
  if (scopes === null) return []; // fine-grained token
  // `repo` implies its sub-scopes; `project` also satisfies `read:project` needs.
  return REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
}

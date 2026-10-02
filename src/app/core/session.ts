import { Injectable, computed, signal } from '@angular/core';
import { TokenStore } from './auth/token-store';
import { GitHubClient, GitHubError } from './github/client';
import { Viewer, fetchViewer } from './github/api';

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

  readonly client = computed(() => {
    const t = this.token();
    return t ? new GitHubClient(t) : null;
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
        ? this.verify().catch((e: unknown) => {
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

  signOut(): void {
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

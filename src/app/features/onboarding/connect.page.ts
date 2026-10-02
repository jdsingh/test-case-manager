import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Session } from '../../core/session';
import { asGitHubError } from '../../core/workspace';
import { lastRepoUrl } from '../../core/last-repo';

const CLASSIC_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=repo,project&description=Test%20Case%20Manager';
const FINE_GRAINED_URL = 'https://github.com/settings/personal-access-tokens/new';

/** Onboarding step 1: paste a personal access token (ON-1, ON-2). */
@Component({
  selector: 'app-connect-page',
  imports: [FormsModule],
  template: `
    <main class="page-narrow stack">
      <div class="stack" style="gap: 6px">
        <h1>Connect to GitHub</h1>
        <p class="muted">
          Test Case Manager keeps everything in GitHub Issues. It needs a personal access token to
          read and write them for you. The token stays in this browser and is only sent to GitHub.
        </p>
      </div>

      <section class="card stack">
        <h2>1. Create a token</h2>
        <p>
          <a class="btn btn-primary" [href]="classicUrl" target="_blank" rel="noopener">
            Create a classic token on GitHub
          </a>
        </p>
        <p class="muted small">
          The link pre-selects the two scopes the app needs: <code>repo</code> (issues, labels and
          files in the testbank repo) and <code>project</code> (feature boards). Pick an expiry, then
          click <em>Generate token</em> and copy it.
        </p>
        <details class="small">
          <summary>Prefer a fine-grained token?</summary>
          <p class="muted">
            <a [href]="fineGrainedUrl" target="_blank" rel="noopener">Create a fine-grained token</a>
            limited to the testbank repo, with Issues, Contents and Pull requests set to
            <em>Read and write</em>. If the feature boards belong to an organization, also give
            Projects <em>Read and write</em>. Fine-grained tokens can't reach boards owned by a
            personal account, so use a classic token in that case.
          </p>
        </details>
      </section>

      <form class="card stack" (ngSubmit)="connect()">
        <h2>2. Paste it here</h2>
        <label class="field">
          Personal access token
          <input
            type="password"
            name="token"
            autocomplete="off"
            spellcheck="false"
            placeholder="ghp_… or github_pat_…"
            [(ngModel)]="token"
            [disabled]="busy()"
            required
          />
        </label>
        <label class="row small">
          <input type="checkbox" name="forget" [(ngModel)]="forgetOnClose" />
          Forget the token when this tab closes
        </label>
        @if (error()) {
          <div class="banner banner-bad" role="alert">{{ error() }}</div>
        }
        <div class="row">
          <button class="btn btn-primary" type="submit" [disabled]="busy() || !token.trim()">
            @if (busy()) {
              <span class="spinner" aria-hidden="true"></span> Checking…
            } @else {
              Connect
            }
          </button>
        </div>
      </form>
    </main>
  `,
})
export class ConnectPage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly classicUrl = CLASSIC_TOKEN_URL;
  protected readonly fineGrainedUrl = FINE_GRAINED_URL;
  protected token = '';
  protected forgetOnClose = false;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  async connect(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.signIn(this.token, this.forgetOnClose);
      this.token = '';
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      await this.router.navigateByUrl(safeReturnUrl(returnUrl) ?? lastRepoUrl() ?? '/repos');
    } catch (e) {
      const err = asGitHubError(e);
      this.error.set(
        err.kind === 'auth'
          ? 'GitHub rejected this token. Check that you copied all of it and that it has not expired.'
          : err.message,
      );
    } finally {
      this.busy.set(false);
    }
  }
}

/** Only same-app paths, so a crafted link can't bounce the user elsewhere. */
function safeReturnUrl(url: string | null): string | null {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/connect') ? url : null;
}

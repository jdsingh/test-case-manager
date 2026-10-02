import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Session } from '../../core/session';
import { Workspace, asGitHubError } from '../../core/workspace';
import { CONFIG_PATH, createLabel } from '../../core/github/api';
import { ROLES, ROLE_LABELS, Role, newConfigText } from '../../core/config/team-config';
import { SaveResult, saveConfigFile } from '../../core/config/save-config';

/** One-click repo bootstrap: labels + team config (ON-4, Team settings "first setup"). */
@Component({
  selector: 'app-setup-page',
  imports: [RouterLink],
  template: `
    <main class="page-narrow stack">
      <div class="stack" style="gap: 6px">
        <h1>Set up {{ ws.repo()?.nameWithOwner }}</h1>
        <p class="muted">The app needs a few labels and a team config file in the repo before it can be used.</p>
      </div>

      @if (!ws.canWriteRepo()) {
        <div class="banner banner-warn">
          You have read-only access to this repo, so you can't set it up. Ask someone with write
          access to open the app once and run setup.
        </div>
      } @else if (ws.repo()?.isEmpty) {
        <div class="banner banner-warn">
          This repo has no commits yet. Add a README on GitHub first, then
          <button class="btn btn-link" type="button" (click)="ws.reload()">check again</button>.
        </div>
      } @else {
        <section class="card stack">
          <div class="check">
            <span [class]="ws.missingLabels().length ? 'dot todo' : 'dot done'" aria-hidden="true"></span>
            <div>
              <strong>Labels</strong>
              <div class="muted small">
                @if (ws.missingLabels().length) {
                  {{ ws.missingLabels().length }} labels will be created for priority, platform and status.
                } @else {
                  All labels are in place.
                }
              </div>
            </div>
          </div>

          <div class="check">
            <span [class]="configMissing() ? 'dot todo' : 'dot done'" aria-hidden="true"></span>
            <div class="stack" style="gap: 8px">
              <div>
                <strong>Team config</strong>
                <div class="muted small">
                  @if (configMissing()) {
                    <code>{{ configPath }}</code> will be created with you on the team.
                  } @else {
                    <code>{{ configPath }}</code> exists.
                  }
                </div>
              </div>
              @if (configMissing()) {
                <fieldset class="roles">
                  <legend class="small">Your role(s)</legend>
                  @for (role of roles; track role) {
                    <label class="row small">
                      <input type="checkbox" [checked]="picked().includes(role)" (change)="toggle(role)" />
                      {{ roleLabels[role] }}
                    </label>
                  }
                </fieldset>
              }
            </div>
          </div>
        </section>

        @if (error()) {
          <div class="banner banner-bad" role="alert">{{ error() }}</div>
        }
        @if (pr(); as p) {
          <div class="banner banner-warn" role="status">
            <div>
              The default branch is protected, so the config was proposed in
              <a [href]="p.url" target="_blank" rel="noopener">pull request #{{ p.number }}</a>.
              Merge it, then
              <button class="btn btn-link" type="button" (click)="ws.reload()">reload</button>.
            </div>
          </div>
        }

        <div class="row">
          <button class="btn btn-primary" type="button" (click)="run()" [disabled]="busy() || !canRun()">
            @if (busy()) {
              <span class="spinner" aria-hidden="true"></span> {{ progress() }}
            } @else {
              Set up repo
            }
          </button>
          @if (!ws.needsSetup()) {
            <a class="btn" routerLink="../settings/team">Continue to Team settings</a>
          }
        </div>
      }
    </main>
  `,
  styles: `
    .check {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-top: 6px;
      flex: none;
    }
    .dot.todo {
      background: var(--warn);
    }
    .dot.done {
      background: var(--good);
    }
    .roles {
      border: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
    }
    .roles legend {
      padding: 0;
      margin-bottom: 4px;
      font-weight: 500;
    }
  `,
})
export class SetupPage {
  protected readonly ws = inject(Workspace);
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  protected readonly roles = ROLES;
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly configPath = CONFIG_PATH;
  protected readonly picked = signal<Role[]>(['pm']);
  protected readonly busy = signal(false);
  protected readonly progress = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly pr = signal<Extract<SaveResult, { kind: 'pull-request' }> | null>(null);

  protected readonly configMissing = computed(() => this.ws.configState().kind === 'missing');
  protected readonly canRun = computed(
    () => this.ws.needsSetup() && (!this.configMissing() || this.picked().length > 0),
  );

  protected toggle(role: Role): void {
    this.picked.update((p) => (p.includes(role) ? p.filter((r) => r !== role) : [...p, role]));
  }

  protected async run(): Promise<void> {
    const repo = this.ws.repo();
    const viewer = this.session.viewer();
    if (!repo || !viewer) return;
    const gh = this.session.requireClient();
    this.busy.set(true);
    this.error.set(null);
    try {
      const labels = this.ws.missingLabels();
      for (const [i, label] of labels.entries()) {
        this.progress.set(`Creating labels (${i + 1}/${labels.length})…`);
        try {
          await createLabel(gh, repo.id, label);
        } catch (e) {
          // Someone may have created it meanwhile; anything else is a real error.
          if (!/already exists|taken/i.test(asGitHubError(e).message)) throw e;
        }
      }
      if (this.configMissing()) {
        this.progress.set('Creating team config…');
        const schemaUrl = new URL('config.schema.json', document.baseURI).href;
        const result = await saveConfigFile(
          gh,
          repo,
          newConfigText(schemaUrl, viewer.login, this.picked()),
          'Set up Test Case Manager',
          'Creates the team config. Edit the team in the app under Team settings.',
        );
        if (result.kind === 'pull-request') this.pr.set(result);
      }
      await this.ws.reload();
      if (!this.ws.needsSetup()) {
        await this.router.navigate(['/r', repo.owner, repo.name, 'settings', 'team']);
      }
    } catch (e) {
      const err = asGitHubError(e);
      this.error.set(
        err.kind === 'conflict'
          ? 'The repo changed while setting up. Reload and try again.'
          : err.kind === 'forbidden'
            ? `GitHub refused the change: ${err.message}`
            : err.message,
      );
    } finally {
      this.busy.set(false);
    }
  }
}

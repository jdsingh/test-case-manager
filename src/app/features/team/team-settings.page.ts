import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { Session } from '../../core/session';
import { Workspace, asGitHubError } from '../../core/workspace';
import { CONFIG_PATH, GitHubUser } from '../../core/github/api';
import {
  Platform,
  ROLES,
  ROLE_LABELS,
  Role,
  TeamDraft,
  applyChanges,
  canEditTeam,
  commitHeadline,
  describeChanges,
  diffDrafts,
  draftFrom,
  includesLogin,
  rolesFor,
  serializeConfig,
} from '../../core/config/team-config';
import { SaveResult, saveConfigFile } from '../../core/config/save-config';
import { AddPerson } from './add-person';

/** Team settings: edit who holds each role without touching JSON (PRD 5.1a). */
@Component({
  selector: 'app-team-settings-page',
  imports: [AddPerson],
  template: `
    <main class="page stack">
      <div class="row">
        <div class="stack" style="gap: 2px">
          <h1>Team settings</h1>
          <span class="muted small">{{ ws.repo()?.nameWithOwner }} · {{ configPath }}</span>
        </div>
        <span class="spacer"></span>
        <a class="small" [href]="editUrl()" target="_blank" rel="noopener">Edit in GitHub</a>
      </div>

      @if (!editable()) {
        <div class="banner" role="status">
          Only the PM and tech lead can change the team here. Anyone with write access can still edit
          the file on GitHub.
        </div>
      }
      @if (notice(); as n) {
        <div [class]="'banner banner-' + n.tone" role="status">
          <span>{{ n.text }}</span>
          @if (n.link) {
            <a [href]="n.link.url" target="_blank" rel="noopener">{{ n.link.label }}</a>
          }
        </div>
      }

      @if (draft(); as d) {
        <div class="cards">
          @for (role of roles; track role) {
            <section class="card role" [attr.aria-labelledby]="'role-' + role">
              <h2 class="role-name" [id]="'role-' + role">{{ roleLabels[role] }}</h2>
              <ul class="chips" role="list">
                @for (login of d.team[role]; track login) {
                  <li
                    class="chip"
                    [class.added]="isAdded(role, login)"
                    [class.problem]="isUnassignable(login)"
                    [title]="isUnassignable(login) ? login + ' has no access to this repo and can\\'t be assigned' : ''"
                  >
                    <img class="avatar" [src]="'https://github.com/' + login + '.png?size=44'" alt="" />
                    <span>{{ login }}</span>
                    @if (isUnassignable(login)) {
                      <span class="warn-tag">no access</span>
                    }
                    @if (editable()) {
                      <button
                        class="x"
                        type="button"
                        [attr.aria-label]="'Remove ' + login + ' from ' + roleLabels[role]"
                        (click)="remove(role, login)"
                      >
                        ×
                      </button>
                    }
                  </li>
                } @empty {
                  <li class="muted small">Nobody yet.</li>
                }
              </ul>
              @if (editable()) {
                <app-add-person
                  [roleLabel]="roleLabels[role]"
                  [exclude]="d.team[role]"
                  (picked)="add(role, $event)"
                />
              }
            </section>
          }
        </div>

        <section class="row reviewers">
          <span class="label">Default reviewer</span>
          @for (p of platforms; track p.id) {
            <label class="row small">
              <span class="sr-only">Default {{ p.name }} reviewer</span>
              <select [disabled]="!editable()" (change)="setDefault(p.id, $any($event.target).value)">
                <option value="" [selected]="!d.defaultReviewer[p.id]">{{ p.name }}: none</option>
                @for (login of d.team[p.id]; track login) {
                  <option [value]="login" [selected]="login === d.defaultReviewer[p.id]">
                    {{ p.name }}: {{ login }}
                  </option>
                }
              </select>
            </label>
          }
        </section>

        @if (editable()) {
          <footer class="footer">
            <span class="muted small" aria-live="polite">
              @if (changes().length) {
                {{ changes().length }} unsaved {{ changes().length === 1 ? 'change' : 'changes' }}:
                {{ summary() }}
              } @else {
                No unsaved changes.
              }
            </span>
            <span class="spacer"></span>
            <button class="btn" type="button" (click)="discard()" [disabled]="!changes().length || saving()">
              Discard
            </button>
            <button class="btn btn-primary" type="button" (click)="save()" [disabled]="!changes().length || saving()">
              @if (saving()) {
                <span class="spinner" aria-hidden="true"></span> Saving…
              } @else {
                Save changes
              }
            </button>
          </footer>
        }
      } @else {
        <p class="muted">The team config isn't available. Fix the problem above, or run setup.</p>
      }
    </main>
  `,
  styles: `
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
    }
    .role {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 140px;
    }
    .role-name {
      font-size: 14px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 6px 0 4px;
      border-radius: 15px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      font-weight: 500;
    }
    .chip.added {
      background: var(--accent-soft);
      border: 1.5px solid var(--accent);
    }
    .chip.problem {
      border-color: var(--warn);
    }
    .warn-tag {
      font-size: 11px;
      color: var(--warn);
    }
    .x {
      border: none;
      background: none;
      color: var(--text-2);
      font-size: 16px;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 50%;
      cursor: pointer;
    }
    .x:hover {
      color: var(--bad);
    }
    .reviewers {
      flex-wrap: wrap;
      gap: 12px;
    }
    .reviewers .label {
      font-weight: 500;
    }
    .reviewers select {
      min-width: 200px;
    }
    .footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
  `,
})
export class TeamSettingsPage {
  protected readonly ws = inject(Workspace);
  private readonly session = inject(Session);

  protected readonly roles = ROLES;
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly configPath = CONFIG_PATH;
  protected readonly platforms: { id: Platform; name: string }[] = [
    { id: 'android', name: 'Android' },
    { id: 'ios', name: 'iOS' },
  ];

  /** What the file held when loaded; the baseline for "unsaved changes". */
  private readonly original = signal<TeamDraft | null>(null);
  protected readonly draft = signal<TeamDraft | null>(null);
  protected readonly saving = signal(false);
  protected readonly notice = signal<{
    tone: 'good' | 'warn' | 'bad';
    text: string;
    link?: { url: string; label: string };
  } | null>(null);

  protected readonly editable = computed(() => this.ws.canEditTeam());
  protected readonly changes = computed(() => {
    const o = this.original();
    const d = this.draft();
    return o && d ? diffDrafts(o, d) : [];
  });
  protected readonly summary = computed(() => describeChanges(this.changes()));

  constructor() {
    // Follow the loaded config, but never clobber unsaved edits.
    effect(() => {
      const config = this.ws.config();
      untracked(() => {
        if (!config) {
          this.original.set(null);
          this.draft.set(null);
        } else if (!this.changes().length) {
          this.original.set(draftFrom(config));
          this.draft.set(draftFrom(config));
        }
      });
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  protected warnOnLeave(e: BeforeUnloadEvent): void {
    if (this.changes().length) e.preventDefault();
  }

  protected editUrl(): string {
    const r = this.ws.repo();
    return r ? `https://github.com/${r.nameWithOwner}/edit/${r.defaultBranch ?? 'HEAD'}/${CONFIG_PATH}` : '#';
  }

  protected isAdded(role: Role, login: string): boolean {
    const o = this.original();
    return !!o && !includesLogin(o.team[role], login);
  }

  protected isUnassignable(login: string): boolean {
    return this.ws.unassignable().has(login.toLowerCase());
  }

  protected add(role: Role, user: GitHubUser): void {
    this.notice.set(null);
    this.update((d) => applyChanges(d, [{ op: 'add', role, login: user.login }]));
  }

  protected remove(role: Role, login: string): void {
    this.notice.set(null);
    this.update((d) => applyChanges(d, [{ op: 'remove', role, login }]));
  }

  protected setDefault(platform: Platform, login: string): void {
    this.update((d) => applyChanges(d, [{ op: 'setDefaultReviewer', platform, login: login || null }]));
  }

  protected discard(): void {
    this.draft.set(this.original());
    this.notice.set(null);
  }

  protected async save(): Promise<void> {
    const draft = this.draft();
    const repo = this.ws.repo();
    const state = this.ws.configState();
    const me = this.session.viewer()?.login;
    if (!draft || !repo || state.kind !== 'ok' || !me) return;

    const changes = this.changes();
    const myRolesAfter = rolesFor({ ...state.config, team: draft.team }, me);
    if (
      !canEditTeam(myRolesAfter) &&
      !confirm('After this change you will no longer be PM or tech lead, so you won\'t be able to edit the team. Save anyway?')
    ) {
      return;
    }

    this.saving.set(true);
    this.notice.set(null);
    try {
      const result: SaveResult = await saveConfigFile(
        this.session.requireClient(),
        repo,
        serializeConfig(state.raw, draft),
        commitHeadline(changes),
        `${describeChanges(changes)}.\n\nSaved from Test Case Manager.`,
      );
      if (result.kind === 'committed') {
        this.original.set(draft);
        this.notice.set({ tone: 'good', text: 'Saved.', link: { url: result.url, label: 'View commit' } });
        await this.ws.reload();
      } else {
        this.notice.set({
          tone: 'warn',
          text: `The default branch is protected, so your changes were proposed in pull request #${result.number}. They apply once it's merged.`,
          link: { url: result.url, label: 'Open pull request' },
        });
      }
    } catch (e) {
      const err = asGitHubError(e);
      if (err.kind === 'conflict') await this.reapplyAfterConflict(changes);
      else this.notice.set({ tone: 'bad', text: `Couldn't save: ${err.message}` });
    } finally {
      this.saving.set(false);
    }
  }

  /** Someone saved first: load their version and put this user's edits back on top. */
  private async reapplyAfterConflict(changes: ReturnType<typeof diffDrafts>): Promise<void> {
    await this.ws.reload();
    const fresh = this.ws.config();
    if (!fresh) {
      this.notice.set({ tone: 'bad', text: 'Someone else changed the config and it can no longer be read.' });
      return;
    }
    const base = draftFrom(fresh);
    this.original.set(base);
    this.draft.set(applyChanges(base, changes));
    this.notice.set({
      tone: 'warn',
      text: 'Someone else saved the team while you were editing. Their changes are loaded and yours are re-applied on top. Check them and save again.',
    });
  }

  private update(fn: (d: TeamDraft) => TeamDraft): void {
    const d = this.draft();
    if (d) this.draft.set(fn(d));
  }
}


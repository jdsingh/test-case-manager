import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { Session } from '../../core/session';
import { Workspace } from '../../core/workspace';
import { GitHubUser, searchAssignableUsers } from '../../core/github/api';
import { includesLogin } from '../../core/config/team-config';
import { avatarAt } from '../../core/avatar';

let nextId = 0;

/** "+ Add person": a combobox over the repo's assignable users (TC-4). */
@Component({
  selector: 'app-add-person',
  template: `
    @if (!open()) {
      <button class="btn btn-link small" type="button" (click)="start()">+ Add person</button>
    } @else {
      <div class="combo">
        <input
          #box
          type="search"
          role="combobox"
          aria-autocomplete="list"
          [attr.aria-expanded]="results().length > 0"
          [attr.aria-controls]="listId"
          [attr.aria-activedescendant]="results().length ? listId + '-' + active() : null"
          [attr.aria-label]="'Add to ' + roleLabel()"
          placeholder="Search people with access…"
          (input)="onInput(box.value)"
          (keydown)="onKey($event)"
          (blur)="onBlur()"
        />
        @if (loading()) {
          <span class="spinner combo-spin" aria-hidden="true"></span>
        }
        @if (results().length) {
          <ul class="options" role="listbox" [id]="listId">
            @for (u of results(); track u.login; let i = $index) {
              <li
                role="option"
                [id]="listId + '-' + i"
                [attr.aria-selected]="i === active()"
                [class.active]="i === active()"
                (mousedown)="$event.preventDefault(); pick(u)"
              >
                <img class="avatar" [src]="sized(u.avatarUrl)" alt="" />
                <span class="login">{{ u.login }}</span>
                @if (u.name) {
                  <span class="muted small">{{ u.name }}</span>
                }
              </li>
            }
          </ul>
        } @else if (searched() && !loading()) {
          <div class="options empty muted small">No one with access matches.</div>
        }
      </div>
    }
  `,
  styles: `
    .combo {
      position: relative;
      max-width: 280px;
    }
    .combo-spin {
      position: absolute;
      right: 10px;
      top: 9px;
    }
    .options {
      position: absolute;
      z-index: 5;
      left: 0;
      right: 0;
      top: 40px;
      margin: 0;
      padding: 4px;
      list-style: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .options li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    .options li.active {
      background: var(--accent-soft);
    }
    .login {
      font-weight: 500;
    }
    .empty {
      padding: 8px 10px;
    }
  `,
})
export class AddPerson {
  private readonly session = inject(Session);
  private readonly ws = inject(Workspace);

  readonly roleLabel = input.required<string>();
  /** Logins already in the role, hidden from results. */
  readonly exclude = input<string[]>([]);
  readonly picked = output<GitHubUser>();

  protected readonly sized = (url: string) => avatarAt(url, 44);
  protected readonly listId = `add-person-${nextId++}`;
  protected readonly open = signal(false);
  protected readonly results = signal<GitHubUser[]>([]);
  protected readonly active = signal(0);
  protected readonly loading = signal(false);
  protected readonly searched = signal(false);
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  /** The query the current results answer. */
  private lastQuery: string | null = null;

  protected start(): void {
    this.open.set(true);
    setTimeout(() => this.box()?.nativeElement.focus());
    void this.search('');
  }

  protected onInput(q: string): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.search(q.trim()), 200);
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      this.active.set((this.active() + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      this.active.set((this.active() - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void this.pickOnEnter();
    } else if (e.key === 'Escape') {
      this.close();
    }
  }

  /** Never pick from results that predate what was typed: finish the search first. */
  private async pickOnEnter(): Promise<void> {
    const q = this.box()?.nativeElement.value.trim() ?? '';
    if (q !== this.lastQuery) {
      clearTimeout(this.timer);
      await this.search(q);
    }
    const u = this.results()[this.active()];
    if (u) this.pick(u);
  }

  protected onBlur(): void {
    setTimeout(() => this.close(), 100);
  }

  protected pick(u: GitHubUser): void {
    this.picked.emit(u);
    this.close();
  }

  private close(): void {
    clearTimeout(this.timer);
    this.open.set(false);
    this.results.set([]);
    this.searched.set(false);
    this.active.set(0);
    this.lastQuery = null;
  }

  private async search(q: string): Promise<void> {
    const repo = this.ws.repo();
    if (!repo) return;
    const mine = ++this.seq;
    this.loading.set(true);
    try {
      const users = await searchAssignableUsers(this.session.requireClient(), repo.owner, repo.name, q);
      if (mine !== this.seq) return; // a newer search is in flight
      this.results.set(users.filter((u) => !includesLogin(this.exclude(), u.login)));
      this.lastQuery = q;
      this.active.set(0);
      this.searched.set(true);
    } catch {
      if (mine === this.seq) this.results.set([]);
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }
}

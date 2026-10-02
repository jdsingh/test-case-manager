import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { Workspace } from '../../core/workspace';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { STATUS_LABELS } from '../../core/testcase/model';

interface Command {
  id: string;
  group: 'Actions' | 'Test cases' | 'Features';
  label: string;
  hint?: string;
  run: () => void;
}

/** Cmd/Ctrl-K: jump to any case, feature or action (NV-1). */
@Component({
  selector: 'app-command-palette',
  template: `
    <dialog #dlg class="palette" aria-label="Command palette" (close)="open.set(false)" (click)="onBackdrop($event)">
      @if (open()) {
      <input
        #box
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        [attr.aria-activedescendant]="results().length ? 'cmd-' + active() : null"
        placeholder="Jump to a test case, feature or action…"
        [value]="q()"
        (input)="q.set($any($event.target).value); active.set(0)"
        (keydown)="onKey($event)"
      />
      <ul id="palette-list" role="listbox">
        @for (c of results(); track c.id; let i = $index) {
          @if (i === 0 || results()[i - 1].group !== c.group) {
            <li class="group" role="presentation">{{ c.group }}</li>
          }
          <li
            role="option"
            [id]="'cmd-' + i"
            [attr.aria-selected]="i === active()"
            [class.on]="i === active()"
            (mousemove)="active.set(i)"
            (click)="choose(c)"
          >
            <span>{{ c.label }}</span>
            @if (c.hint) {
              <span class="muted small">{{ c.hint }}</span>
            }
          </li>
        } @empty {
          <li class="empty muted small">Nothing matches.</li>
        }
      </ul>
      <div class="foot muted small"><span class="kbd">↑</span><span class="kbd">↓</span> move · <span class="kbd">Enter</span> open · <span class="kbd">Esc</span> close</div>
      }
    </dialog>
  `,
  styles: `
    .palette { width: min(620px, 94vw); padding: 0; margin-top: 12vh; overflow: hidden; }
    input { border: none; border-bottom: 1px solid var(--border); border-radius: 0; height: 48px; padding: 0 16px; font-size: 15px; }
    input:focus { outline: none; }
    ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow: auto; }
    li[role='option'] { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 6px; cursor: pointer; }
    li.on { background: var(--accent-soft); }
    .group { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-2); padding: 8px 10px 4px; }
    .empty { padding: 12px; }
    .foot { border-top: 1px solid var(--border); padding: 8px 14px; display: flex; gap: 4px; align-items: center; }
  `,
})
export class CommandPalette {
  private readonly ws = inject(Workspace);
  private readonly features = inject(FeatureSelection);
  private readonly cases = inject(CasesStore);
  private readonly router = inject(Router);
  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');
  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');

  protected readonly open = signal(false);
  protected readonly q = signal('');
  protected readonly active = signal(0);

  private readonly commands = computed<Command[]>(() => {
    const repo = this.ws.repo();
    if (!repo) return [];
    const base = ['/r', repo.owner, repo.name];
    const feature = this.features.selected();
    const go = (...path: (string | number)[]) => () =>
      void this.router.navigate([...base, ...path], { queryParams: feature ? { feature } : {} });
    const write = this.ws.canWriteRepo() && !this.ws.isViewerOnly();
    const actions: Command[] = [
      { id: 'a-cases', group: 'Actions', label: 'Test cases', run: go('cases') },
      ...(write
        ? [
            { id: 'a-new', group: 'Actions' as const, label: 'New test case', hint: 'N on the list', run: go('cases', 'new') },
            { id: 'a-import', group: 'Actions' as const, label: 'Import from a sheet or Gherkin', run: go('cases', 'import') },
            { id: 'a-bank', group: 'Actions' as const, label: 'Add from the regression bank', run: go('cases', 'bank') },
            { id: 'a-session', group: 'Actions' as const, label: 'Start a test session', run: go('session') },
          ]
        : []),
      { id: 'a-review', group: 'Actions', label: 'Review queue', run: go('review') },
      { id: 'a-inbox', group: 'Actions', label: 'Inbox', run: go('inbox') },
      { id: 'a-dash', group: 'Actions', label: 'Dashboard', run: go('dashboard') },
      { id: 'a-team', group: 'Actions', label: 'Team settings', run: go('settings', 'team') },
      { id: 'a-repo', group: 'Actions', label: 'Switch repo', run: () => void this.router.navigateByUrl('/repos') },
    ];
    const cases: Command[] = this.cases.openCases().map((c) => ({
      id: `c-${c.number}`,
      group: 'Test cases',
      label: `#${c.number} ${c.title}`,
      hint: [c.priority, c.status ? STATUS_LABELS[c.status] : null].filter(Boolean).join(' · '),
      run: go('cases', c.number),
    }));
    const feats: Command[] = this.ws
      .projects()
      .filter((p) => !p.closed)
      .map((p) => ({
        id: `f-${p.number}`,
        group: 'Features',
        label: p.title,
        hint: String(p.number) === feature ? 'current' : 'switch to',
        run: () => void this.router.navigate([...base, 'cases'], { queryParams: { feature: p.number } }),
      }));
    return [...actions, ...cases, ...feats];
  });

  protected readonly results = computed(() => {
    const q = this.q().trim().toLowerCase();
    if (!q) {
      const all = this.commands();
      return [...all.filter((c) => c.group === 'Actions'), ...all.filter((c) => c.group === 'Test cases').slice(0, 10), ...all.filter((c) => c.group === 'Features')];
    }
    const words = q.split(/\s+/);
    const num = /^#?(\d+)$/.exec(q)?.[1];
    return this.commands()
      .filter((c) => (num ? c.id === `c-${num}` : words.every((w) => c.label.toLowerCase().includes(w))))
      .slice(0, 40);
  });

  @HostListener('document:keydown', ['$event'])
  protected onGlobalKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (this.open()) this.close();
      else this.show();
    }
  }

  show(): void {
    if (!this.ws.repo()) return;
    this.q.set('');
    this.active.set(0);
    this.open.set(true);
    this.dlg()?.nativeElement.showModal();
    setTimeout(() => this.box()?.nativeElement.focus());
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
      const c = this.results()[this.active()];
      if (c) this.choose(c);
    }
  }

  protected choose(c: Command): void {
    this.close();
    c.run();
  }

  protected onBackdrop(e: MouseEvent): void {
    if (e.target === this.dlg()?.nativeElement) this.close();
  }

  private close(): void {
    this.dlg()?.nativeElement.close();
    this.open.set(false);
  }
}

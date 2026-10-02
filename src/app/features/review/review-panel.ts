import { Component, ElementRef, HostListener, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { CasesStore } from '../../core/testcase/cases-store';
import { Session } from '../../core/session';
import { Workspace, asGitHubError } from '../../core/workspace';
import { PLATFORM_NAMES, TestCase } from '../../core/testcase/model';
import { CaseHistory, Decision, canReview } from '../../core/testcase/review';

/** Approve or request changes (RV-2, RV-3), with A / R shortcuts when `shortcuts` is on (LR-3). */
@Component({
  selector: 'app-review-panel',
  template: `
    @if (check(); as c) {
      @if (c.ok) {
        <section class="panel stack" aria-label="Your review">
          <div class="row">
            <strong>Your review</strong>
            <span class="muted small">recorded for {{ platformName(c.platform) }}</span>
          </div>
          <textarea
            #note
            rows="3"
            aria-label="Review comment"
            placeholder="Optional for an approval; required when requesting changes"
            [value]="noteText()"
            (input)="noteText.set($any($event.target).value)"
          ></textarea>
          @if (error()) {
            <div class="banner banner-bad small" role="alert">{{ error() }}</div>
          }
          <div class="row">
            <button class="btn btn-primary" type="button" (click)="decide('approve')" [disabled]="busy()">
              Approve @if (shortcuts()) { <span class="kbd on-accent">A</span> }
            </button>
            <button class="btn" type="button" (click)="decide('request_changes')" [disabled]="busy()">
              Request changes @if (shortcuts()) { <span class="kbd">R</span> }
            </button>
            @if (busy()) { <span class="spinner" aria-hidden="true"></span> }
          </div>
        </section>
      } @else if (showReason()) {
        <p class="muted small">{{ c.reason }}</p>
      }
    }
  `,
  styles: `
    .panel { padding: 14px; border: 1px solid var(--accent); border-radius: var(--radius); background: var(--accent-soft); gap: 10px; }
    .on-accent { color: var(--accent-text); border-color: var(--accent-text); }
  `,
})
export class ReviewPanel {
  private readonly store = inject(CasesStore);
  private readonly session = inject(Session);
  private readonly ws = inject(Workspace);
  private readonly noteBox = viewChild<ElementRef<HTMLTextAreaElement>>('note');

  readonly tc = input.required<TestCase>();
  readonly history = input.required<CaseHistory>();
  readonly shortcuts = input(false);
  /** Show why the user can't review (on the detail page); hidden in review mode. */
  readonly showReason = input(false);
  readonly decided = output<Decision>();

  protected readonly noteText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly check = computed(() =>
    canReview(this.tc(), this.history(), this.ws.config(), this.session.viewer()?.login ?? ''),
  );

  protected platformName(p: 'android' | 'ios'): string {
    return PLATFORM_NAMES[p];
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (!this.shortcuts() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      void this.decide('approve');
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      void this.decide('request_changes');
    }
  }

  async decide(decision: Decision): Promise<void> {
    const c = this.check();
    if (!c.ok || this.busy()) return;
    if (decision === 'request_changes' && !this.noteText().trim()) {
      this.error.set('Say what needs to change before requesting changes.');
      this.noteBox()?.nativeElement.focus();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.review(this.tc(), decision, this.noteText(), c.platform);
      this.noteText.set('');
      this.decided.emit(decision);
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}

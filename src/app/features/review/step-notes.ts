import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CasesStore } from '../../core/testcase/cases-store';
import { Workspace, asGitHubError } from '../../core/workspace';
import { TestCase } from '../../core/testcase/model';
import { LineNote, isApplied, isOutdated } from '../../core/testcase/review';
import { timeAgo } from '../../core/time';

/**
 * The scenario as Gherkin, one row per step, with step comments inline (LR-1) and
 * suggested wording that can be accepted in one click (LR-2).
 */
@Component({
  selector: 'app-step-notes',
  template: `
    <div class="gherkin steps" role="list" aria-label="Scenario steps">
      <div class="line"><span class="kw">Scenario:</span> {{ tc().title }}</div>
      @for (s of tc().steps; track $index; let i = $index) {
        <div class="step" role="listitem">
          <div class="line" [class.has-notes]="notesFor(i).length" [class.and]="s.keyword === 'And'">
            <span class="kw">{{ s.keyword }}</span> {{ s.text }}
            @if (canComment() && openStep() !== i) {
              <button class="add" type="button" (click)="open(i)" [attr.aria-label]="'Comment on step ' + (i + 1)" title="Comment on this step">
                💬
              </button>
            }
          </div>
          @for (n of notesFor(i); track n.id) {
            <div class="note" [class.outdated]="outdated(n)">
              <div class="small">
                <strong>{{ n.author }}</strong>
                <span class="muted"> · {{ ago(n.createdAt) }}</span>
                @if (applied(n)) {
                  <span class="tag good">applied</span>
                } @else if (outdated(n)) {
                  <span class="tag">outdated</span>
                }
              </div>
              @if (n.note) {
                <div class="text">{{ n.note }}</div>
              }
              @if (n.suggestion !== null && !applied(n)) {
                <div class="suggestion">
                  <span class="muted small">Suggested:</span> {{ n.suggestion }}
                  @if (canAccept() && !outdated(n)) {
                    <button class="btn btn-link small" type="button" (click)="accept(n)" [disabled]="busy()">Accept suggestion</button>
                  }
                </div>
              }
            </div>
          }
          @if (openStep() === i) {
            <form class="compose" (submit)="$event.preventDefault(); send(i, noteBox.value, suggestBox.value)">
              <textarea #noteBox rows="2" placeholder="Comment on this step" aria-label="Comment"></textarea>
              <label class="small row">
                <input type="checkbox" [checked]="suggesting()" (change)="suggesting.set(!suggesting())" />
                Suggest new wording
              </label>
              <input #suggestBox type="text" [hidden]="!suggesting()" [value]="s.text" aria-label="Suggested wording" />
              <div class="row">
                <button class="btn btn-primary" type="submit" [disabled]="busy()">Comment</button>
                <button class="btn" type="button" (click)="openStep.set(null)">Cancel</button>
              </div>
            </form>
          }
        </div>
      }
    </div>
    @if (error()) {
      <div class="banner banner-bad small" role="alert">{{ error() }}</div>
    }
  `,
  styles: `
    .steps { white-space: normal; display: flex; flex-direction: column; gap: 2px; }
    .line { white-space: pre-wrap; position: relative; padding-right: 32px; border-radius: 4px; }
    .line:hover { background: color-mix(in srgb, var(--accent) 6%, transparent); }
    .line.has-notes { background: color-mix(in srgb, var(--warn) 10%, transparent); }
    .step > .line { padding-left: 2ch; }
    .step > .line.and { padding-left: 4ch; }
    .add { position: absolute; right: 2px; top: 0; border: none; background: none; cursor: pointer; opacity: 0; font-size: 13px; }
    .line:hover .add, .add:focus-visible { opacity: 1; }
    .note, .compose { font-family: var(--font); font-size: 13px; margin: 4px 0 8px 4ch; padding: 8px 10px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); }
    .note.outdated { opacity: 0.7; }
    .text { white-space: pre-wrap; }
    .suggestion { margin-top: 4px; }
    .tag { margin-left: 6px; font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--surface-2); color: var(--text-2); }
    .tag.good { background: var(--good-soft); color: var(--good); }
    .compose { display: flex; flex-direction: column; gap: 6px; }
  `,
})
export class StepNotes {
  private readonly store = inject(CasesStore);
  private readonly ws = inject(Workspace);

  readonly tc = input.required<TestCase>();
  readonly notes = input<LineNote[]>([]);
  /** Accepting suggestions edits the case: offered to the PM and the case's author. */
  readonly canAccept = input(false);
  readonly changed = output<void>();

  protected readonly openStep = signal<number | null>(null);
  protected readonly suggesting = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly ago = (iso: string) => timeAgo(iso);

  protected readonly canComment = computed(() => this.ws.canWriteRepo() && !this.ws.isViewerOnly() && !this.tc().closed);

  protected notesFor(i: number): LineNote[] {
    // Notes stay on the step they were made on (or the last step if steps were removed).
    const last = this.tc().steps.length - 1;
    return this.notes().filter((n) => Math.min(n.step, last) === i);
  }

  protected outdated(n: LineNote): boolean {
    return isOutdated(n, this.tc());
  }

  protected applied(n: LineNote): boolean {
    return isApplied(n, this.tc());
  }

  protected open(i: number): void {
    this.openStep.set(i);
    this.suggesting.set(false);
  }

  protected async send(step: number, note: string, suggestion: string): Promise<void> {
    const suggest = this.suggesting() && suggestion.trim() && suggestion.trim() !== this.tc().steps[step]?.text ? suggestion.trim() : undefined;
    if (!note.trim() && !suggest) return;
    await this.run(async () => {
      await this.store.commentOnStep(this.tc(), step, note, suggest);
      this.openStep.set(null);
    });
  }

  protected async accept(n: LineNote): Promise<void> {
    await this.run(() => this.store.applySuggestion(this.tc(), n));
  }

  private async run(fn: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
      this.changed.emit();
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}

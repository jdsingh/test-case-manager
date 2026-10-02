import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { Workspace, asGitHubError } from '../../core/workspace';
import { CasesStore } from '../../core/testcase/cases-store';
import { PRIORITIES, Platform } from '../../core/config/team-config';
import { Keyword, Step, parseGherkin, sectionsOf, validateScenario } from '../../core/testcase/gherkin';
import {
  PLATFORM_NAMES,
  TestCase,
  TestCaseDraft,
  describeEdit,
  draftOf,
  emptyDraft,
  isScenarioChange,
} from '../../core/testcase/model';
import { buildStepLibrary, findSimilar } from '../../core/testcase/library';
import { writingHints } from '../../core/testcase/hints';
import { GherkinView } from './badges';
import { Toasts } from '../../core/toast';
import { CommentNode } from '../../core/github/api';
import { LineNote, historyOf, isApplied, isOutdated } from '../../core/testcase/review';
import { includesLogin } from '../../core/config/team-config';

const KEYWORDS: Keyword[] = ['Given', 'When', 'Then', 'And'];

/** Create or edit a test case (AU-1, AU-2, AU-8, SL-1, SL-2). */
@Component({
  selector: 'app-case-editor-page',
  imports: [RouterLink, GherkinView],
  template: `
    <main class="page stack">
      <a class="small back" routerLink=".." queryParamsHandling="preserve">
        ← {{ editing() ? 'Back to the test case' : 'Test cases' }}
      </a>
      <h1>{{ editing() ? 'Edit #' + editing()!.number : 'New test case' }}</h1>

      @if (error()) {
        <div class="banner banner-bad" role="alert">{{ error() }}</div>
      }

      @if (ready()) {
        <div class="layout">
          <form class="stack" (submit)="$event.preventDefault(); save(false)" novalidate>
            <label class="field">
              Scenario name
              <input
                type="text"
                name="title"
                autocomplete="off"
                placeholder="e.g. Guest checkout with saved card"
                [value]="draft().title"
                (input)="patch({ title: $any($event.target).value })"
              />
            </label>

            <div class="row wrap gap16">
              <fieldset class="seg-field">
                <legend>Priority</legend>
                <div class="seg" role="radiogroup" aria-label="Priority">
                  @for (p of priorities; track p) {
                    <button
                      type="button"
                      role="radio"
                      [attr.aria-checked]="draft().priority === p"
                      [class.on]="draft().priority === p"
                      (click)="patch({ priority: p })"
                    >
                      {{ p }}
                    </button>
                  }
                </div>
              </fieldset>
              <fieldset class="seg-field">
                <legend>Platforms</legend>
                <div class="row gap12">
                  @for (p of platforms; track p) {
                    <label class="row">
                      <input type="checkbox" [checked]="draft().platforms.includes(p)" (change)="togglePlatform(p)" />
                      {{ platformNames[p] }}
                    </label>
                  }
                </div>
              </fieldset>
            </div>

            <label class="field">
              Preconditions <span class="muted small">(optional: setup, accounts, test data)</span>
              <textarea
                name="preconditions"
                rows="2"
                [value]="draft().preconditions"
                (input)="patch({ preconditions: $any($event.target).value })"
              ></textarea>
            </label>

            <div class="stack" style="gap: 8px">
              <div class="row">
                <strong>Steps</strong>
                <span class="spacer"></span>
                <button class="btn btn-link small" type="button" (click)="pasteMode.set(!pasteMode())">
                  {{ pasteMode() ? 'Edit step by step' : 'Paste Gherkin instead' }}
                </button>
              </div>

              @if (pasteMode()) {
                <textarea
                  #paste
                  class="mono"
                  rows="8"
                  aria-label="Gherkin text"
                  placeholder="Scenario: Guest checkout&#10;  Given a guest user with one item in the cart&#10;  When the user taps Pay&#10;  Then the order confirmation shows"
                ></textarea>
                <div class="row">
                  <button class="btn" type="button" (click)="usePasted(paste.value)">Use these steps</button>
                  @if (pasteError()) {
                    <span class="small bad">{{ pasteError() }}</span>
                  }
                </div>
              } @else {
                <ol class="steps">
                  @for (s of draft().steps; track $index; let i = $index) {
                    <li class="step" [class.and]="s.keyword === 'And'">
                      <select
                        [attr.aria-label]="'Step ' + (i + 1) + ' keyword'"
                        (change)="setKeyword(i, $any($event.target).value)"
                      >
                        @for (k of keywords; track k) {
                          <option [value]="k" [selected]="k === s.keyword">{{ k }}</option>
                        }
                      </select>
                      <div class="field-wrap">
                        <input
                          #stepInput
                          type="text"
                          autocomplete="off"
                          role="combobox"
                          aria-autocomplete="list"
                          [attr.aria-expanded]="activeStep() === i && suggestions().length > 0"
                          [attr.aria-controls]="'sugg-' + i"
                          [attr.aria-activedescendant]="activeStep() === i && suggestIndex() >= 0 ? 'sugg-' + i + '-' + suggestIndex() : null"
                          [attr.aria-label]="'Step ' + (i + 1) + ' text'"
                          [value]="s.text"
                          (focus)="activeStep.set(i); suggestIndex.set(-1)"
                          (blur)="onStepBlur(i)"
                          (input)="setText(i, $any($event.target).value)"
                          (keydown)="stepKey($event, i)"
                        />
                        @if (activeStep() === i && suggestions().length) {
                          <ul class="sugg-list" role="listbox" [id]="'sugg-' + i" [attr.aria-label]="'Steps used before'">
                            @for (m of suggestions(); track m.text; let j = $index) {
                              <li
                                role="option"
                                [id]="'sugg-' + i + '-' + j"
                                [attr.aria-selected]="j === suggestIndex()"
                                [class.on]="j === suggestIndex()"
                                (mousedown)="$event.preventDefault(); acceptSuggestion(i, m.text)"
                              >
                                <span>{{ m.text }}</span>
                                <span class="muted small">used in {{ m.count }}</span>
                              </li>
                            }
                          </ul>
                        }
                      </div>
                      <div class="step-actions">
                        <button type="button" class="icon" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'Move step ' + (i + 1) + ' up'">↑</button>
                        <button type="button" class="icon" [disabled]="i === draft().steps.length - 1" (click)="move(i, 1)" [attr.aria-label]="'Move step ' + (i + 1) + ' down'">↓</button>
                        <button type="button" class="icon" (click)="remove(i)" [attr.aria-label]="'Remove step ' + (i + 1)">×</button>
                      </div>
                    </li>
                  }
                </ol>
                <div class="row small">
                  <span class="muted">Add:</span>
                  @for (k of keywords; track k) {
                    <button class="btn btn-link small" type="button" (click)="add(k)">+ {{ k }}</button>
                  }
                  <span class="spacer"></span>
                  <span class="muted"><span class="kbd">Enter</span> adds an And step</span>
                </div>
              }
            </div>

            @if (attempted() && problems().length) {
              <div class="banner banner-bad" role="alert">
                <ul>
                  @for (p of problems(); track p) {
                    <li>{{ p }}</li>
                  }
                </ul>
              </div>
            }

            @if (hints().length) {
              <div class="banner tips" role="note" aria-label="Writing tips">
                <div>
                  <strong class="small">Tips so reviewers can approve it first time</strong>
                  <ul class="small">
                    @for (h of hints(); track h.text + h.step) {
                      <li>@if (h.step !== null) {<strong>Step {{ h.step + 1 }}:</strong>&nbsp;}{{ h.text }}</li>
                    }
                  </ul>
                </div>
              </div>
            }

            @if (similar().length) {
              <div class="banner banner-warn" role="status">
                <div>
                  <strong>This looks like an existing test case.</strong>
                  <ul>
                    @for (s of similar(); track s.testCase.number) {
                      <li>
                        <a [routerLink]="['/r', repoOwner(), repoName(), 'cases', s.testCase.number]" queryParamsHandling="preserve" target="_blank">
                          #{{ s.testCase.number }} {{ s.testCase.title }}
                        </a>
                        <span class="muted small">
                          ({{ pct(s.score) }} similar{{ s.testCase.regression ? ', in the regression bank' : '' }})
                        </span>
                      </li>
                    }
                  </ul>
                </div>
              </div>
            }

            @if (backToReview()) {
              <div class="banner" role="status">
                This case has been reviewed. Saving a change to its scenario sends it back to review
                {{ reviewerNote() }}.
              </div>
            }

            <div class="row footer">
              @if (editing()?.status === 'changes-requested') {
                <button class="btn btn-primary" type="button" (click)="saveAndResubmit()" [disabled]="saving()">
                  @if (saving()) { <span class="spinner" aria-hidden="true"></span> }
                  Save and resubmit
                </button>
                <button class="btn" type="submit" [disabled]="saving() || !dirty()">Save only</button>
                @if (resubmitTo().length) {
                  <span class="muted small">to {{ resubmitTo().join(', ') }}</span>
                }
              } @else if (editing()) {
                <button class="btn btn-primary" type="submit" [disabled]="saving() || !dirty()">
                  @if (saving()) { <span class="spinner" aria-hidden="true"></span> }
                  Save changes
                </button>
              } @else {
                <button class="btn" type="submit" [disabled]="saving()">Save draft</button>
                <button class="btn btn-primary" type="button" [disabled]="saving() || !submitTo().length" (click)="save(true)">
                  @if (saving()) { <span class="spinner" aria-hidden="true"></span> }
                  Save and submit for review
                </button>
                @if (submitTo().length) {
                  <span class="muted small">to {{ submitTo().join(', ') }}</span>
                }
              }
              <span class="spacer"></span>
              <a class="btn" routerLink=".." queryParamsHandling="preserve">Cancel</a>
            </div>
          </form>

          <aside class="preview stack" aria-label="Preview">
            @if (request(); as r) {
              <section class="ask stack" aria-label="Requested changes">
                <strong class="small">{{ r.author }} asked for changes</strong>
                @if (r.note) {
                  <p class="small">{{ r.note }}</p>
                }
                @for (n of openNotes(); track n.id) {
                  <div class="small note">
                    <span class="muted">Step {{ n.step + 1 }} · {{ n.author }}:</span> {{ n.note || 'Suggested new wording.' }}
                    @if (n.suggestion !== null) {
                      <div class="sugg">“{{ n.suggestion }}”</div>
                      <button class="btn btn-link small" type="button" (click)="useSuggestion(n)" [disabled]="!canUse(n)">
                        {{ canUse(n) ? 'Use suggestion' : 'Step changed' }}
                      </button>
                    }
                  </div>
                }
              </section>
            }
            <span class="muted small">Preview</span>
            <app-gherkin [name]="draft().title || 'Untitled scenario'" [steps]="draft().steps" />
            <p class="muted small">
              {{ draft().priority }} · {{ platformText() }}
              @if (draft().preconditions.trim()) {
                · preconditions set
              }
            </p>
          </aside>
        </div>

      } @else if (!error()) {
        <div class="row muted"><span class="spinner" aria-hidden="true"></span> Loading…</div>
      }
    </main>
  `,
  styles: `
    .back { text-decoration: none; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 340px); gap: 28px; align-items: start; }
    @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
    .preview { position: sticky; top: 72px; }
    .tips { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
    .ask { padding: 12px; border-radius: var(--radius); background: var(--bad-soft); border: 1px solid color-mix(in srgb, var(--bad) 35%, transparent); gap: 6px; }
    .ask .note { padding-top: 6px; border-top: 1px solid color-mix(in srgb, var(--bad) 20%, transparent); }
    .sugg { font-style: italic; margin: 2px 0; }
    .wrap { flex-wrap: wrap; }
    .gap16 { gap: 16px; align-items: flex-start; }
    .gap12 { gap: 12px; }
    fieldset { border: none; margin: 0; padding: 0; }
    legend { font-weight: 500; margin-bottom: 6px; padding: 0; }
    .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
    .seg button { border: none; background: var(--surface); color: var(--text-2); font: inherit; font-weight: 600; padding: 0 14px; height: 34px; cursor: pointer; }
    .seg button + button { border-left: 1px solid var(--border); }
    .seg button.on { background: var(--accent); color: var(--accent-text); }
    .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .step { display: grid; grid-template-columns: 96px 1fr auto; gap: 6px; align-items: center; }
    .step.and { padding-left: 24px; grid-template-columns: 72px 1fr auto; }
    .step select { font-weight: 600; }
    .step-actions { display: flex; }
    .field-wrap { position: relative; }
    .sugg-list { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); margin: 0; padding: 4px; list-style: none; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .sugg-list li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .sugg-list li.on, .sugg-list li:hover { background: var(--accent-soft); }
    .icon { border: none; background: none; color: var(--text-2); width: 26px; height: 30px; border-radius: 6px; cursor: pointer; font-size: 15px; }
    .icon:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
    .icon:disabled { opacity: 0.3; cursor: default; }
    .mono { font-family: var(--mono); font-size: 13px; }
    .bad { color: var(--bad); }
    .footer { padding-top: 12px; border-top: 1px solid var(--border); }
  `,
})
export class CaseEditorPage {
  private readonly ws = inject(Workspace);
  private readonly store = inject(CasesStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly toasts = inject(Toasts);
  private readonly stepInputs = viewChildren<ElementRef<HTMLInputElement>>('stepInput');

  protected readonly priorities = PRIORITIES;
  protected readonly platforms: Platform[] = ['android', 'ios'];
  protected readonly platformNames = PLATFORM_NAMES;
  protected readonly keywords = KEYWORDS;
  protected readonly sectionNames = ['Given', 'When', 'Then'] as const;

  private readonly number = toSignal(
    this.route.paramMap.pipe(map((p) => (p.get('number') ? Number(p.get('number')) : null))),
    { requireSync: true },
  );
  protected readonly editing = signal<TestCase | null>(null);
  private readonly original = signal<TestCaseDraft>(emptyDraft());
  protected readonly draft = signal<TestCaseDraft>(emptyDraft());
  protected readonly ready = signal(false);
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pasteMode = signal(false);
  protected readonly pasteError = signal<string | null>(null);
  private saved = false;

  protected readonly sections = computed(() => sectionsOf(this.draft().steps));
  protected readonly problems = computed(() => {
    const d = this.draft();
    const p = validateScenario({ name: d.title, steps: d.steps });
    if (!d.platforms.length) p.push('Pick at least one platform.');
    return p;
  });
  protected readonly library = computed(() => buildStepLibrary(this.store.cases()));
  protected readonly hints = computed(() => writingHints(this.draft()));
  protected readonly similar = computed(() => findSimilar(this.draft(), this.store.cases(), this.editing()?.number));
  protected readonly dirty = computed(() => describeEdit(this.original(), this.draft()).length > 0);
  protected readonly platformText = computed(
    () => this.draft().platforms.map((p) => PLATFORM_NAMES[p]).join(' + ') || 'no platform',
  );
  protected readonly submitTo = computed(() =>
    this.store.suggestReviewers({ platforms: this.draft().platforms, author: null }),
  );
  protected readonly backToReview = computed(() => {
    const tc = this.editing();
    const reviewed = !!tc && ['approved', 'passed', 'failed', 'blocked'].includes(tc.status ?? '');
    return reviewed && isScenarioChange(this.original(), this.draft());
  });
  protected readonly reviewerNote = computed(() => {
    const r = this.store.suggestReviewers({ platforms: this.draft().platforms, author: null });
    return r.length ? `and assigns it to ${r.join(', ')}` : '';
  });
  /** Comments on the case being edited, for the change request panel. */
  private readonly comments = signal<CommentNode[]>([]);
  private readonly history = computed(() => historyOf(this.comments()));
  protected readonly request = computed(() => {
    if (this.editing()?.status !== 'changes-requested') return null;
    const r = [...this.history().reviews].reverse().find((x) => x.decision === 'request_changes' && x.current);
    return r ? { author: r.author, note: r.note } : null;
  });
  protected readonly openNotes = computed(() => {
    const tc = this.editing();
    return tc ? this.history().lineNotes.filter((n) => !isOutdated(n, tc) && !isApplied(n, tc)) : [];
  });
  /** Back to whoever asked for the changes, if they can still review it. */
  protected readonly resubmitTo = computed(() => {
    const asked = this.request()?.author;
    const eligible = this.store.eligibleReviewers(this.draft().platforms);
    if (asked && includesLogin(eligible, asked)) return [asked];
    return this.store.suggestReviewers({ platforms: this.draft().platforms, author: null });
  });

  protected canUse(n: LineNote): boolean {
    const step = this.draft().steps[n.step];
    return !!step && step.text.trim() === n.original.trim() && n.suggestion !== null;
  }

  protected useSuggestion(n: LineNote): void {
    if (!this.canUse(n)) return;
    this.updateSteps((steps) => steps.map((s, i) => (i === n.step ? { ...s, text: n.suggestion! } : s)));
  }

  protected async saveAndResubmit(): Promise<void> {
    this.attempted.set(true);
    if (this.problems().length) return;
    const tc = this.editing();
    if (!tc) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const saved = await this.store.save(tc, this.cleaned());
      await this.store.submit(saved, this.resubmitTo());
      this.saved = true;
      this.toasts.show(`Saved and resubmitted to ${this.resubmitTo().join(', ') || 'review'}.`);
      await this.router.navigate(['..'], { relativeTo: this.route, queryParamsHandling: 'preserve' });
    } catch (e) {
      this.error.set(`Couldn't save: ${asGitHubError(e).message}`);
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly repoOwner = computed(() => this.ws.repo()?.owner ?? '');
  protected readonly repoName = computed(() => this.ws.repo()?.name ?? '');

  constructor() {
    effect(() => {
      const n = this.number();
      untracked(() => void this.init(n));
    });
  }

  /** For the unsaved-changes guard. */
  canLeave(): boolean {
    return this.saved || !this.dirty() || confirm('Discard your unsaved changes?');
  }

  @HostListener('window:beforeunload', ['$event'])
  protected warnOnLeave(e: BeforeUnloadEvent): void {
    if (!this.saved && this.dirty()) e.preventDefault();
  }

  protected patch(p: Partial<TestCaseDraft>): void {
    this.draft.update((d) => ({ ...d, ...p }));
  }

  protected togglePlatform(p: Platform): void {
    const list = this.draft().platforms;
    this.patch({ platforms: (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]).sort() as Platform[] });
  }

  protected setKeyword(i: number, k: Keyword): void {
    this.updateSteps((s) => s.map((x, j) => (j === i ? { ...x, keyword: k } : x)));
  }

  protected setText(i: number, text: string): void {
    this.suggestIndex.set(-1);
    this.suggestionsClosedSig.set(false);
    this.updateSteps((s) => s.map((x, j) => (j === i ? { ...x, text } : x)));
  }

  protected add(k: Keyword): void {
    this.insertAt(this.draft().steps.length, k);
  }

  protected move(i: number, delta: number): void {
    this.updateSteps((s) => {
      const next = [...s];
      [next[i], next[i + delta]] = [next[i + delta], next[i]];
      return next;
    });
  }

  protected remove(i: number): void {
    this.updateSteps((s) => s.filter((_, j) => j !== i));
  }

  /** The step being typed in, for its suggestions (SL-1). */
  protected readonly activeStep = signal<number | null>(null);
  protected readonly suggestIndex = signal(-1);

  /** Steps already used in this section that match what's typed, most used first. */
  protected readonly suggestions = computed(() => {
    const i = this.activeStep();
    if (i === null || this.suggestionsClosedSig()) return [];
    const typed = (this.draft().steps[i]?.text ?? '').trim().toLowerCase();
    if (typed.length < 2) return [];
    const words = typed.split(/\s+/);
    const pool = this.library()[this.sections()[i] ?? 'Given'];
    return pool
      .filter((s) => s.text.toLowerCase() !== typed && words.every((w) => s.text.toLowerCase().includes(w)))
      .slice(0, 6);
  });
  private readonly suggestionsClosedSig = signal(false);

  protected acceptSuggestion(i: number, text: string): void {
    this.setText(i, text);
    const el = this.stepInputs()[i]?.nativeElement;
    if (el) el.value = text;
    this.suggestionsClosedSig.set(true);
  }

  protected onStepBlur(i: number): void {
    setTimeout(() => {
      if (this.activeStep() === i) this.activeStep.set(null);
    }, 120);
  }

  /** Enter adds an And below; Backspace in an empty step removes it; arrows pick a suggestion. */
  protected stepKey(e: KeyboardEvent, i: number): void {
    const input = e.target as HTMLInputElement;
    const sugg = this.suggestions();
    if (sugg.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = sugg.length;
      this.suggestIndex.set(e.key === 'ArrowDown' ? (this.suggestIndex() + 1) % n : (this.suggestIndex() - 1 + n) % n);
      return;
    }
    if (e.key === 'Escape' && sugg.length) {
      e.preventDefault();
      this.suggestionsClosedSig.set(true);
      return;
    }
    if (e.key === 'Enter' && sugg.length && this.suggestIndex() >= 0) {
      e.preventDefault();
      this.acceptSuggestion(i, sugg[this.suggestIndex()].text);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this.insertAt(i + 1, 'And');
    } else if (e.key === 'Backspace' && !input.value && this.draft().steps.length > 1) {
      e.preventDefault();
      this.remove(i);
      this.focusStep(Math.max(0, i - 1));
    }
  }

  protected usePasted(text: string): void {
    const [scenario] = parseGherkin(text);
    if (!scenario || !scenario.steps.length) {
      this.pasteError.set('No Given/When/Then steps found.');
      return;
    }
    this.pasteError.set(null);
    this.patch({ steps: scenario.steps, ...(scenario.name && !this.draft().title.trim() ? { title: scenario.name } : {}) });
    this.pasteMode.set(false);
  }

  protected pct(score: number): string {
    return `${Math.round(score * 100)}%`;
  }

  protected async save(submit: boolean): Promise<void> {
    this.attempted.set(true);
    if (this.problems().length) return;
    this.saving.set(true);
    this.error.set(null);
    const draft = this.cleaned();
    try {
      const tc = this.editing();
      const result = tc
        ? await this.store.save(tc, draft)
        : await this.store.create(draft, submit ? { submitTo: this.submitTo() } : {});
      this.saved = true;
      this.toasts.show(tc ? 'Saved.' : submit ? `Created #${result.number} and sent it for review.` : `Created #${result.number} as a draft.`);
      const path = tc ? ['..'] : ['..', result.number];
      await this.router.navigate(path, { relativeTo: this.route, queryParamsHandling: 'preserve' });
    } catch (e) {
      this.error.set(`Couldn't save: ${asGitHubError(e).message}`);
    } finally {
      this.saving.set(false);
    }
  }

  private cleaned(): TestCaseDraft {
    const d = this.draft();
    return {
      ...d,
      title: d.title.trim(),
      preconditions: d.preconditions.trim(),
      steps: d.steps.map((s) => ({ keyword: s.keyword, text: s.text.trim() })),
    };
  }

  private insertAt(i: number, k: Keyword): void {
    this.updateSteps((s) => [...s.slice(0, i), { keyword: k, text: '' }, ...s.slice(i)]);
    this.focusStep(i);
  }

  /**
   * Renders the new row right away and focuses it in the same keystroke, so text typed
   * straight after Enter lands in the new step, not the old one.
   */
  private focusStep(i: number): void {
    this.cdr.detectChanges();
    const el = this.stepInputs()[i]?.nativeElement;
    if (el) el.focus();
    else afterNextRender(() => this.stepInputs()[i]?.nativeElement.focus(), { injector: this.injector });
  }

  private updateSteps(fn: (s: Step[]) => Step[]): void {
    this.draft.update((d) => ({ ...d, steps: fn(d.steps) }));
  }

  private async init(n: number | null): Promise<void> {
    this.ready.set(false);
    this.error.set(null);
    try {
      if (n === null) {
        const fromState = (history.state as { draft?: TestCaseDraft } | null)?.draft;
        this.editing.set(null);
        this.original.set(emptyDraft());
        this.draft.set(fromState ? structuredClone(fromState) : emptyDraft());
      } else {
        const { testCase, comments } = await this.store.detail(n);
        this.comments.set(comments);
        const d = draftOf(testCase);
        if (!d.steps.length) d.steps = emptyDraft().steps;
        this.editing.set(testCase);
        this.original.set(draftOf(testCase));
        this.draft.set(d);
      }
      this.ready.set(true);
    } catch (e) {
      this.error.set(asGitHubError(e).message);
    }
  }
}


import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { PRIORITIES, Platform, Priority } from '../../core/config/team-config';
import { PLATFORM_NAMES } from '../../core/testcase/model';
import { parseDelimited } from '../../core/import/csv';
import {
  FIELD_LABELS,
  IMPORT_FIELDS,
  ImportField,
  ImportRow,
  Mapping,
  detectMapping,
  markAgainst,
  rowsFromGherkin,
  rowsFromTable,
} from '../../core/import/import-rows';
import { GherkinView, PlatformBadges, PriorityBadge } from './badges';

type Source = 'sheet' | 'gherkin';

/** Bulk import from a Google Sheet / CSV, or from pasted Gherkin (AU-6, IM-1 to IM-3). */
@Component({
  selector: 'app-import-page',
  imports: [RouterLink, GherkinView, PriorityBadge, PlatformBadges],
  template: `
    <main class="page stack">
      <a class="small back" routerLink=".." queryParamsHandling="preserve">← Test cases</a>
      <div class="stack" style="gap: 4px">
        <h1>Import test cases</h1>
        <p class="muted">
          Into <strong>{{ features.project()?.title ?? 'the selected feature' }}</strong>. Every case is created as a
          Draft, so it still goes through review.
        </p>
      </div>

      <div class="tabs" role="tablist">
        <button role="tab" type="button" [attr.aria-selected]="source() === 'sheet'" [class.on]="source() === 'sheet'" (click)="setSource('sheet')">
          Google Sheet or CSV
        </button>
        <button role="tab" type="button" [attr.aria-selected]="source() === 'gherkin'" [class.on]="source() === 'gherkin'" (click)="setSource('gherkin')">
          Gherkin
        </button>
      </div>

      @if (source() === 'sheet') {
        <section class="stack" style="gap: 8px">
          <label class="field">
            Paste the cells from Google Sheets, including the header row
            <textarea
              class="mono"
              rows="6"
              placeholder="Select the cells in your sheet (with headers), copy, and paste here"
              [value]="text()"
              (input)="setText($any($event.target).value)"
              [disabled]="running()"
            ></textarea>
          </label>
          <div class="row small">
            <span class="muted">or</span>
            <label class="btn small-btn">
              Upload a CSV file
              <input type="file" accept=".csv,.tsv,.txt,text/csv" class="sr-only" (change)="upload($event)" [disabled]="running()" />
            </label>
            @if (fileName()) {
              <span class="muted">{{ fileName() }}</span>
            }
          </div>
        </section>

        @if (headers().length) {
          <section class="card stack">
            <h2>Match the columns</h2>
            <p class="muted small">
              Map either one column of Gherkin steps, or separate Given, When and Then columns. Cells with several lines
              become extra <em>And</em> steps.
            </p>
            <div class="mapping">
              @for (f of fields; track f) {
                <label class="field small">
                  {{ fieldLabels[f] }}
                  <select (change)="setMapping(f, +$any($event.target).value)" [disabled]="running()">
                    <option value="-1" [selected]="mapping()[f] < 0">—</option>
                    @for (h of headers(); track $index) {
                      <option [value]="$index" [selected]="mapping()[f] === $index">{{ h || 'Column ' + ($index + 1) }}</option>
                    }
                  </select>
                </label>
              }
            </div>
          </section>
        }
      } @else {
        <label class="field">
          Paste one or more scenarios. Tags like <code>&#64;P0 &#64;ios</code> above a scenario set its priority and platforms.
          <textarea
            class="mono"
            rows="10"
            [placeholder]="gherkinPlaceholder"
            [value]="text()"
            (input)="setText($any($event.target).value)"
            [disabled]="running()"
          ></textarea>
        </label>
      }

      <section class="row wrap defaults">
        <span class="small"><strong>When a row doesn't say:</strong></span>
        <label class="row small">
          Priority
          <select (change)="defaultPriority.set($any($event.target).value)" [disabled]="running()">
            @for (p of priorities; track p) {
              <option [value]="p" [selected]="p === defaultPriority()">{{ p }}</option>
            }
          </select>
        </label>
        @for (p of platforms; track p) {
          <label class="row small">
            <input type="checkbox" [checked]="defaultPlatforms().includes(p)" (change)="toggleDefaultPlatform(p)" [disabled]="running()" />
            {{ platformNames[p] }}
          </label>
        }
      </section>

      @if (rows().length) {
        <section class="stack">
          <div class="row">
            <h2>Preview</h2>
            <span class="muted small">
              {{ counts().ready }} ready · {{ counts().exists }} already exist · {{ counts().invalid }} need fixing
            </span>
          </div>
          <table class="preview card">
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">Import</span></th>
                <th scope="col">{{ source() === 'sheet' ? 'Row' : '#' }}</th>
                <th scope="col">Test case</th>
                <th scope="col">Priority</th>
                <th scope="col">Platforms</th>
                <th scope="col">Check</th>
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track r.source) {
                <tr [class.dim]="r.state !== 'ready'">
                  <td>
                    <input
                      type="checkbox"
                      [attr.aria-label]="'Import ' + (r.draft.title || 'row ' + r.source)"
                      [checked]="isSelected(r)"
                      [disabled]="r.state !== 'ready' || running()"
                      (change)="toggleRow(r)"
                    />
                  </td>
                  <td class="muted">{{ r.source }}</td>
                  <td>
                    <details>
                      <summary>{{ r.draft.title || '(no name)' }} <span class="muted small">· {{ r.draft.steps.length }} step{{ r.draft.steps.length === 1 ? '' : 's' }}</span></summary>
                      <app-gherkin [name]="r.draft.title" [steps]="r.draft.steps" />
                    </details>
                  </td>
                  <td><app-priority [value]="r.draft.priority" /></td>
                  <td><app-platforms [value]="r.draft.platforms" /></td>
                  <td class="small">
                    @switch (r.state) {
                      @case ('exists') {
                        <span class="muted">Already exists as
                          <a [routerLink]="['..', r.existing!.number]" queryParamsHandling="preserve">#{{ r.existing!.number }}</a></span>
                      }
                      @case ('invalid') {
                        <ul class="problems">
                          @for (p of r.problems; track p) { <li>{{ p }}</li> }
                        </ul>
                      }
                      @default {
                        <span class="ok">Ready</span>
                        @if (r.problems.length) {
                          <ul class="warn">
                            @for (p of r.problems; track p) { <li>{{ p }}</li> }
                          </ul>
                        }
                        @if (r.similar) {
                          <div class="warn">Looks like
                            <a [routerLink]="['..', r.similar.number]" queryParamsHandling="preserve">#{{ r.similar.number }}</a></div>
                        }
                      }
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      } @else if (text().trim()) {
        <p class="muted">Nothing to import yet. {{ source() === 'sheet' ? 'Check that the first row is the header row.' : 'Add a Scenario: line with Given/When/Then steps.' }}</p>
      }

      @if (error()) {
        <div class="banner banner-bad" role="alert">{{ error() }}</div>
      }

      @if (running() || done() !== null) {
        <div class="stack progress-box" role="status" aria-live="polite">
          <div class="bar"><div class="fill" [style.width.%]="percent()"></div></div>
          <span class="small">
            @if (waiting()) {
              GitHub asked us to slow down. Waiting a minute before continuing…
            } @else if (running()) {
              Created {{ progressDone() }} of {{ progressTotal() }}…
            } @else {
              Created {{ done() }} test case{{ done() === 1 ? '' : 's' }} as drafts.
              <a routerLink=".." [queryParams]="{ status: 'draft' }" queryParamsHandling="merge">See the drafts</a>
            }
          </span>
        </div>
      }

      <div class="row footer">
        @if (running()) {
          <button class="btn" type="button" (click)="cancel.set(true)" [disabled]="cancel()">Stop after this one</button>
        } @else {
          <button class="btn btn-primary" type="button" (click)="run()" [disabled]="!selected().length || !features.project()">
            Import {{ selected().length }} as draft{{ selected().length === 1 ? '' : 's' }}
          </button>
        }
        <span class="spacer"></span>
        <a class="btn" routerLink=".." queryParamsHandling="preserve">Back to the list</a>
      </div>
    </main>
  `,
  styles: `
    .back { text-decoration: none; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
    .tabs button { border: none; background: none; font: inherit; font-weight: 500; color: var(--text-2); padding: 8px 12px; border-bottom: 2px solid transparent; cursor: pointer; }
    .tabs button.on { color: var(--accent); border-bottom-color: var(--accent); }
    .mono { font-family: var(--mono); font-size: 12.5px; }
    .small-btn { height: 30px; font-size: 13px; cursor: pointer; }
    .mapping { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .wrap { flex-wrap: wrap; }
    .defaults { gap: 14px; }
    .defaults select { width: auto; height: 30px; }
    .preview { width: 100%; border-collapse: collapse; padding: 0; }
    .preview th { text-align: left; font-size: 12px; color: var(--text-2); padding: 8px 10px; border-bottom: 1px solid var(--border); }
    .preview td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .preview tr.dim td { opacity: 0.75; }
    summary { cursor: pointer; font-weight: 500; }
    details .gherkin { margin-top: 8px; font-size: 12.5px; }
    .problems, .warn { margin: 0; padding-left: 16px; }
    .problems { color: var(--bad); }
    .warn { color: var(--warn); }
    .ok { color: var(--good); font-weight: 600; }
    .progress-box { gap: 6px; }
    .bar { height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.3s; }
    .footer { padding-top: 12px; border-top: 1px solid var(--border); }
  `,
})
export class ImportPage {
  protected readonly features = inject(FeatureSelection);
  private readonly store = inject(CasesStore);

  protected readonly fields = IMPORT_FIELDS;
  protected readonly fieldLabels = FIELD_LABELS;
  protected readonly priorities = PRIORITIES;
  protected readonly platforms: Platform[] = ['android', 'ios'];
  protected readonly platformNames = PLATFORM_NAMES;
  protected readonly gherkinPlaceholder =
    '@P0 @android\nScenario: Pay with Google Pay\n  Given a logged-in user with items in the cart\n  When the user picks Google Pay and confirms\n  Then the order confirmation shows\n\nScenario: …';

  protected readonly source = signal<Source>('sheet');
  protected readonly text = signal('');
  protected readonly fileName = signal<string | null>(null);
  protected readonly defaultPriority = signal<Priority>('P2');
  protected readonly defaultPlatforms = signal<Platform[]>(['android', 'ios']);
  private readonly mappingOverride = signal<Partial<Mapping>>({});
  /** Rows the user unticked, by source line. */
  private readonly unticked = signal<Set<number>>(new Set());

  protected readonly running = signal(false);
  protected readonly waiting = signal(false);
  protected readonly cancel = signal(false);
  protected readonly progressDone = signal(0);
  protected readonly progressTotal = signal(0);
  protected readonly done = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);

  private readonly table = computed(() => (this.source() === 'sheet' ? parseDelimited(this.text()) : []));
  protected readonly headers = computed(() => this.table()[0] ?? []);
  protected readonly mapping = computed<Mapping>(() => ({ ...detectMapping(this.headers()), ...this.mappingOverride() }));

  protected readonly rows = computed<ImportRow[]>(() => {
    const defaults = { priority: this.defaultPriority(), platforms: this.defaultPlatforms() };
    const raw =
      this.source() === 'sheet'
        ? this.table().length > 1
          ? rowsFromTable(this.table(), this.mapping(), defaults)
          : []
        : rowsFromGherkin(this.text(), defaults);
    return markAgainst(raw, this.store.cases());
  });

  protected readonly selected = computed(() =>
    this.rows().filter((r) => r.state === 'ready' && !this.unticked().has(r.source)),
  );
  protected readonly counts = computed(() => {
    const rows = this.rows();
    return {
      ready: rows.filter((r) => r.state === 'ready').length,
      exists: rows.filter((r) => r.state === 'exists').length,
      invalid: rows.filter((r) => r.state === 'invalid').length,
    };
  });
  protected readonly percent = computed(() =>
    this.progressTotal() ? Math.round((this.progressDone() / this.progressTotal()) * 100) : 0,
  );

  @HostListener('window:beforeunload', ['$event'])
  protected warnOnLeave(e: BeforeUnloadEvent): void {
    if (this.running()) e.preventDefault();
  }

  canLeave(): boolean {
    return !this.running() || confirm('The import is still running. Leave anyway? Cases created so far are kept.');
  }

  protected setSource(s: Source): void {
    this.source.set(s);
    this.text.set('');
    this.fileName.set(null);
    this.reset();
  }

  protected setText(t: string): void {
    this.text.set(t);
    this.reset();
  }

  protected async upload(e: Event): Promise<void> {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.fileName.set(file.name);
    this.setText(await file.text());
  }

  protected setMapping(f: ImportField, col: number): void {
    this.mappingOverride.update((m) => ({ ...m, [f]: col }));
  }

  protected toggleDefaultPlatform(p: Platform): void {
    this.defaultPlatforms.update((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p].sort() as Platform[]));
  }

  protected isSelected(r: ImportRow): boolean {
    return r.state === 'ready' && !this.unticked().has(r.source);
  }

  protected toggleRow(r: ImportRow): void {
    this.unticked.update((s) => {
      const next = new Set(s);
      if (next.has(r.source)) next.delete(r.source);
      else next.add(r.source);
      return next;
    });
  }

  protected async run(): Promise<void> {
    const drafts = this.selected().map((r) => r.draft);
    if (!drafts.length) return;
    this.running.set(true);
    this.cancel.set(false);
    this.error.set(null);
    this.done.set(null);
    this.progressDone.set(0);
    this.progressTotal.set(drafts.length);
    const result = await this.store.createMany(
      drafts,
      (p) => {
        this.progressDone.set(p.done);
        this.waiting.set(p.waiting);
      },
      () => this.cancel(),
    );
    this.running.set(false);
    this.waiting.set(false);
    this.done.set(result.created.length);
    if (result.error) {
      this.error.set(
        `Stopped after ${result.created.length} of ${drafts.length}: ${result.error.message} Run the import again to add the rest; cases already created are skipped.`,
      );
    }
  }

  private reset(): void {
    this.mappingOverride.set({});
    this.unticked.set(new Set());
    this.done.set(null);
    this.error.set(null);
  }
}

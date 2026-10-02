import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FeatureSelection } from '../../core/feature-selection';
import { CasesStore } from '../../core/testcase/cases-store';
import { BankStore } from '../../core/testcase/bank-store';
import { bankCandidates, copyStartsApproved } from '../../core/testcase/bank';
import { PRIORITIES, Platform, Priority } from '../../core/config/team-config';
import { TestCase } from '../../core/testcase/model';
import { GherkinView, PlatformBadges, PriorityBadge, StatusBadge } from './badges';

/** RB-2: pick regression cases to reuse in the selected feature. */
@Component({
  selector: 'app-bank-page',
  imports: [RouterLink, PriorityBadge, PlatformBadges, StatusBadge, GherkinView],
  template: `
    <main class="page stack">
      <a class="small back" routerLink=".." queryParamsHandling="preserve">← Test cases</a>
      <div class="stack" style="gap: 4px">
        <h1>Add from the regression bank</h1>
        <p class="muted">
          Reuse cases marked as regression in earlier features. Each one is copied into
          <strong>{{ features.project()?.title ?? 'this feature' }}</strong>; copies of approved cases are ready to run straight away.
        </p>
      </div>

      <div class="filters">
        <input type="search" placeholder="Search the bank" aria-label="Search the bank" [value]="q()" (input)="q.set($any($event.target).value)" />
        <div class="seg" role="group" aria-label="Priority">
          @for (p of priorities; track p) {
            <button type="button" [class.on]="pri() === p" [attr.aria-pressed]="pri() === p" (click)="pri.set(pri() === p ? null : p)">{{ p }}</button>
          }
        </div>
        <select aria-label="Platform" (change)="plat.set($any($event.target).value || null)">
          <option value="">Any platform</option>
          <option value="android">Android</option>
          <option value="ios">iOS</option>
        </select>
      </div>

      @if (bank.loading() && !bank.items().length) {
        <div class="row muted"><span class="spinner" aria-hidden="true"></span> Loading the bank…</div>
      } @else if (bank.error()) {
        <div class="banner banner-bad" role="alert">{{ bank.error() }}</div>
      } @else if (!candidates().length) {
        <section class="card stack">
          <h2>Nothing to add</h2>
          <p class="muted">
            @if (bank.items().length) {
              Every regression case is already in this feature.
            } @else {
              The bank is empty. Open a case worth re-testing every release and choose <em>Add to regression bank</em>.
            }
          </p>
        </section>
      } @else {
        <ul class="list card">
          @for (c of shown(); track c.testCase.number) {
            <li>
              <input type="checkbox" [attr.aria-label]="'Add #' + c.testCase.number" [checked]="picked().has(c.testCase.number)" (change)="toggle(c.testCase.number)" [disabled]="running()" />
              <details>
                <summary>
                  <span class="muted">#{{ c.testCase.number }}</span>&nbsp;<strong>{{ c.testCase.title }}</strong>
                </summary>
                <app-gherkin [name]="c.testCase.title" [steps]="c.testCase.steps" />
              </details>
              <span class="meta">
                <app-priority [value]="c.testCase.priority" />
                <app-platforms [value]="c.testCase.platforms" />
                <app-status [value]="c.testCase.status" />
                <span class="small muted">{{ c.ready ? 'ready to run when copied' : 'needs review when copied' }}</span>
                @if (c.features.length) {
                  <span class="small muted">· from {{ c.features.join(', ') }}</span>
                }
              </span>
            </li>
          }
        </ul>
      }

      @if (error()) {
        <div class="banner banner-bad" role="alert">{{ error() }}</div>
      }
      @if (done() !== null) {
        <div class="banner banner-good" role="status">
          Added {{ done() }} case{{ done() === 1 ? '' : 's' }}.
          <a routerLink=".." queryParamsHandling="preserve">Back to the list</a>
        </div>
      }

      <div class="row footer">
        <button class="btn btn-primary" type="button" (click)="add()" [disabled]="!picked().size || running() || !features.project()">
          @if (running()) { <span class="spinner" aria-hidden="true"></span> Adding {{ progress() }}/{{ picked().size }}… } @else {
            Add {{ picked().size }} to {{ features.project()?.title ?? 'feature' }}
          }
        </button>
        <span class="spacer"></span>
        <a class="btn" routerLink=".." queryParamsHandling="preserve">Cancel</a>
      </div>
    </main>
  `,
  styles: `
    .back { text-decoration: none; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; }
    .filters input { flex: 1 1 240px; width: auto; }
    .filters select { width: auto; }
    .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
    .seg button { border: none; background: var(--surface); color: var(--text-2); font: inherit; font-weight: 600; padding: 0 10px; height: 34px; cursor: pointer; }
    .seg button + button { border-left: 1px solid var(--border); }
    .seg button.on { background: var(--accent-soft); color: var(--accent); }
    .list { list-style: none; margin: 0; padding: 0; }
    .list li { display: grid; grid-template-columns: 24px 1fr; gap: 4px 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); align-items: start; }
    .list li:last-child { border-bottom: none; }
    .list input { margin-top: 4px; }
    .meta { grid-column: 2; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    summary { cursor: pointer; }
    details .gherkin { margin-top: 8px; font-size: 12.5px; }
    .footer { padding-top: 12px; border-top: 1px solid var(--border); }
  `,
})
export class BankPage {
  protected readonly features = inject(FeatureSelection);
  protected readonly bank = inject(BankStore);
  private readonly store = inject(CasesStore);

  protected readonly priorities = PRIORITIES;
  protected readonly q = signal('');
  protected readonly pri = signal<Priority | null>(null);
  protected readonly plat = signal<Platform | null>(null);
  protected readonly picked = signal<Set<number>>(new Set());
  protected readonly running = signal(false);
  protected readonly progress = signal(0);
  protected readonly done = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly candidates = computed(() => {
    const allowed = new Set(bankCandidates(this.bank.bankCases(), this.store.cases()).map((c) => c.number));
    return this.bank
      .items()
      .filter((i) => allowed.has(i.testCase.number))
      .map((i) => ({ ...i, ready: copyStartsApproved(i.testCase) }));
  });

  protected readonly shown = computed(() => {
    const q = this.q().trim().toLowerCase();
    return this.candidates()
      .filter((c) => !this.pri() || c.testCase.priority === this.pri())
      .filter((c) => !this.plat() || c.testCase.platforms.includes(this.plat()!))
      .filter((c) => !q || c.testCase.title.toLowerCase().includes(q) || c.testCase.steps.some((s) => s.text.toLowerCase().includes(q)));
  });

  constructor() {
    void this.bank.ensure();
  }

  protected toggle(n: number): void {
    this.picked.update((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  protected async add(): Promise<void> {
    const sources = this.candidates()
      .filter((c) => this.picked().has(c.testCase.number))
      .map((c) => c.testCase) as TestCase[];
    this.running.set(true);
    this.progress.set(0);
    this.error.set(null);
    this.done.set(null);
    const res = await this.store.copyFromBank(sources, (n) => this.progress.set(n));
    this.running.set(false);
    this.done.set(res.created.length);
    this.picked.set(new Set());
    if (res.error) this.error.set(`Stopped after ${res.created.length}: ${res.error.message}`);
  }
}

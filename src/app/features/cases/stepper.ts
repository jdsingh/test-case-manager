import { Component, computed, input } from '@angular/core';
import { TestCase } from '../../core/testcase/model';

type StepState = 'done' | 'current' | 'todo' | 'problem';

interface Step {
  label: string;
  state: StepState;
  note?: string;
}

/** Where a case is in its life: Draft → In review → Approved → Running → Passed (UX 5). */
@Component({
  selector: 'app-stepper',
  template: `
    @if (tc().closed) {
      <p class="muted small">Closed as won't test.</p>
    } @else {
      <ol class="stepper" aria-label="Progress">
        @for (s of steps(); track s.label; let last = $last) {
          <li [class]="'st-' + s.state" [attr.aria-current]="s.state === 'current' || s.state === 'problem' ? 'step' : null">
            <span class="dot" aria-hidden="true">{{ s.state === 'done' ? '✓' : s.state === 'problem' ? '!' : '' }}</span>
            <span class="label">{{ s.label }}@if (s.note) {<span class="note">: {{ s.note }}</span>}</span>
            @if (!last) {
              <span class="bar" aria-hidden="true"></span>
            }
          </li>
        }
      </ol>
    }
  `,
  styles: `
    .stepper { list-style: none; margin: 0; padding: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 0; }
    li { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-2); }
    .dot { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border-strong); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; flex: none; }
    .bar { width: 28px; height: 2px; background: var(--border); margin: 0 6px; }
    .st-done .dot { background: var(--good); border-color: var(--good); color: #fff; }
    .st-done .bar { background: var(--good); }
    .st-current { color: var(--text); font-weight: 600; }
    .st-current .dot { border-color: var(--accent); background: var(--accent-soft); }
    .st-problem { color: var(--bad); font-weight: 600; }
    .st-problem .dot { background: var(--bad); border-color: var(--bad); color: #fff; }
    .note { font-weight: 400; }
  `,
})
export class Stepper {
  readonly tc = input.required<TestCase>();

  protected readonly steps = computed<Step[]>(() => {
    const tc = this.tc();
    const s = tc.status ?? 'draft';
    const ran = tc.labels.some((l) => /^run:/i.test(l));
    const order = ['Draft', 'In review', 'Approved', 'Running', 'Passed'];
    const at: Record<string, number> = {
      draft: 0,
      'in-review': 1,
      'changes-requested': 1,
      approved: ran ? 3 : 2,
      failed: 3,
      blocked: 3,
      passed: 4,
    };
    const idx = at[s] ?? 0;
    return order.map((label, i) => {
      if (i < idx || (i === 4 && s === 'passed')) return { label, state: 'done' as const };
      if (i > idx) return { label, state: 'todo' as const };
      if (s === 'changes-requested') return { label, state: 'problem' as const, note: 'changes requested' };
      if (s === 'failed') return { label, state: 'problem' as const, note: 'failed' };
      if (s === 'blocked') return { label, state: 'problem' as const, note: 'blocked' };
      return { label, state: 'current' as const };
    });
  });
}

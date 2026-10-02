import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PLATFORM_NAMES } from '../../core/testcase/model';
import { PlatformProgress } from '../../core/testcase/readiness';

interface Segment {
  key: 'pass' | 'fail' | 'blocked' | 'none';
  label: string;
  icon: string;
  count: number;
  status: string | null; // list filter for the segment
}

/**
 * DB-2: one stacked bar per platform. Status never rides on color alone: fixed order,
 * icon + label + count in the legend, a readout on hover/focus, and a 2px gap between segments.
 */
@Component({
  selector: 'app-platform-bar',
  imports: [RouterLink],
  template: `
    <div class="head row">
      <strong>{{ names[p().platform] }}</strong>
      <span class="muted small">{{ p().pass }} of {{ p().total }} passed</span>
    </div>
    @if (p().total) {
      <div class="bar" role="img" [attr.aria-label]="summary()">
        @for (s of segments(); track s.key) {
          @if (s.count) {
            <a
              [class]="'seg s-' + s.key"
              [style.flex-grow]="s.count"
              routerLink="../cases"
              [queryParams]="{ platform: p().platform, status: s.status }"
              queryParamsHandling="merge"
              [attr.aria-label]="s.count + ' ' + s.label + ' on ' + names[p().platform]"
              [attr.data-tip]="s.icon + ' ' + s.count + ' ' + s.label"
            ></a>
          }
        }
      </div>
      <ul class="legend">
        @for (s of segments(); track s.key) {
          <li><span [class]="'key s-' + s.key" aria-hidden="true"></span><span class="icon" aria-hidden="true">{{ s.icon }}</span> {{ s.label }} <strong>{{ s.count }}</strong></li>
        }
      </ul>
    } @else {
      <p class="muted small">No approved cases on {{ names[p().platform] }} yet.</p>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 8px; }
    .head { justify-content: space-between; }
    .bar { display: flex; gap: 2px; height: 16px; }
    .seg { display: block; min-width: 6px; height: 100%; position: relative; }
    .seg:first-child { border-radius: 4px 0 0 4px; }
    .seg:last-child { border-radius: 0 4px 4px 0; }
    .seg:only-child { border-radius: 4px; }
    .seg:hover, .seg:focus-visible { filter: brightness(1.12); outline-offset: 2px; }
    .seg:hover::after, .seg:focus-visible::after {
      content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
      white-space: nowrap; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px;
      background: var(--text); color: var(--surface); pointer-events: none; z-index: 3;
    }
    .s-pass { background: #0ca30c; }
    .s-fail { background: #d03b3b; }
    .s-blocked { background: #fab219; }
    .s-none { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border); }
    .legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--text-2); }
    .legend li { display: flex; align-items: center; gap: 4px; }
    .legend strong { color: var(--text); }
    .key { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
    .icon { width: 14px; text-align: center; }
  `,
})
export class PlatformBar {
  readonly p = input.required<PlatformProgress>();
  protected readonly names = PLATFORM_NAMES;

  protected readonly segments = computed<Segment[]>(() => [
    { key: 'pass', label: 'passed', icon: '✓', count: this.p().pass, status: null },
    { key: 'fail', label: 'failed', icon: '✗', count: this.p().fail, status: 'failed' },
    { key: 'blocked', label: 'blocked', icon: '⛔', count: this.p().blocked, status: 'blocked' },
    { key: 'none', label: 'not run', icon: '○', count: this.p().none, status: 'approved' },
  ]);

  protected readonly summary = computed(() => {
    const p = this.p();
    return `${PLATFORM_NAMES[p.platform]}: ${p.pass} passed, ${p.fail} failed, ${p.blocked} blocked, ${p.none} not run, of ${p.total}`;
  });
}

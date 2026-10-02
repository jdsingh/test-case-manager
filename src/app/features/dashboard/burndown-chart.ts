import { Component, ElementRef, computed, input, signal, viewChild } from '@angular/core';
import { Burndown } from '../../core/testcase/readiness';

const W = 720;
const H = 240;
const M = { top: 16, right: 24, bottom: 32, left: 40 };

const dayMs = 864e5;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fmt = (d: string) => new Date(t(d)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * RR-2: runs still to do per day against an even pace to the release date. One measured
 * series (no legend box needed beyond the two keys), crosshair readout, table view.
 */
@Component({
  selector: 'app-burndown-chart',
  template: `
    <div class="keys small">
      <span><span class="line-key actual"></span> Runs still to do</span>
      @if (data().end > data().start) {
        <span><span class="line-key ideal"></span> Even pace to {{ endLabel() }}</span>
      }
    </div>
    <div class="wrap" (pointerleave)="hover.set(null)">
      <svg
        #svg
        [attr.viewBox]="'0 0 ' + w + ' ' + h"
        role="img"
        [attr.aria-label]="ariaLabel()"
        (pointermove)="onMove($event)"
      >
        @for (tick of yTicks(); track tick) {
          <line class="grid" [attr.x1]="m.left" [attr.x2]="w - m.right" [attr.y1]="y(tick)" [attr.y2]="y(tick)" />
          <text class="axis" [attr.x]="m.left - 8" [attr.y]="y(tick) + 4" text-anchor="end">{{ tick }}</text>
        }
        @for (tick of xTicks(); track tick) {
          <text class="axis" [attr.x]="x(tick)" [attr.y]="h - 10" text-anchor="middle">{{ label(tick) }}</text>
        }
        @if (releaseX() !== null) {
          <line class="release" [attr.x1]="releaseX()" [attr.x2]="releaseX()" [attr.y1]="m.top" [attr.y2]="h - m.bottom" />
          <text class="axis strong" [attr.x]="releaseX()! - 4" [attr.y]="m.top + 10" text-anchor="end">Release</text>
        }
        @if (data().end > data().start) {
          <line class="ideal" [attr.x1]="x(data().start)" [attr.y1]="y(data().total)" [attr.x2]="x(data().end)" [attr.y2]="y(0)" />
        }
        <path class="area" [attr.d]="areaPath()" />
        <path class="actual" [attr.d]="linePath()" />
        @if (last(); as p) {
          <circle class="dot" [attr.cx]="x(p.date)" [attr.cy]="y(p.remaining)" r="4.5" />
          <text class="value" [attr.x]="x(p.date) + 8" [attr.y]="y(p.remaining) - 8">{{ p.remaining }} left</text>
        }
        @if (hover(); as hv) {
          <line class="cross" [attr.x1]="x(hv.date)" [attr.x2]="x(hv.date)" [attr.y1]="m.top" [attr.y2]="h - m.bottom" />
          <circle class="dot" [attr.cx]="x(hv.date)" [attr.cy]="y(hv.remaining)" r="4.5" />
        }
      </svg>
      @if (hover(); as hv) {
        <div class="tip" [style.left.%]="(x(hv.date) / w) * 100" role="status">
          <strong>{{ hv.remaining }}</strong> still to do
          <span class="muted"> · {{ fmtDay(hv.date) }}</span>
          @if (data().end > data().start) {
            <div class="muted">pace: {{ idealAt(hv.date) }}</div>
          }
        </div>
      }
    </div>
    <details class="small">
      <summary>Show as a table</summary>
      <table>
        <thead><tr><th scope="col">Day</th><th scope="col">Still to do</th></tr></thead>
        <tbody>
          @for (p of data().points; track p.date) {
            <tr><td>{{ fmtDay(p.date) }}</td><td>{{ p.remaining }}</td></tr>
          }
        </tbody>
      </table>
    </details>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 6px; }
    .keys { display: flex; gap: 16px; color: var(--text-2); }
    .line-key { display: inline-block; width: 16px; height: 0; border-top: 2px solid; vertical-align: middle; margin-right: 4px; }
    .line-key.actual { border-color: var(--accent); }
    .line-key.ideal { border-color: var(--text-2); border-top-width: 1.5px; }
    .wrap { position: relative; }
    svg { width: 100%; height: auto; display: block; touch-action: none; }
    .grid { stroke: var(--border); stroke-width: 1; }
    .axis { fill: var(--text-2); font-size: 11px; }
    .axis.strong { fill: var(--text); font-weight: 600; }
    .release { stroke: var(--text-2); stroke-width: 1; }
    .ideal { stroke: var(--text-2); stroke-width: 1.5; opacity: 0.7; }
    .area { fill: var(--accent); opacity: 0.1; }
    .actual { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
    .dot { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
    .value { fill: var(--text); font-size: 12px; font-weight: 600; }
    .cross { stroke: var(--text-2); stroke-width: 1; }
    .tip { position: absolute; top: 4px; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; white-space: nowrap; box-shadow: var(--shadow); pointer-events: none; }
    table { border-collapse: collapse; margin-top: 6px; }
    td, th { padding: 2px 12px 2px 0; text-align: left; }
  `,
})
export class BurndownChart {
  readonly data = input.required<Burndown>();
  protected readonly w = W;
  protected readonly h = H;
  protected readonly m = M;
  protected readonly hover = signal<{ date: string; remaining: number } | null>(null);
  private readonly svg = viewChild<ElementRef<SVGSVGElement>>('svg');

  protected readonly x = (d: string) => {
    const { start, end } = this.data();
    const span = Math.max(dayMs, t(end) - t(start));
    return M.left + ((t(d) - t(start)) / span) * (W - M.left - M.right);
  };
  protected readonly y = (v: number) => {
    const max = Math.max(1, this.data().total);
    return M.top + (1 - v / max) * (H - M.top - M.bottom);
  };

  protected readonly last = computed(() => this.data().points.at(-1) ?? null);
  protected readonly linePath = computed(() =>
    this.data()
      .points.map((p, i) => `${i ? 'L' : 'M'}${this.x(p.date).toFixed(1)},${this.y(p.remaining).toFixed(1)}`)
      .join(''),
  );
  protected readonly areaPath = computed(() => {
    const pts = this.data().points;
    if (!pts.length) return '';
    const base = this.y(0).toFixed(1);
    return `${this.linePath()}L${this.x(pts.at(-1)!.date).toFixed(1)},${base}L${this.x(pts[0].date).toFixed(1)},${base}Z`;
  });

  protected readonly yTicks = computed(() => {
    const total = this.data().total;
    const mid = Math.round(total / 2);
    return [...new Set([0, mid, total])];
  });
  protected readonly xTicks = computed(() => {
    const { start, end } = this.data();
    const today = this.last()?.date ?? start;
    return [...new Set([start, today, end])].filter((d, i, a) => i === 0 || Math.abs(this.x(d) - this.x(a[i - 1])) > 60);
  });
  protected readonly releaseX = computed(() => (this.data().end > (this.last()?.date ?? '') ? this.x(this.data().end) : null));
  protected readonly endLabel = computed(() => fmt(this.data().end));
  protected readonly ariaLabel = computed(() => {
    const l = this.last();
    return `Burndown: ${l?.remaining ?? 0} of ${this.data().total} runs still to do on ${l ? fmt(l.date) : ''}; release ${fmt(this.data().end)}.`;
  });

  protected label(d: string): string {
    return d === this.last()?.date ? 'Today' : fmt(d);
  }

  protected fmtDay(d: string): string {
    return fmt(d);
  }

  protected idealAt(d: string): string {
    const { start, end, total } = this.data();
    const frac = Math.min(1, Math.max(0, (t(d) - t(start)) / Math.max(dayMs, t(end) - t(start))));
    return (total * (1 - frac)).toFixed(1);
  }

  /** The crosshair snaps to the nearest day that has data. */
  protected onMove(e: PointerEvent): void {
    const el = this.svg()?.nativeElement;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = this.data().points[0];
    for (const p of this.data().points) if (Math.abs(this.x(p.date) - px) < Math.abs(this.x(best.date) - px)) best = p;
    this.hover.set(best ?? null);
  }
}

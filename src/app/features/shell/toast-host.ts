import { Component, inject } from '@angular/core';
import { Toasts } from '../../core/toast';

@Component({
  selector: 'app-toast-host',
  template: `
    <div class="toasts" role="status" aria-live="polite">
      @for (t of toasts.items(); track t.id) {
        <div [class]="'toast t-' + t.tone">
          <span aria-hidden="true">{{ t.tone === 'good' ? '✓' : t.tone === 'bad' ? '!' : 'i' }}</span>
          <span>{{ t.text }}</span>
          @if (t.link) {
            <a [href]="t.link.url" target="_blank" rel="noopener">{{ t.link.label }}</a>
          }
          <button type="button" class="x" (click)="toasts.dismiss(t.id)" aria-label="Dismiss">×</button>
        </div>
      }
    </div>
  `,
  styles: `
    .toasts { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; z-index: 50; max-width: min(420px, calc(100vw - 32px)); }
    .toast { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; background: var(--text); color: var(--surface); box-shadow: var(--shadow); font-size: 13.5px; animation: up 0.18s ease-out; }
    .toast a { color: inherit; font-weight: 600; }
    .t-good > span:first-child { color: #4ac26b; font-weight: 800; }
    .t-bad > span:first-child { color: #f47067; font-weight: 800; }
    .x { border: none; background: none; color: inherit; opacity: 0.7; cursor: pointer; font-size: 16px; }
    @keyframes up { from { transform: translateY(8px); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
  `,
})
export class ToastHost {
  protected readonly toasts = inject(Toasts);
}

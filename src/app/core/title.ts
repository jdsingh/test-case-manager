import { Injectable, effect, inject, signal } from '@angular/core';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

/**
 * The inbox count, shared without dependencies: the router needs the title strategy, so
 * the title strategy can't depend on anything that needs the router (InboxStore does).
 */
@Injectable({ providedIn: 'root' })
export class InboxCount {
  readonly value = signal(0);
}

/** Page titles, prefixed with the inbox count, plus a favicon badge (IN-2). */
@Injectable({ providedIn: 'root' })
export class InboxTitleStrategy extends TitleStrategy {
  private readonly count = inject(InboxCount);
  private readonly base = signal('Test Case Manager');

  constructor() {
    super();
    effect(() => {
      const n = this.count.value();
      document.title = n ? `(${n}) ${this.base()}` : this.base();
      setFavicon(n);
    });
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.base.set(this.buildTitle(snapshot) ?? 'Test Case Manager');
  }
}

let lastBadge = -1;

function setFavicon(n: number): void {
  if (n === lastBadge) return;
  lastBadge = n;
  const label = n > 99 ? '99+' : String(n);
  const badge = n
    ? `<circle cx="23" cy="9" r="9" fill="#d1242f"/><text x="23" y="13" font-size="${label.length > 1 ? 9 : 12}" font-family="Arial,sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${label}</text>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="6" width="24" height="24" rx="6" fill="#2563eb"/><path d="M8 18l4 4 8-9" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>${badge}</svg>`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

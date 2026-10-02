import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'info';
  link?: { url: string; label: string };
}

/** Short confirmations after an action (UX 9). */
@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);
  private next = 1;

  show(text: string, tone: Toast['tone'] = 'good', link?: Toast['link']): void {
    const t: Toast = { id: this.next++, text, tone, link };
    this.items.update((list) => [...list.slice(-2), t]);
    setTimeout(() => this.dismiss(t.id), tone === 'bad' ? 8000 : 4000);
  }

  dismiss(id: number): void {
    this.items.update((list) => list.filter((t) => t.id !== id));
  }
}

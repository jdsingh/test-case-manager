import { Component, Injectable, computed, inject, input, signal } from '@angular/core';
import { Session } from '../../core/session';
import { Workspace } from '../../core/workspace';
import { EvidenceRef, evidenceObjectUrl, evidenceUrl, kindOf } from '../../core/evidence/evidence';

/** Object URLs for evidence fetched through the API, shared so each file loads once. */
@Injectable({ providedIn: 'root' })
export class EvidenceCache {
  private readonly session = inject(Session);
  private readonly urls = new Map<string, Promise<string>>();

  get(nameWithOwner: string, path: string): Promise<string> {
    const key = `${nameWithOwner}:${path}`;
    let p = this.urls.get(key);
    if (!p) {
      p = evidenceObjectUrl(this.session.requireClient(), nameWithOwner, path);
      p.catch(() => this.urls.delete(key));
      this.urls.set(key, p);
    }
    return p;
  }
}

/** One piece of evidence: an image thumbnail (click to enlarge) or a video that loads on demand. */
@Component({
  selector: 'app-evidence-thumb',
  template: `
    @switch (kind()) {
      @case ('image') {
        <button type="button" class="thumb" (click)="url() && large.showModal()" [title]="'Enlarge ' + ref().name">
          @if (url(); as u) {
            <img [src]="u" [alt]="ref().name" />
          } @else if (failed()) {
            <span class="small muted">Can't load</span>
          } @else {
            <span class="spinner" aria-hidden="true"></span>
          }
        </button>
      }
      @case ('video') {
        @if (url(); as u) {
          <video [src]="u" controls preload="metadata" class="video"></video>
        } @else {
          <button type="button" class="thumb video-btn" (click)="load()" [title]="'Play ' + ref().name">
            @if (loading()) { <span class="spinner" aria-hidden="true"></span> } @else { ▶ <span class="small">{{ ref().name }}</span> }
          </button>
        }
      }
      @default {
        <a [href]="githubUrl()" target="_blank" rel="noopener">{{ ref().name }}</a>
      }
    }
    <dialog #large class="lightbox" (click)="large.close()">
      @if (url(); as u) {
        <img [src]="u" [alt]="ref().name" />
      }
      <div class="row small">
        <span>{{ ref().name }}</span>
        <span class="spacer"></span>
        <a [href]="githubUrl()" target="_blank" rel="noopener" (click)="$event.stopPropagation()">Open on GitHub</a>
      </div>
    </dialog>
  `,
  styles: `
    :host { display: inline-block; }
    .thumb { width: 96px; height: 72px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); cursor: pointer; display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--text); }
    .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .video-btn { width: auto; min-width: 96px; padding: 0 10px; gap: 6px; }
    .video { max-width: 320px; max-height: 240px; border-radius: 6px; background: #000; }
    .lightbox { width: auto; max-width: 92vw; padding: 12px; }
    .lightbox img { max-width: 88vw; max-height: 80vh; display: block; margin-bottom: 8px; }
  `,
})
/** Object URLs are cached app-wide and reused, so they aren't revoked per thumbnail. */
export class EvidenceThumb {
  private readonly cache = inject(EvidenceCache);
  private readonly ws = inject(Workspace);

  readonly ref = input.required<EvidenceRef>();
  protected readonly url = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly kind = computed(() => kindOf(this.ref().type, this.ref().name));

  constructor() {
    // Images load straight away; videos wait for a click (they can be large).
    queueMicrotask(() => {
      if (this.kind() === 'image') void this.load();
    });
  }

  protected githubUrl(): string {
    return evidenceUrl(this.ws.repo()?.nameWithOwner ?? '', this.ref().path);
  }

  protected async load(): Promise<void> {
    const repo = this.ws.repo();
    if (!repo || this.url() || this.loading()) return;
    this.loading.set(true);
    try {
      this.url.set(await this.cache.get(repo.nameWithOwner, this.ref().path));
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

}

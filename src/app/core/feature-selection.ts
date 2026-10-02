import { Injectable, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { Workspace } from './workspace';

const KEY = 'tcm.feature.';

/**
 * The selected feature (a Projects v2 board). It lives in the `?feature=<number>` query
 * param so links are shareable (NV-2), falling back to the last one used in this repo.
 */
@Injectable({ providedIn: 'root' })
export class FeatureSelection {
  private readonly router = inject(Router);
  private readonly ws = inject(Workspace);

  private readonly fromUrl = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.parseUrl(this.router.url).queryParamMap.get('feature')),
    ),
    { initialValue: null },
  );

  readonly selected = computed<string | null>(() => {
    const repo = this.ws.repo();
    const open = this.ws.projects().filter((p) => !p.closed);
    const isOpen = (n: string | null | undefined) => !!n && open.some((p) => String(p.number) === n);
    const url = this.fromUrl();
    if (isOpen(url)) return url;
    const stored = repo ? localStorage.getItem(KEY + repo.nameWithOwner) : null;
    if (isOpen(stored)) return stored;
    const configured = this.ws.config()?.project?.number;
    if (isOpen(String(configured))) return String(configured);
    return open[0] ? String(open[0].number) : null;
  });

  readonly project = computed(() => {
    const n = this.selected();
    return this.ws.projects().find((p) => String(p.number) === n) ?? null;
  });

  readonly settings = computed(() => {
    const n = this.selected();
    return n ? (this.ws.config()?.features[n] ?? null) : null;
  });

  constructor() {
    effect(() => {
      const repo = this.ws.repo();
      const n = this.fromUrl();
      if (repo && n) localStorage.setItem(KEY + repo.nameWithOwner, n);
    });
  }
}

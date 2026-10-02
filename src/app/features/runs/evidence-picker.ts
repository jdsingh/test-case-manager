import { Component, HostListener, Injectable, OnDestroy, computed, effect, inject, model, signal } from '@angular/core';
import { checkFile } from '../../core/evidence/prepare';
import { kindOf } from '../../core/evidence/evidence';

interface FolderFile {
  file: File;
  url: string | null;
}

type DirHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

/**
 * A watched folder (TS-5): where AirDrop, Android Studio or adb saves screenshots. The
 * newest files show as one-click thumbnails. Chromium only (File System Access API).
 */
@Injectable({ providedIn: 'root' })
export class FolderWatch implements OnDestroy {
  readonly supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  readonly name = signal<string | null>(null);
  readonly newest = signal<FolderFile[]>([]);
  private handle: DirHandle | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  async pick(): Promise<void> {
    const picker = (window as unknown as { showDirectoryPicker: (o?: object) => Promise<DirHandle> }).showDirectoryPicker;
    try {
      this.handle = await picker({ id: 'tcm-evidence', mode: 'read' });
    } catch {
      return; // cancelled
    }
    this.name.set(this.handle.name);
    await this.scan();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.scan(), 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handle = null;
    this.name.set(null);
    this.release(this.newest());
    this.newest.set([]);
  }

  private async scan(): Promise<void> {
    if (!this.handle) return;
    const files: File[] = [];
    try {
      for await (const entry of this.handle.values()) {
        if (entry.kind !== 'file') continue;
        const f = await (entry as FileSystemFileHandle).getFile();
        if (kindOf(f.type, f.name) !== 'other') files.push(f);
      }
    } catch {
      this.stop(); // permission revoked or folder gone
      return;
    }
    files.sort((a, b) => b.lastModified - a.lastModified);
    const top = files.slice(0, 6);
    const prev = this.newest();
    const same = top.length === prev.length && top.every((f, i) => f.name === prev[i].file.name && f.lastModified === prev[i].file.lastModified);
    if (same) return;
    this.release(prev);
    this.newest.set(top.map((file) => ({ file, url: kindOf(file.type, file.name) === 'image' ? URL.createObjectURL(file) : null })));
  }

  private release(list: FolderFile[]): void {
    for (const f of list) if (f.url) URL.revokeObjectURL(f.url);
  }

  ngOnDestroy(): void {
    this.stop();
  }
}

/** Attach screenshots or videos: drop, paste, choose, or click one from a watched folder (EX-4, TS-5). */
@Component({
  selector: 'app-evidence-picker',
  template: `
    <div
      class="drop"
      [class.over]="over()"
      (dragover)="$event.preventDefault(); over.set(true)"
      (dragleave)="over.set(false)"
      (drop)="onDrop($event)"
    >
      <div class="row wrap small">
        <span class="muted">Drop screenshots or videos here, paste them{{ folder.supported ? ',' : ' or' }}</span>
        <label class="btn btn-link small">
          choose files
          <input type="file" multiple accept="image/*,video/*,.heic,.mov" class="sr-only" (change)="onChoose($event)" />
        </label>
        @if (folder.supported) {
          <span class="muted">or</span>
          @if (folder.name()) {
            <span class="muted">watching <strong>{{ folder.name() }}</strong></span>
            <button class="btn btn-link small" type="button" (click)="folder.stop()">stop</button>
          } @else {
            <button class="btn btn-link small" type="button" (click)="folder.pick()">watch a screenshots folder</button>
          }
        }
      </div>

      @if (folder.newest().length) {
        <div class="newest" aria-label="Newest files in the watched folder">
          @for (f of folder.newest(); track f.file.name + f.file.lastModified) {
            <button type="button" class="pick" (click)="add([f.file])" [title]="'Attach ' + f.file.name" [class.added]="isAdded(f.file)">
              @if (f.url) {
                <img [src]="f.url" [alt]="f.file.name" />
              } @else {
                <span class="small">▶ {{ f.file.name }}</span>
              }
            </button>
          }
        </div>
      }
    </div>

    @if (files().length) {
      <ul class="chosen" aria-label="Attached files">
        @for (f of previews(); track f.file) {
          <li [class.bad]="f.check === 'too-large' || f.check === 'unsupported'">
            @if (f.url) {
              <img [src]="f.url" alt="" />
            } @else {
              <span class="icon">{{ f.kind === 'video' ? '▶' : '📄' }}</span>
            }
            <span class="small name">{{ f.file.name }}</span>
            <span class="small muted">{{ size(f.file.size) }}</span>
            @if (f.check === 'large') {
              <span class="small warn">over 25 MB</span>
            } @else if (f.check === 'too-large') {
              <span class="small">over GitHub's 100 MB limit</span>
            } @else if (f.check === 'unsupported') {
              <span class="small">not an image or video</span>
            }
            <button type="button" class="x" (click)="remove(f.file)" [attr.aria-label]="'Remove ' + f.file.name">×</button>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .drop { border: 1.5px dashed var(--border-strong); border-radius: var(--radius); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
    .drop.over { border-color: var(--accent); background: var(--accent-soft); }
    .wrap { flex-wrap: wrap; gap: 4px; }
    .newest { display: flex; gap: 6px; flex-wrap: wrap; }
    .pick { width: 72px; height: 56px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); cursor: pointer; overflow: hidden; color: var(--text); }
    .pick img { width: 100%; height: 100%; object-fit: cover; }
    .pick.added { outline: 2px solid var(--accent); }
    .chosen { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .chosen li { display: flex; align-items: center; gap: 8px; }
    .chosen li.bad { color: var(--bad); }
    .chosen img, .icon { width: 40px; height: 30px; object-fit: cover; border-radius: 4px; background: var(--surface-2); display: inline-flex; align-items: center; justify-content: center; }
    .name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .warn { color: var(--warn); }
    .x { border: none; background: none; color: var(--text-2); cursor: pointer; font-size: 16px; }
  `,
})
export class EvidencePicker implements OnDestroy {
  protected readonly folder = inject(FolderWatch);

  readonly files = model<File[]>([]);

  protected readonly over = signal(false);
  private readonly urls = new Map<File, string>();

  protected readonly previews = computed(() =>
    this.files().map((file) => {
      const kind = kindOf(file.type, file.name);
      let url: string | null = null;
      if (kind === 'image' && !/\.heic$/i.test(file.name)) {
        url = this.urls.get(file) ?? URL.createObjectURL(file);
        this.urls.set(file, url);
      }
      return { file, kind, url, check: checkFile(file) };
    }),
  );

  constructor() {
    // Free previews of files that were removed.
    effect(() => {
      const keep = new Set(this.files());
      for (const [f, url] of this.urls) {
        if (!keep.has(f)) {
          URL.revokeObjectURL(url);
          this.urls.delete(f);
        }
      }
    });
  }

  @HostListener('document:paste', ['$event'])
  protected onPaste(e: ClipboardEvent): void {
    // Only files are taken; pasted text goes where it normally would.
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    // Pasted screenshots are all called "image.png"; give them distinct names.
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    this.add(files.map((f, i) => (f.name === 'image.png' ? new File([f], `pasted-${stamp}-${i + 1}.png`, { type: f.type }) : f)));
  }

  protected onDrop(e: DragEvent): void {
    e.preventDefault();
    this.over.set(false);
    this.add([...(e.dataTransfer?.files ?? [])]);
  }

  protected onChoose(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.add([...(input.files ?? [])]);
    input.value = '';
  }

  add(files: File[]): void {
    const fresh = files.filter((f) => !this.isAdded(f));
    if (fresh.length) this.files.update((list) => [...list, ...fresh]);
  }

  protected isAdded(f: File): boolean {
    return this.files().some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified);
  }

  protected remove(f: File): void {
    this.files.update((list) => list.filter((x) => x !== f));
  }

  protected size(bytes: number): string {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  ngOnDestroy(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
  }
}

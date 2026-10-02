import { Injectable, computed, inject, signal } from '@angular/core';
import { CasesStore } from './cases-store';
import { asGitHubError } from '../workspace';
import { RunMeta } from './runs';
import { prepareFiles } from '../evidence/prepare';

export type JobStatus = 'queued' | 'working' | 'done' | 'error';

export interface RunJob {
  id: number;
  caseNumber: number;
  meta: RunMeta;
  notes: string;
  files: File[];
  status: JobStatus;
  message: string;
}

/**
 * Runs recorded in a test session upload in the background, one at a time, so the engineer
 * can move straight on to the next case (TS-5). Failed jobs stay for a retry.
 */
@Injectable({ providedIn: 'root' })
export class RunQueue {
  private readonly store = inject(CasesStore);
  readonly jobs = signal<RunJob[]>([]);
  readonly pending = computed(() => this.jobs().filter((j) => j.status === 'queued' || j.status === 'working').length);
  readonly failed = computed(() => this.jobs().filter((j) => j.status === 'error'));
  private nextId = 1;
  private running = false;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', (e) => {
        if (this.pending()) e.preventDefault();
      });
    }
  }

  enqueue(caseNumber: number, meta: RunMeta, notes: string, files: File[]): RunJob {
    const job: RunJob = { id: this.nextId++, caseNumber, meta, notes, files, status: 'queued', message: 'Waiting…' };
    this.jobs.update((list) => [...list, job]);
    void this.work();
    return job;
  }

  retry(id: number): void {
    this.patch(id, { status: 'queued', message: 'Waiting…' });
    void this.work();
  }

  latestFor(caseNumber: number): RunJob | null {
    return [...this.jobs()].reverse().find((j) => j.caseNumber === caseNumber) ?? null;
  }

  private async work(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs().find((j) => j.status === 'queued');
        if (!job) break;
        this.patch(job.id, { status: 'working', message: 'Preparing…' });
        try {
          const tc = this.store.byNumber(job.caseNumber);
          if (!tc) throw new Error(`Test case #${job.caseNumber} is no longer loaded.`);
          const prepared = await prepareFiles(job.files, tc.number, job.meta.platform, new Date(job.meta.executedAt));
          if (prepared.rejected.length) throw new Error(prepared.rejected.join(' '));
          await this.store.recordRun(tc, job.meta, job.notes, prepared.uploads, (m) => this.patch(job.id, { message: m }));
          this.patch(job.id, { status: 'done', message: prepared.warnings.join(' ') || 'Saved' });
        } catch (e) {
          this.patch(job.id, { status: 'error', message: asGitHubError(e).message });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private patch(id: number, p: Partial<RunJob>): void {
    this.jobs.update((list) => list.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }
}

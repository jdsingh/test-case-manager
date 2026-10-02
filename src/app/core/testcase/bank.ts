// The regression bank (PRD 5.6): open cases labelled `regression` are the bank; a feature
// reuses one by copying it. A copy remembers its source and a fingerprint of the
// source's scenario, so it can be flagged once the original changes (RB-5).

import { TestCase, TestCaseDraft } from './model';

export interface CopyInfo {
  source: number;
  fingerprint: string;
}

const COPY_RE = /<!--\s*tcm:copy\s*(\{[^}]*\})\s*-->/;

/** A stable hash of what reviewers approved: name, platforms, preconditions and steps. */
export function fingerprint(d: Pick<TestCaseDraft, 'title' | 'platforms' | 'preconditions' | 'steps'>): string {
  const text = JSON.stringify([
    d.title.trim().toLowerCase(),
    [...d.platforms].sort(),
    d.preconditions.trim(),
    d.steps.map((s) => [s.keyword, s.text.trim()]),
  ]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The note a copy carries below its scenario (kept as the issue's extra text). */
export function copyNote(source: TestCase): string {
  const marker = `<!-- tcm:copy ${JSON.stringify({ source: source.number, fingerprint: fingerprint(source) })} -->`;
  return `${marker}\n_Copied from the regression bank: #${source.number}._`;
}

export function copyInfo(tc: TestCase): CopyInfo | null {
  const m = COPY_RE.exec(tc.extraBody);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]) as CopyInfo;
    return Number.isInteger(d.source) && typeof d.fingerprint === 'string' ? d : null;
  } catch {
    return null;
  }
}

/** RB-5: the original changed after this copy was made. */
export function isOutOfDate(copy: TestCase, bank: TestCase[]): TestCase | null {
  const info = copyInfo(copy);
  if (!info) return null;
  const source = bank.find((b) => b.number === info.source);
  return source && fingerprint(source) !== info.fingerprint ? source : null;
}

/** Bank cases that aren't already in the feature, either themselves or as a copy. */
export function bankCandidates(bank: TestCase[], featureCases: TestCase[]): TestCase[] {
  const inFeature = new Set(featureCases.map((c) => c.number));
  const copied = new Set(featureCases.map((c) => copyInfo(c)?.source).filter((n): n is number => n !== undefined));
  return bank.filter((b) => !b.closed && !inFeature.has(b.number) && !copied.has(b.number));
}

/** RB-4: a copy of a case whose current version was approved can skip re-review. */
export function copyStartsApproved(source: TestCase): boolean {
  return ['approved', 'passed', 'failed', 'blocked'].includes(source.status ?? '');
}

/** Copy text without the app's hidden marker, for display. */
export function visibleExtra(extraBody: string): string {
  return extraBody.replace(COPY_RE, '').trim();
}

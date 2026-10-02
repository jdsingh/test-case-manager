// Step library (SL-1) and near-duplicate detection (SL-2).

import { Section, sectionsOf, similarity, words } from './gherkin';
import { TestCase, TestCaseDraft } from './model';

export interface LibraryStep {
  text: string;
  count: number;
}

/** Every step text used so far, per section, most used first. */
export function buildStepLibrary(cases: TestCase[]): Record<Section, LibraryStep[]> {
  const counts: Record<Section, Map<string, LibraryStep>> = { Given: new Map(), When: new Map(), Then: new Map() };
  for (const tc of cases) {
    const sections = sectionsOf(tc.steps);
    tc.steps.forEach((step, i) => {
      const sec = sections[i];
      const text = step.text.trim();
      if (!sec || !text) return;
      const key = text.toLowerCase();
      const hit = counts[sec].get(key);
      if (hit) hit.count++;
      else counts[sec].set(key, { text, count: 1 });
    });
  }
  const sorted = (m: Map<string, LibraryStep>) =>
    [...m.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  return { Given: sorted(counts.Given), When: sorted(counts.When), Then: sorted(counts.Then) };
}

export interface SimilarCase {
  testCase: TestCase;
  score: number;
}

const THRESHOLD = 0.5;

function fingerprint(title: string, steps: { text: string }[]): Set<string> {
  return words([title, ...steps.map((s) => s.text)].join(' '));
}

/** Cases that look like the draft, best match first (title and steps compared as word sets). */
export function findSimilar(draft: TestCaseDraft, cases: TestCase[], excludeNumber?: number): SimilarCase[] {
  const mine = fingerprint(draft.title, draft.steps);
  if (mine.size < 3) return [];
  return cases
    .filter((c) => c.number !== excludeNumber && !c.closed)
    .map((testCase) => ({ testCase, score: similarity(mine, fingerprint(testCase.title, testCase.steps)) }))
    .filter((s) => s.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

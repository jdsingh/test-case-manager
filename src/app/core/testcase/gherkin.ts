// Given/When/Then steps: parsing, validation and rendering (PRD AU-1, AU-2).

export type Keyword = 'Given' | 'When' | 'Then' | 'And';
export type Section = 'Given' | 'When' | 'Then';

export interface Step {
  keyword: Keyword;
  text: string;
}

export interface Scenario {
  name: string;
  steps: Step[];
}

const STEP_RE = /^\s*(Given|When|Then|And|But)\b\s*(.*)$/i;
const SCENARIO_RE = /^\s*Scenario(?: Outline)?:\s*(.*)$/i;

function normalizeKeyword(word: string): Keyword {
  const w = word.toLowerCase();
  if (w === 'given') return 'Given';
  if (w === 'when') return 'When';
  if (w === 'then') return 'Then';
  return 'And'; // And, But
}

/** The section each step belongs to; `And` continues the one before it. */
export function sectionsOf(steps: Step[]): (Section | null)[] {
  let current: Section | null = null;
  return steps.map((s) => {
    if (s.keyword !== 'And') current = s.keyword;
    return current;
  });
}

/** Problems with a scenario, in reading order. Empty means valid. */
export function validateScenario(s: Scenario): string[] {
  const problems: string[] = [];
  if (!s.name.trim()) problems.push('Give the scenario a name.');
  const steps = s.steps;
  if (!steps.length) {
    problems.push('Add at least one Given, one When and one Then step.');
    return problems;
  }
  if (steps[0].keyword !== 'Given') problems.push('The first step must be a Given.');
  const order: Record<Section, number> = { Given: 0, When: 1, Then: 2 };
  const sections = sectionsOf(steps);
  let highest = 0;
  sections.forEach((sec, i) => {
    if (!sec) return;
    if (order[sec] < highest) {
      problems.push(`Step ${i + 1} ("${steps[i].keyword} …") is out of order: steps go Given, then When, then Then.`);
    }
    highest = Math.max(highest, order[sec]);
  });
  for (const sec of ['Given', 'When', 'Then'] as const) {
    if (!sections.includes(sec)) problems.push(`Add at least one ${sec} step.`);
  }
  steps.forEach((st, i) => {
    if (!st.text.trim()) problems.push(`Step ${i + 1} is empty.`);
  });
  return [...new Set(problems)];
}

export function renderGherkin(s: Scenario): string {
  const lines = [`Scenario: ${s.name.trim()}`];
  for (const st of s.steps) {
    const text = st.text.trim();
    lines.push(st.keyword === 'And' ? `    And ${text}` : `  ${st.keyword} ${text}`);
  }
  return lines.join('\n');
}

/**
 * Parses Gherkin text into scenarios. Tolerates indentation, `But`, comments (#),
 * tags (@) and a Feature: header. Steps before any Scenario: line form an unnamed one.
 */
export function parseGherkin(text: string): Scenario[] {
  const scenarios: Scenario[] = [];
  let current: Scenario | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@') || /^Feature:/i.test(line)) continue;
    const sc = SCENARIO_RE.exec(line);
    if (sc) {
      current = { name: sc[1].trim(), steps: [] };
      scenarios.push(current);
      continue;
    }
    const st = STEP_RE.exec(line);
    if (st) {
      if (!current) {
        current = { name: '', steps: [] };
        scenarios.push(current);
      }
      current.steps.push({ keyword: normalizeKeyword(st[1]), text: st[2].trim() });
    } else if (current && current.steps.length) {
      // A continuation line: append to the previous step.
      const last = current.steps[current.steps.length - 1];
      last.text = `${last.text} ${line}`.trim();
    }
  }
  return scenarios;
}

/** Lowercased words, for similarity checks. */
export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

const STOP = new Set(['the', 'and', 'with', 'for', 'that', 'this', 'user', 'then', 'when', 'given', 'are', 'has', 'have', 'into', 'from']);

/** Jaccard similarity of two word sets, 0..1. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

// Turning spreadsheet rows or Gherkin text into test case drafts (PRD AU-6, IM-1, IM-2).

import { Platform, Priority } from '../config/team-config';
import { Step, parseGherkin, validateScenario } from '../testcase/gherkin';
import { TestCase, TestCaseDraft } from '../testcase/model';
import { findSimilar } from '../testcase/library';

export const IMPORT_FIELDS = ['title', 'priority', 'platforms', 'preconditions', 'scenario', 'given', 'when', 'then'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABELS: Record<ImportField, string> = {
  title: 'Scenario name',
  priority: 'Priority',
  platforms: 'Platforms',
  preconditions: 'Preconditions',
  scenario: 'Steps (Gherkin in one cell)',
  given: 'Given',
  when: 'When',
  then: 'Then / expected result',
};

/** Column index per field; -1 = not mapped. */
export type Mapping = Record<ImportField, number>;

export interface ImportDefaults {
  priority: Priority;
  platforms: Platform[];
}

export type RowState = 'ready' | 'invalid' | 'exists';

export interface ImportRow {
  /** 1-based source line (sheet row or scenario number) for messages. */
  source: number;
  draft: TestCaseDraft;
  problems: string[];
  /** An open case with the same name already exists in the feature: skipped (IM-3). */
  existing: TestCase | null;
  similar: TestCase | null;
  state: RowState;
}

const HEADER_HINTS: Record<ImportField, RegExp> = {
  title: /^(title|name|scenario( name)?|test ?case( name)?|summary|case)$/i,
  priority: /^(priority|prio|severity|p)$/i,
  platforms: /^(platforms?|os|device|devices)$/i,
  preconditions: /^(pre-?conditions?|setup|prerequisites?|test data|data)$/i,
  scenario: /^(steps|gherkin|scenario steps|description|test steps)$/i,
  given: /^given$/i,
  when: /^(when|action|actions?|steps? to perform)$/i,
  then: /^(then|expected( result)?s?|outcome)$/i,
};

/** Guesses the mapping from header names. Each column is used at most once. */
export function detectMapping(headers: string[]): Mapping {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, -1])) as Mapping;
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && HEADER_HINTS[field].test(h.trim()));
    if (i >= 0) {
      mapping[field] = i;
      used.add(i);
    }
  }
  // Without a title column, the title comes from each steps cell's "Scenario:" line.
  return mapping;
}

export function normalizePriority(raw: string): Priority | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const p = /^p?\s*([0-3])\b/.exec(v);
  if (p) return `P${p[1]}` as Priority;
  if (/blocker|critical|highest|urgent|must/.test(v)) return 'P0';
  if (/high|major/.test(v)) return 'P1';
  if (/medium|normal|moderate/.test(v)) return 'P2';
  if (/low|minor|trivial|nice/.test(v)) return 'P3';
  return null;
}

export function normalizePlatforms(raw: string): Platform[] | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (/\b(both|all|mobile|any)\b/.test(v)) return ['android', 'ios'];
  const out: Platform[] = [];
  if (/android|\bdroid\b/.test(v)) out.push('android');
  if (/\bios\b|iphone|ipad|apple/.test(v)) out.push('ios');
  return out.length ? out : null;
}

/** Lines of a cell as steps: the first gets `keyword`, later ones `And`. Keywords already typed are kept. */
function cellSteps(cell: string, keyword: 'Given' | 'When' | 'Then'): Step[] {
  const lines = cell
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  return lines.map((line, i) => {
    const m = /^(given|when|then|and|but)\s+(.*)$/i.exec(line);
    const text = m ? m[2] : line;
    return { keyword: i === 0 ? keyword : 'And', text };
  });
}

/** Rows from a parsed sheet (first row = headers). */
export function rowsFromTable(table: string[][], mapping: Mapping, defaults: ImportDefaults): ImportRow[] {
  const [, ...data] = table;
  const get = (row: string[], f: ImportField) => (mapping[f] >= 0 ? (row[mapping[f]] ?? '').trim() : '');
  return data.map((row, i) => {
    const problems: string[] = [];
    let title = get(row, 'title');
    let steps: Step[] = [];
    const scenarioCell = get(row, 'scenario');
    if (mapping.given >= 0 || mapping.when >= 0 || mapping.then >= 0) {
      steps = [...cellSteps(get(row, 'given'), 'Given'), ...cellSteps(get(row, 'when'), 'When'), ...cellSteps(get(row, 'then'), 'Then')];
    } else if (scenarioCell) {
      const [parsed] = parseGherkin(scenarioCell);
      if (parsed?.steps.length) {
        steps = parsed.steps;
        if (!title) title = parsed.name;
      } else problems.push('The steps cell has no Given/When/Then lines.');
    }
    const rawPriority = get(row, 'priority');
    const priority = normalizePriority(rawPriority);
    if (rawPriority && !priority) problems.push(`Unknown priority "${rawPriority}", using ${defaults.priority}.`);
    const rawPlatforms = get(row, 'platforms');
    const platforms = normalizePlatforms(rawPlatforms);
    if (rawPlatforms && !platforms) problems.push(`Unknown platform "${rawPlatforms}", using the default.`);
    const draft: TestCaseDraft = {
      title,
      priority: priority ?? defaults.priority,
      platforms: platforms ?? [...defaults.platforms],
      preconditions: get(row, 'preconditions'),
      steps,
    };
    return makeRow(i + 2, draft, problems);
  });
}

/** Rows from Gherkin text with one or more scenarios. Tags like @P0 @android set priority and platforms. */
export function rowsFromGherkin(text: string, defaults: ImportDefaults): ImportRow[] {
  return parseGherkin(text).map((sc, i) => {
    const tags = (sc.tags ?? []).map((t) => t.toLowerCase());
    const priority = tags.map((t) => normalizePriority(t)).find((p): p is Priority => !!p && /^p[0-3]$/i.test(p)) ?? null;
    const platforms = (['android', 'ios'] as const).filter((p) => tags.includes(p));
    const draft: TestCaseDraft = {
      title: sc.name,
      priority: priority ?? defaults.priority,
      platforms: platforms.length ? platforms : [...defaults.platforms],
      preconditions: '',
      steps: sc.steps,
    };
    return makeRow(i + 1, draft, []);
  });
}

function makeRow(source: number, draft: TestCaseDraft, problems: string[]): ImportRow {
  const invalid = [...validateScenario({ name: draft.title, steps: draft.steps })];
  if (!draft.platforms.length) invalid.push('Pick at least one platform.');
  return {
    source,
    draft,
    problems: [...invalid, ...problems],
    existing: null,
    similar: null,
    state: invalid.length ? 'invalid' : 'ready',
  };
}

/**
 * Marks rows whose name matches an open case in the feature (already imported, so a
 * re-run skips them) and rows that closely resemble one (shown as a warning).
 * Rows repeated within the same import are flagged too.
 */
export function markAgainst(rows: ImportRow[], cases: TestCase[]): ImportRow[] {
  const open = cases.filter((c) => !c.closed);
  const seen = new Set<string>();
  return rows.map((row) => {
    const key = row.draft.title.trim().toLowerCase();
    const existing = open.find((c) => c.title.trim().toLowerCase() === key) ?? null;
    const similar = existing ? null : (findSimilar(row.draft, open)[0]?.testCase ?? null);
    const problems = [...row.problems];
    let state = row.state;
    if (existing) state = 'exists';
    else if (key && seen.has(key) && state === 'ready') {
      state = 'invalid';
      problems.push('Same name as an earlier row in this import.');
    }
    if (key) seen.add(key);
    return { ...row, existing, similar, problems, state };
  });
}

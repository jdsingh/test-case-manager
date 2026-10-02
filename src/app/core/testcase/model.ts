// A test case is a GitHub issue (PRD section 6): labels hold its state, the body holds
// the scenario inside a marked block, comments hold reviews and runs.

import { Platform, Priority, PRIORITIES } from '../config/team-config';
import { Scenario, Step, parseGherkin, renderGherkin } from './gherkin';

export const STATUSES = [
  'draft',
  'in-review',
  'changes-requested',
  'approved',
  'passed',
  'failed',
  'blocked',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Draft',
  'in-review': 'In review',
  'changes-requested': 'Changes requested',
  approved: 'Approved',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
};

export const PLATFORM_NAMES: Record<Platform, string> = { android: 'Android', ios: 'iOS' };

export const TESTCASE_LABEL = 'testcase';
export const REGRESSION_LABEL = 'regression';
const MARKER = '<!-- tcm:testcase v1 -->';

export interface Person {
  login: string;
  avatarUrl: string;
}

export interface TestCase {
  id: string; // issue node id
  number: number;
  url: string;
  title: string; // scenario name, without the [TC] prefix
  priority: Priority | null;
  platforms: Platform[];
  status: Status | null;
  regression: boolean;
  closed: boolean;
  preconditions: string;
  steps: Step[];
  /** Text in the issue body outside the app's block, kept untouched on save. */
  extraBody: string;
  /** False when the body has no parsable test case block (e.g. hand-written issue). */
  parsed: boolean;
  labels: string[];
  assignees: Person[];
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The fields a person edits; everything else is derived or managed by the app. */
export interface TestCaseDraft {
  title: string;
  priority: Priority;
  platforms: Platform[];
  preconditions: string;
  steps: Step[];
}

export function issueTitle(title: string): string {
  return `[TC] ${title.trim()}`;
}

export function stripTitlePrefix(title: string): string {
  return title.replace(/^\s*\[TC\]\s*/i, '').trim();
}

/** Renders the app's block, followed by any extra text that was already in the body. */
export function renderBody(d: TestCaseDraft, extraBody = ''): string {
  const platforms = d.platforms.map((p) => PLATFORM_NAMES[p]).join(', ') || '—';
  const pre = d.preconditions.trim() ? `**Preconditions:** ${d.preconditions.trim()}\n\n` : '';
  const gherkin = renderGherkin({ name: d.title, steps: d.steps });
  const block = `${MARKER}\n**Priority:** ${d.priority} · **Platforms:** ${platforms}\n\n${pre}\`\`\`gherkin\n${gherkin}\n\`\`\`\n`;
  const extra = extraBody.trim();
  return extra ? `${block}\n${extra}\n` : block;
}

export interface ParsedBody {
  parsed: boolean;
  priority: Priority | null;
  platforms: Platform[];
  preconditions: string;
  scenario: Scenario | null;
  extraBody: string;
}

/** Reads the app's block out of an issue body. Text before or after it is kept as `extraBody`. */
export function parseBody(body: string): ParsedBody {
  const empty: ParsedBody = { parsed: false, priority: null, platforms: [], preconditions: '', scenario: null, extraBody: body };
  const start = body.indexOf(MARKER);
  if (start < 0) return empty;
  const fenceOpen = body.indexOf('```gherkin', start);
  if (fenceOpen < 0) return empty;
  const fenceClose = body.indexOf('```', fenceOpen + 10);
  if (fenceClose < 0) return empty;
  const header = body.slice(start + MARKER.length, fenceOpen);
  const gherkin = body.slice(fenceOpen + 10, fenceClose);
  const before = body.slice(0, start).trim();
  const after = body.slice(fenceClose + 3).trim();

  const pri = /\*\*Priority:\*\*\s*(P[0-3])/.exec(header)?.[1] as Priority | undefined;
  const platLine = /\*\*Platforms:\*\*\s*([^\n]*)/.exec(header)?.[1] ?? '';
  const platforms: Platform[] = [];
  if (/android/i.test(platLine)) platforms.push('android');
  if (/ios/i.test(platLine)) platforms.push('ios');
  const pre = /\*\*Preconditions:\*\*\s*([\s\S]*?)\s*$/.exec(header)?.[1] ?? '';

  return {
    parsed: true,
    priority: pri && (PRIORITIES as readonly string[]).includes(pri) ? pri : null,
    platforms,
    preconditions: pre.trim(),
    scenario: parseGherkin(gherkin)[0] ?? { name: '', steps: [] },
    extraBody: [before, after].filter(Boolean).join('\n\n'),
  };
}

export interface IssueNode {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  assignees: { nodes: Person[] };
  labels: { nodes: { name: string }[] };
}

/** Builds a TestCase from an issue. Labels win over the body for priority and platforms. */
export function fromIssue(issue: IssueNode): TestCase {
  const labels = issue.labels.nodes.map((l) => l.name);
  const lower = labels.map((l) => l.toLowerCase());
  const body = parseBody(issue.body ?? '');
  const labelPriority = PRIORITIES.find((p) => lower.includes(`priority:${p.toLowerCase()}`)) ?? null;
  const labelPlatforms = (['android', 'ios'] as const).filter((p) => lower.includes(`platform:${p}`));
  const status = STATUSES.find((s) => lower.includes(`status:${s}`)) ?? null;
  return {
    id: issue.id,
    number: issue.number,
    url: issue.url,
    title: stripTitlePrefix(issue.title),
    priority: labelPriority ?? body.priority,
    platforms: labelPlatforms.length ? labelPlatforms : body.platforms,
    status,
    regression: lower.includes(REGRESSION_LABEL),
    closed: issue.state === 'CLOSED',
    preconditions: body.preconditions,
    steps: body.scenario?.steps ?? [],
    extraBody: body.extraBody,
    parsed: body.parsed,
    labels,
    assignees: issue.assignees.nodes,
    author: issue.author?.login ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

/**
 * The full label set for a case: the app's labels for its state, plus any labels people
 * added by hand (kept as they are).
 */
export function labelsFor(
  existing: string[],
  state: { priority: Priority; platforms: Platform[]; status: Status; regression: boolean },
): string[] {
  const ours = (l: string) =>
    /^(priority|platform|status):/i.test(l) || [TESTCASE_LABEL, REGRESSION_LABEL].includes(l.toLowerCase());
  const kept = existing.filter((l) => !ours(l));
  return [
    TESTCASE_LABEL,
    `priority:${state.priority}`,
    ...state.platforms.map((p) => `platform:${p}`),
    `status:${state.status}`,
    ...(state.regression ? [REGRESSION_LABEL] : []),
    ...kept,
  ];
}

export function draftOf(tc: TestCase): TestCaseDraft {
  return {
    title: tc.title,
    priority: tc.priority ?? 'P2',
    platforms: [...tc.platforms],
    preconditions: tc.preconditions,
    steps: tc.steps.map((s) => ({ ...s })),
  };
}

export function emptyDraft(): TestCaseDraft {
  return {
    title: '',
    priority: 'P1',
    platforms: ['android', 'ios'],
    preconditions: '',
    steps: [
      { keyword: 'Given', text: '' },
      { keyword: 'When', text: '' },
      { keyword: 'Then', text: '' },
    ],
  };
}

/** A short human summary of what an edit changed (AU-8's comment). */
export function describeEdit(before: TestCaseDraft, after: TestCaseDraft): string[] {
  const changes: string[] = [];
  if (before.title.trim() !== after.title.trim()) changes.push(`renamed to "${after.title.trim()}"`);
  if (before.priority !== after.priority) changes.push(`priority ${before.priority} → ${after.priority}`);
  if (before.platforms.join() !== after.platforms.join()) {
    const name = (ps: Platform[]) => ps.map((p) => PLATFORM_NAMES[p]).join(' + ') || 'none';
    changes.push(`platforms ${name(before.platforms)} → ${name(after.platforms)}`);
  }
  if (before.preconditions.trim() !== after.preconditions.trim()) changes.push('preconditions');
  const steps = (d: TestCaseDraft) => d.steps.map((s) => `${s.keyword} ${s.text.trim()}`).join('\n');
  if (steps(before) !== steps(after)) changes.push('steps');
  return changes;
}

/** Whether an edit of this kind changes what reviewers approved (AU-8). */
export function isScenarioChange(before: TestCaseDraft, after: TestCaseDraft): boolean {
  return describeEdit(before, after).some((c) => c !== `priority ${before.priority} → ${after.priority}`);
}

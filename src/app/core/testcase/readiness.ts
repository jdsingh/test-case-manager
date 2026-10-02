// The tech lead's view (PRD 5.4 and RR-1 to RR-4): counts, platform progress, the
// ship verdict and a burndown. Pure functions over the loaded cases and their comments.

import { PRIORITIES, Platform, Priority } from '../config/team-config';
import { CommentNode } from '../github/api';
import { PLATFORM_NAMES, STATUSES, STATUS_LABELS, Status, TestCase } from './model';
import { BugLink, RunEvent, canRun, runsOf, sameVersion } from './runs';
import { historyOf } from './review';
import { parseMarker } from './comments';

export type SlotResult = 'pass' | 'fail' | 'blocked' | 'none';

/** Result per platform from the run:<platform>:<result> labels (the target version's). */
export function slotResult(tc: TestCase, p: Platform): SlotResult {
  const l = tc.labels.map((x) => x.toLowerCase());
  if (l.includes(`run:${p}:failed`)) return 'fail';
  if (l.includes(`run:${p}:blocked`)) return 'blocked';
  if (l.includes(`run:${p}:passed`)) return 'pass';
  return 'none';
}

export type Grid = Record<Priority, Record<Status, number>>;

/** DB-1: open cases by priority × status. */
export function statusGrid(cases: TestCase[]): Grid {
  const grid = Object.fromEntries(
    PRIORITIES.map((p) => [p, Object.fromEntries(STATUSES.map((s) => [s, 0]))]),
  ) as Grid;
  for (const c of cases) {
    if (c.closed || !c.priority || !c.status) continue;
    grid[c.priority][c.status]++;
  }
  return grid;
}

export interface PlatformProgress {
  platform: Platform;
  pass: number;
  fail: number;
  blocked: number;
  none: number;
  total: number;
}

/** DB-2: per platform, approved cases by latest result on the target version. */
export function platformProgress(cases: TestCase[]): PlatformProgress[] {
  return (['android', 'ios'] as const).map((platform) => {
    const p: PlatformProgress = { platform, pass: 0, fail: 0, blocked: 0, none: 0, total: 0 };
    for (const c of cases) {
      if (!canRun(c) || !c.platforms.includes(platform)) continue;
      p[slotResult(c, platform)]++;
      p.total++;
    }
    return p;
  });
}

export interface Verdict {
  ready: boolean;
  /** RR-1: the one line, e.g. "Not ready: 2 P0 failing on iOS, 5 P0 not run". */
  headline: string;
  /** What blocks shipping, most serious first. */
  reasons: string[];
  /** Failures outside the blocking priorities: shown, but they don't block. */
  warnings: string[];
  blockingTotal: number;
}

const join = (parts: string[]) => parts.join(', ');

/**
 * DB-3: ready when every open case in a blocking priority has passed on every target
 * platform on the target version.
 */
export function verdict(cases: TestCase[], blocking: Priority[], targetVersion: string | null): Verdict {
  const open = cases.filter((c) => !c.closed);
  const isBlocking = (c: TestCase) => !!c.priority && blocking.includes(c.priority);
  const blockingCases = open.filter(isBlocking);
  const label = blocking.join('/');
  const reasons: string[] = [];

  for (const p of ['android', 'ios'] as const) {
    const failing = blockingCases.filter((c) => c.platforms.includes(p) && slotResult(c, p) === 'fail').length;
    if (failing) reasons.push(`${failing} ${label} failing on ${PLATFORM_NAMES[p]}`);
  }
  for (const p of ['android', 'ios'] as const) {
    const blocked = blockingCases.filter((c) => c.platforms.includes(p) && slotResult(c, p) === 'blocked').length;
    if (blocked) reasons.push(`${blocked} ${label} blocked on ${PLATFORM_NAMES[p]}`);
  }
  const notApproved = blockingCases.filter((c) => !canRun(c)).length;
  const notRun = blockingCases.filter((c) => canRun(c) && c.platforms.some((p) => slotResult(c, p) === 'none')).length;
  if (notRun) reasons.push(`${notRun} ${label} not run`);
  if (notApproved) reasons.push(`${notApproved} ${label} not approved yet`);

  const warnings: string[] = [];
  const others = PRIORITIES.filter((p) => !blocking.includes(p));
  for (const pr of others) {
    const failing = open.filter((c) => c.priority === pr && c.platforms.some((p) => slotResult(c, p) === 'fail')).length;
    if (failing) warnings.push(`${failing} ${pr} failing`);
  }

  const on = targetVersion ? ` on v${targetVersion}` : '';
  if (!blockingCases.length) {
    return {
      ready: false,
      headline: `No ${label} test cases yet, so readiness can't be judged.`,
      reasons: [`Add ${label} test cases for this feature.`],
      warnings,
      blockingTotal: 0,
    };
  }
  const ready = reasons.length === 0;
  return {
    ready,
    headline: ready
      ? `Ready to ship: all ${blockingCases.length} ${label} case${blockingCases.length === 1 ? '' : 's'} passed${on}.`
      : `Not ready: ${join(reasons)}.`,
    reasons,
    warnings,
    blockingTotal: blockingCases.length,
  };
}

export interface Blocker {
  tc: TestCase;
  /** What each target platform still needs, worst first. */
  gaps: { platform: Platform; state: 'fail' | 'blocked' | 'none' }[];
  /** The case can't be run yet because it isn't approved. */
  unapproved: boolean;
}

/** The cases standing between the feature and "ready", worst first: what the verdict counts, by name. */
export function blockers(cases: TestCase[], blocking: Priority[]): Blocker[] {
  const rank = { fail: 0, blocked: 1, none: 2 } as const;
  return cases
    .filter((c) => !c.closed && !!c.priority && blocking.includes(c.priority))
    .map((tc) => {
      const unapproved = !canRun(tc);
      const gaps = unapproved
        ? []
        : tc.platforms
            .map((platform) => ({ platform, state: slotResult(tc, platform) }))
            .filter((g): g is Blocker['gaps'][number] => g.state !== 'pass')
            .sort((a, b) => rank[a.state] - rank[b.state]);
      return { tc, gaps, unapproved };
    })
    .filter((b) => b.unapproved || b.gaps.length)
    .sort((a, b) => score(a) - score(b) || a.tc.number - b.tc.number);

  function score(b: Blocker): number {
    return b.unapproved ? 3 : rank[b.gaps[0].state];
  }
}

// ---- burndown (RR-2) ----------------------------------------------------------

export interface BurndownPoint {
  date: string; // YYYY-MM-DD
  remaining: number;
}

export interface Burndown {
  total: number;
  points: BurndownPoint[];
  start: string;
  end: string; // release date, or today if later/unset
}

const day = (iso: string) => iso.slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Runs still to do per day: of today's runnable case-platform slots, how many had not
 * yet got a passing (latest) run on the target version by the end of each day.
 */
export function burndown(
  cases: TestCase[],
  comments: Map<number, CommentNode[]>,
  targetVersion: string | null,
  releaseDate: string | null,
  today: string,
): Burndown | null {
  const slots: { tc: TestCase; p: Platform; runs: RunEvent[]; since: string | null }[] = [];
  for (const tc of cases) {
    if (!canRun(tc)) continue;
    const cs = comments.get(tc.number) ?? [];
    const runs = runsOf(cs).filter((r) => !targetVersion || sameVersion(r.appVersion, targetVersion));
    const since = historyOf(cs).versionStart;
    for (const p of tc.platforms) slots.push({ tc, p, runs: runs.filter((r) => r.platform === p), since });
  }
  if (!slots.length) return null;
  const runDays = slots.flatMap((s) => s.runs.map((r) => day(r.executedAt)));
  const first = runDays.length ? runDays.reduce((a, b) => (a < b ? a : b)) : today;
  const start = addDays(first < today ? first : today, -1);
  const end = releaseDate && releaseDate > today ? releaseDate : today;
  const points: BurndownPoint[] = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const cutoff = `${d}T23:59:59.999Z`;
    let remaining = 0;
    for (const s of slots) {
      const upTo = s.runs.filter((r) => r.executedAt <= cutoff && (!s.since || r.postedAt >= s.since));
      if (upTo.at(-1)?.result !== 'pass') remaining++;
    }
    points.push({ date: d, remaining });
  }
  return { total: slots.length, points, start, end };
}

// ---- what changed (RR-3) ------------------------------------------------------

export interface ChangeEvent {
  at: string;
  who: string;
  caseNumber: number;
  caseTitle: string;
  kind: 'approved' | 'changes' | 'pass' | 'fail' | 'blocked' | 'bug' | 'submitted';
  text: string;
}

export function changesSince(cases: TestCase[], comments: Map<number, CommentNode[]>, since: string): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  for (const tc of cases) {
    for (const c of comments.get(tc.number) ?? []) {
      if (c.createdAt <= since) continue;
      const m = parseMarker(c.body);
      if (!m) continue;
      const who = c.author?.login ?? 'ghost';
      const base = { at: c.createdAt, who, caseNumber: tc.number, caseTitle: tc.title };
      const plat = m.data['platform'] === 'ios' ? 'iOS' : m.data['platform'] === 'android' ? 'Android' : '';
      if (m.kind === 'review') {
        const approve = m.data['decision'] === 'approve';
        out.push({ ...base, kind: approve ? 'approved' : 'changes', text: approve ? 'approved' : 'requested changes' });
      } else if (m.kind === 'run') {
        const r = m.data['result'];
        const kind = r === 'pass' ? 'pass' : r === 'fail' ? 'fail' : 'blocked';
        const word = kind === 'pass' ? 'passed' : kind === 'fail' ? 'failed' : 'got blocked';
        out.push({ ...base, kind, text: `${word} on ${plat} v${String(m.data['appVersion'] ?? '?')}` });
      } else if (m.kind === 'bug') {
        out.push({ ...base, kind: 'bug', text: `filed a bug${plat ? ` for ${plat}` : ''}` });
      } else if (m.kind === 'submit') {
        out.push({ ...base, kind: 'submitted', text: m.data['resubmit'] ? 'resubmitted for review' : 'submitted for review' });
      }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ---- report (RR-4) ------------------------------------------------------------

export function readinessReport(args: {
  feature: string;
  targetVersion: string | null;
  releaseDate: string | null;
  verdict: Verdict;
  grid: Grid;
  progress: PlatformProgress[];
  problems: { tc: TestCase; platform: Platform; result: 'fail' | 'blocked'; bugs: BugLink[] }[];
  generatedAt: string;
}): string {
  const { verdict: v } = args;
  const meta = [args.targetVersion ? `target v${args.targetVersion}` : 'no target version', args.releaseDate ? `release ${args.releaseDate}` : null]
    .filter(Boolean)
    .join(' · ');
  const lines = [`## ${args.feature}: test readiness`, '', `**${v.ready ? '✅' : '⛔'} ${v.headline}**`, '', `_${meta} · ${args.generatedAt}_`, ''];
  if (v.warnings.length) lines.push(`Also: ${v.warnings.join(', ')} (not blocking).`, '');
  lines.push('| Platform | Passed | Failed | Blocked | Not run |', '| --- | ---: | ---: | ---: | ---: |');
  for (const p of args.progress) {
    if (!p.total) continue;
    lines.push(`| ${PLATFORM_NAMES[p.platform]} | ${p.pass} | ${p.fail} | ${p.blocked} | ${p.none} |`);
  }
  lines.push('');
  const shown = STATUSES.filter((s) => PRIORITIES.some((p) => args.grid[p][s] > 0));
  if (shown.length) {
    lines.push(`| Priority | ${shown.map((s) => STATUS_LABELS[s]).join(' | ')} |`, `| --- | ${shown.map(() => '---:').join(' | ')} |`);
    for (const p of PRIORITIES) {
      if (shown.every((s) => args.grid[p][s] === 0)) continue;
      lines.push(`| ${p} | ${shown.map((s) => args.grid[p][s]).join(' | ')} |`);
    }
    lines.push('');
  }
  if (args.problems.length) {
    lines.push('**Failing or blocked**', '');
    for (const pr of args.problems) {
      const bugs = pr.bugs.length ? ` · bug ${pr.bugs.map((b) => `[${b.issue}](${b.url})`).join(', ')}` : '';
      lines.push(`- ${pr.tc.priority ?? ''} [#${pr.tc.number} ${pr.tc.title}](${pr.tc.url}): ${pr.result === 'fail' ? 'failed' : 'blocked'} on ${PLATFORM_NAMES[pr.platform]}${bugs}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}


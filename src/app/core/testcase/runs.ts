// Test runs (PRD 5.5): each run is a comment; the latest run on the target version decides
// each platform's result (EX-3, DB-5), and the case's status follows from those.

import { Platform } from '../config/team-config';
import { CommentNode } from '../github/api';
import { EvidenceRef, evidenceMarkdown } from '../evidence/evidence';
import { parseMarker } from './comments';
import { PLATFORM_NAMES, Status, TestCase } from './model';

export type RunResult = 'pass' | 'fail' | 'blocked';
export type Environment = 'staging' | 'production';

export const RESULT_LABELS: Record<RunResult, string> = { pass: 'Passed', fail: 'Failed', blocked: 'Blocked' };
const RESULT_ICONS: Record<RunResult, string> = { pass: '✅', fail: '❌', blocked: '⛔' };
/** Label suffixes used by run:<platform>:<suffix>. */
export const RESULT_LABEL_SUFFIX: Record<RunResult, string> = { pass: 'passed', fail: 'failed', blocked: 'blocked' };

export interface RunMeta {
  platform: Platform;
  result: RunResult;
  appVersion: string;
  build: string;
  device: string;
  os: string;
  env: Environment;
  executedAt: string; // ISO
}

export interface RunEvent extends RunMeta {
  id: string;
  url: string;
  /** Who ran it: the comment's GitHub author, never a typed name (PRD section 6). */
  author: string;
  avatarUrl: string;
  postedAt: string;
  notes: string;
  evidence: EvidenceRef[];
}

export interface BugLink {
  platform: Platform | null;
  issue: string; // owner/repo#n
  url: string;
}

export function runComment(nameWithOwner: string, meta: RunMeta, notes: string, evidence: EvidenceRef[]): string {
  const data = { ...meta, notes: notes.trim(), evidence };
  const json = JSON.stringify(data).replace(/-->/g, '--\\u003e');
  const where = [
    `v${meta.appVersion}${meta.build ? ` (${meta.build})` : ''}`,
    [meta.device, meta.os].filter(Boolean).join(', '),
    meta.env,
  ].filter(Boolean);
  const head = `${RESULT_ICONS[meta.result]} **${RESULT_LABELS[meta.result]} on ${PLATFORM_NAMES[meta.platform]}** · ${where.join(' · ')}`;
  const parts = [`<!-- tcm:run ${json} -->`, head];
  if (notes.trim()) parts.push(`Notes: ${notes.trim()}`);
  if (evidence.length) parts.push(evidence.map((e) => evidenceMarkdown(nameWithOwner, e)).join('\n'));
  return parts.join('\n\n');
}

export function bugComment(link: BugLink): string {
  const json = JSON.stringify(link);
  const on = link.platform ? ` on ${PLATFORM_NAMES[link.platform]}` : '';
  return `<!-- tcm:bug ${json} -->\n🐞 **Bug filed${on}:** ${link.url}`;
}

function isResult(v: unknown): v is RunResult {
  return v === 'pass' || v === 'fail' || v === 'blocked';
}

/** All runs in the comments, oldest first by when they were executed. */
export function runsOf(comments: CommentNode[]): RunEvent[] {
  const out: RunEvent[] = [];
  for (const c of comments) {
    const m = parseMarker(c.body);
    if (!m || m.kind !== 'run') continue;
    const d = m.data;
    const platform = d['platform'];
    if ((platform !== 'android' && platform !== 'ios') || !isResult(d['result'])) continue;
    out.push({
      id: c.id,
      url: c.url,
      author: c.author?.login ?? 'ghost',
      avatarUrl: c.author?.avatarUrl ?? '',
      postedAt: c.createdAt,
      platform,
      result: d['result'],
      appVersion: String(d['appVersion'] ?? ''),
      build: String(d['build'] ?? ''),
      device: String(d['device'] ?? ''),
      os: String(d['os'] ?? ''),
      env: d['env'] === 'production' ? 'production' : 'staging',
      executedAt: typeof d['executedAt'] === 'string' && !isNaN(Date.parse(d['executedAt'])) ? d['executedAt'] : c.createdAt,
      notes: typeof d['notes'] === 'string' ? d['notes'] : '',
      evidence: Array.isArray(d['evidence'])
        ? (d['evidence'] as EvidenceRef[]).filter((e) => e && typeof e.path === 'string')
        : [],
    });
  }
  return out.sort((a, b) => a.executedAt.localeCompare(b.executedAt) || a.postedAt.localeCompare(b.postedAt));
}

export function bugsOf(comments: CommentNode[]): BugLink[] {
  const out: BugLink[] = [];
  for (const c of comments) {
    const m = /^\s*<!--\s*tcm:bug\s*(\{[\s\S]*?\})\s*-->/.exec(c.body);
    if (!m) continue;
    try {
      const d = JSON.parse(m[1]) as BugLink;
      if (typeof d.url === 'string') out.push(d);
    } catch {
      // ignore broken markers
    }
  }
  return out;
}

/**
 * The run that counts for each platform: the latest executed one on the target version
 * (any version when no target is set), among runs since the current version was approved.
 */
export function latestRuns(
  runs: RunEvent[],
  platforms: Platform[],
  targetVersion: string | null,
  since: string | null,
): Partial<Record<Platform, RunEvent>> {
  const out: Partial<Record<Platform, RunEvent>> = {};
  for (const p of platforms) {
    const counted = runs.filter(
      (r) =>
        r.platform === p &&
        (!targetVersion || sameVersion(r.appVersion, targetVersion)) &&
        (!since || r.postedAt >= since),
    );
    const last = counted.at(-1);
    if (last) out[p] = last;
  }
  return out;
}

export function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/^v/i, '');
  return norm(a) === norm(b);
}

/** Case status from the counted runs: any fail → failed, any blocked → blocked, all pass → passed. */
export function statusFromRuns(platforms: Platform[], latest: Partial<Record<Platform, RunEvent>>): Status {
  const results = platforms.map((p) => latest[p]?.result ?? null);
  if (results.includes('fail')) return 'failed';
  if (results.includes('blocked')) return 'blocked';
  if (results.length && results.every((r) => r === 'pass')) return 'passed';
  return 'approved';
}

/** Run labels (run:<platform>:<result>) for the counted runs. */
export function runLabels(latest: Partial<Record<Platform, RunEvent>>): string[] {
  return (Object.entries(latest) as [Platform, RunEvent][]).map(([p, r]) => `run:${p}:${RESULT_LABEL_SUFFIX[r.result]}`);
}

/** Whether runs can be recorded (EX-7): only once the case has been approved. */
export function canRun(tc: TestCase): boolean {
  return !tc.closed && ['approved', 'passed', 'failed', 'blocked'].includes(tc.status ?? '');
}

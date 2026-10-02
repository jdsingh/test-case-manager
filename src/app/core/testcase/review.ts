// Review rules (PRD 5.3, AU-9, RV-4) and per-step comments (LR-1, LR-2), worked out from
// an issue's comments. Pure functions so they can be unit-tested.

import { Platform, TeamConfig, includesLogin, sameLogin } from '../config/team-config';
import { CommentNode } from '../github/api';
import { commentText, parseMarker } from './comments';
import { TestCase } from './model';

export type Decision = 'approve' | 'request_changes';

export interface ReviewEvent {
  id: string;
  author: string;
  createdAt: string;
  platform: Platform | null;
  decision: Decision;
  note: string;
  /** False once the case was resubmitted or its scenario edited afterwards (RV-4). */
  current: boolean;
}

export interface LineNote {
  id: string;
  url: string;
  author: string;
  avatarUrl: string;
  createdAt: string;
  step: number;
  original: string;
  note: string;
  suggestion: string | null;
}

export interface CaseHistory {
  reviews: ReviewEvent[];
  /** When the version under review started: the latest submit or scenario edit. */
  versionStart: string | null;
  /** Who made the latest scenario edit, if any, since the last submit (AU-9). */
  lastEditor: string | null;
  lineNotes: LineNote[];
}

/** Text after the quoted step line and before the suggestion, i.e. the reviewer's words. */
function lineNoteText(body: string): string {
  return commentText(body)
    .split('\n')
    .filter((l) => !/^💬 \*\*Comment on step/.test(l) && !l.startsWith('> Step ') && !l.startsWith('**Suggested wording:**'))
    .join('\n')
    .trim();
}

export function historyOf(comments: CommentNode[]): CaseHistory {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let versionStart: string | null = null;
  let lastEditor: string | null = null;
  const raw: Omit<ReviewEvent, 'current'>[] = [];
  const lineNotes: LineNote[] = [];

  for (const c of sorted) {
    const m = parseMarker(c.body);
    if (!m) continue;
    const author = c.author?.login ?? 'ghost';
    if (m.kind === 'submit') {
      versionStart = c.createdAt;
      lastEditor = null;
    } else if (m.kind === 'edit') {
      const changes = Array.isArray(m.data['changes']) ? (m.data['changes'] as string[]) : [];
      const scenarioChanged = changes.some((ch) => !/^priority /.test(ch));
      if (scenarioChanged) {
        versionStart = c.createdAt;
        lastEditor = author;
      }
    } else if (m.kind === 'review') {
      const decision = m.data['decision'];
      if (decision !== 'approve' && decision !== 'request_changes') continue;
      const platform = m.data['platform'] === 'android' || m.data['platform'] === 'ios' ? (m.data['platform'] as Platform) : null;
      const text = commentText(c.body).split('\n').slice(1).join('\n').trim();
      raw.push({ id: c.id, author, createdAt: c.createdAt, platform, decision, note: text });
    } else if (m.kind === 'line') {
      const step = Number(m.data['step']);
      if (!Number.isInteger(step) || step < 0) continue;
      lineNotes.push({
        id: c.id,
        url: c.url,
        author,
        avatarUrl: c.author?.avatarUrl ?? '',
        createdAt: c.createdAt,
        step,
        original: String(m.data['original'] ?? ''),
        note: lineNoteText(c.body),
        suggestion: typeof m.data['suggestion'] === 'string' ? (m.data['suggestion'] as string) : null,
      });
    }
  }
  const reviews = raw.map((r) => ({ ...r, current: !versionStart || r.createdAt >= versionStart }));
  return { reviews, versionStart, lastEditor, lineNotes };
}

export type ReviewCheck = { ok: true; platform: Platform } | { ok: false; reason: string };

/**
 * Whether `login` may approve or request changes on the case now (RV-2, AU-9), and which
 * platform their review is recorded under.
 */
export function canReview(tc: TestCase, history: CaseHistory, config: TeamConfig | null, login: string): ReviewCheck {
  if (tc.closed) return { ok: false, reason: 'This case is closed.' };
  if (tc.status !== 'in-review') return { ok: false, reason: 'This case is not waiting for review.' };
  if (!config) return { ok: false, reason: 'The team config is missing.' };
  const mine = tc.platforms.filter((p) => includesLogin(config.team[p], login));
  if (!mine.length) {
    const need = tc.platforms.map((p) => (p === 'ios' ? 'iOS' : 'Android')).join(' or ');
    return { ok: false, reason: `Only ${need} engineers can review this case.` };
  }
  if (history.lastEditor && sameLogin(history.lastEditor, login)) {
    return { ok: false, reason: 'You edited this version, so another engineer needs to review it.' };
  }
  // Record the review under a platform nobody has reviewed in this version, if possible.
  const reviewed = new Set(history.reviews.filter((r) => r.current && r.platform).map((r) => r.platform));
  return { ok: true, platform: mine.find((p) => !reviewed.has(p)) ?? mine[0] };
}

/** Whether a step comment still points at the step's current wording. */
export function isOutdated(note: LineNote, tc: TestCase): boolean {
  return (tc.steps[note.step]?.text ?? null) !== note.original;
}

/** A suggestion counts as applied once the step reads as suggested. */
export function isApplied(note: LineNote, tc: TestCase): boolean {
  return note.suggestion !== null && tc.steps[note.step]?.text === note.suggestion;
}

/** Engineers who can run a case on a platform (AS-2). */
export function executorsFor(platform: Platform, config: TeamConfig | null): string[] {
  return config ? config.team[platform] : [];
}

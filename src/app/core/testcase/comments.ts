// Structured comments: a hidden JSON marker for the app, then readable text for GitHub
// (PRD section 6). Author and time always come from GitHub's comment fields.

import { Platform } from '../config/team-config';
import { PLATFORM_NAMES } from './model';

export type TcmKind = 'review' | 'run' | 'submit' | 'edit' | 'close';

export interface TcmMarker {
  kind: TcmKind;
  data: Record<string, unknown>;
}

const MARKER_RE = /^\s*<!--\s*tcm:(review|run|submit|edit|close)\s*(\{[\s\S]*?\})?\s*-->/;

export function parseMarker(body: string): TcmMarker | null {
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  let data: Record<string, unknown> = {};
  if (m[2]) {
    try {
      const parsed = JSON.parse(m[2]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch {
      return null;
    }
  }
  return { kind: m[1] as TcmKind, data };
}

/** The readable part of a structured comment (everything after the marker). */
export function commentText(body: string): string {
  return body.replace(MARKER_RE, '').trim();
}

function marker(kind: TcmKind, data: Record<string, unknown> = {}): string {
  const json = Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
  return `<!-- tcm:${kind}${json} -->`;
}

const mention = (logins: string[]) => logins.map((l) => `@${l}`).join(' ');

export function submitComment(reviewers: string[], resubmit: boolean): string {
  const head = resubmit ? '🔁 **Resubmitted for review**' : '📝 **Submitted for review**';
  const ask = reviewers.length ? `\n\n${mention(reviewers)} please review.` : '';
  return `${marker('submit', { reviewers, resubmit })}\n${head}${ask}`;
}

export function editComment(changes: string[], backToReview: boolean, reviewers: string[]): string {
  const what = changes.length ? `Changed ${changes.join(', ')}.` : 'Edited.';
  const review = backToReview
    ? `\n\nThe scenario changed, so it needs review again.${reviewers.length ? ` ${mention(reviewers)}` : ''}`
    : '';
  return `${marker('edit', { changes, backToReview })}\n✏️ **Edited.** ${what}${review}`;
}

export function closeComment(reason: string): string {
  return `${marker('close', { reason })}\n🚫 **Closed as won't test.**${reason.trim() ? `\n\n${reason.trim()}` : ''}`;
}

export function reviewComment(platform: Platform, decision: 'approve' | 'request_changes', note: string): string {
  const name = PLATFORM_NAMES[platform];
  const head = decision === 'approve' ? `✅ **Approved for ${name}**` : `✏️ **Changes requested (${name})**`;
  return `${marker('review', { platform, decision })}\n${head}${note.trim() ? `\n\n${note.trim()}` : ''}`;
}

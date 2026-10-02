// Structured comments: a hidden JSON marker for the app, then readable text for GitHub
// (PRD section 6). Author and time always come from GitHub's comment fields.

import { Platform } from '../config/team-config';
import { PLATFORM_NAMES } from './model';

export type TcmKind = 'review' | 'run' | 'submit' | 'edit' | 'close' | 'line' | 'assign' | 'bug' | 'remind';

export interface TcmMarker {
  kind: TcmKind;
  data: Record<string, unknown>;
}

const MARKER_RE = /^\s*<!--\s*tcm:(review|run|submit|edit|close|line|assign|bug|remind)\s*(\{[\s\S]*?\})?\s*-->/;

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
  // "-->" in user text would end the HTML comment early; \u003e still parses as ">".
  const json = Object.keys(data).length ? ` ${JSON.stringify(data).replace(/-->/g, '--\\u003e')}` : '';
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

/**
 * A comment on one step (LR-1), optionally suggesting new wording (LR-2). The step's text
 * at the time is stored so the comment can show as outdated once the step changes.
 */
export function lineComment(step: number, original: string, note: string, suggestion?: string): string {
  const data: Record<string, unknown> = { step, original };
  if (suggestion !== undefined) data['suggestion'] = suggestion;
  const quote = `> Step ${step + 1}: ${original}`;
  const body = note.trim() ? `\n\n${note.trim()}` : '';
  const suggest = suggestion !== undefined ? `\n\n**Suggested wording:** ${suggestion}` : '';
  return `${marker('line', data)}\n💬 **Comment on step ${step + 1}**\n\n${quote}${body}${suggest}`;
}

export function assignComment(assignees: string[], stage: string): string {
  const who = assignees.length ? mention(assignees) : 'nobody';
  return `${marker('assign', { assignees, stage })}\n👤 **Assigned to ${who}** to ${stage}.`;
}

/** A nudge to whoever the case is waiting on (UX 3); it doesn't change the version. */
export function remindComment(who: string[]): string {
  return `${marker('remind', { who })}\n👋 ${mention(who)} gentle reminder: this case is waiting for your review.`;
}

import { describe, expect, test } from 'bun:test';
import { CommentNode } from '../github/api';
import { TeamConfig } from '../config/team-config';
import { editComment, lineComment, parseMarker, reviewComment, submitComment } from './comments';
import { IssueNode, fromIssue, renderBody } from './model';
import { canReview, historyOf, isApplied, isOutdated } from './review';

let t = 0;
function c(author: string, body: string): CommentNode {
  t++;
  return {
    id: `c${t}`,
    body,
    url: '',
    createdAt: `2026-10-01T10:${String(t).padStart(2, '0')}:00Z`,
    author: { login: author, avatarUrl: '' },
  };
}

const config: TeamConfig = {
  version: 1,
  team: { pm: ['priya'], techLead: ['alex'], android: ['sam', 'lee'], ios: ['jo'] },
  features: {},
  readiness: { blockingPriorities: ['P0'] },
  assignment: { defaultReviewer: {} },
  bugs: { repo: null },
};

function tcWith(status: string, platforms: ('android' | 'ios')[] = ['android', 'ios']) {
  const node: IssueNode = {
    id: 'I', number: 1, url: '', title: '[TC] X', state: 'OPEN', createdAt: '', updatedAt: '',
    author: { login: 'priya' }, assignees: { nodes: [] },
    body: renderBody({
      title: 'X', priority: 'P1', platforms, preconditions: '',
      steps: [
        { keyword: 'Given', text: 'a user' },
        { keyword: 'When', text: 'they pay' },
        { keyword: 'Then', text: 'an error is shown' },
      ],
    }),
    labels: { nodes: ['testcase', `status:${status}`, ...platforms.map((p) => `platform:${p}`)].map((name) => ({ name })) },
  };
  return fromIssue(node);
}

describe('history', () => {
  test('reviews before a resubmit are no longer current (RV-4)', () => {
    const h = historyOf([
      c('priya', submitComment(['sam'], false)),
      c('sam', reviewComment('android', 'request_changes', 'Too vague')),
      c('priya', editComment(['steps'], false, [])),
      c('priya', submitComment(['sam'], true)),
    ]);
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]).toMatchObject({ author: 'sam', decision: 'request_changes', note: 'Too vague', current: false });
  });

  test('a priority-only edit keeps reviews current', () => {
    const h = historyOf([
      c('priya', submitComment(['sam'], false)),
      c('sam', reviewComment('android', 'approve', '')),
      c('priya', editComment(['priority P1 → P0'], false, [])),
    ]);
    expect(h.reviews[0].current).toBe(true);
    expect(h.lastEditor).toBeNull();
  });

  test('records who last edited the scenario (AU-9)', () => {
    const h = historyOf([c('priya', submitComment(['sam'], false)), c('lee', editComment(['steps'], true, ['sam']))]);
    expect(h.lastEditor).toBe('lee');
  });

  test('reads the sandbox seed review format', () => {
    const seeded = '<!-- tcm:review {"platform":"android","decision":"request_changes"} -->\n✏️ **Changes requested (Android)**\n\n"An error is shown" is too vague.';
    const h = historyOf([c('jdsingh', seeded)]);
    expect(h.reviews[0].note).toBe('"An error is shown" is too vague.');
    expect(h.reviews[0].current).toBe(true);
  });
});

describe('canReview', () => {
  const empty = historyOf([]);

  test('only eligible engineers, only in review', () => {
    expect(canReview(tcWith('in-review'), empty, config, 'sam')).toEqual({ ok: true, platform: 'android' });
    expect(canReview(tcWith('in-review'), empty, config, 'jo')).toEqual({ ok: true, platform: 'ios' });
    expect(canReview(tcWith('in-review', ['ios']), empty, config, 'sam').ok).toBe(false);
    expect(canReview(tcWith('in-review'), empty, config, 'priya').ok).toBe(false);
    expect(canReview(tcWith('approved'), empty, config, 'sam').ok).toBe(false);
  });

  test("an engineer can't approve their own edit", () => {
    const h = historyOf([c('sam', editComment(['steps'], true, ['jo']))]);
    const r = canReview(tcWith('in-review'), h, config, 'sam');
    expect(r.ok).toBe(false);
    expect(canReview(tcWith('in-review'), h, config, 'lee').ok).toBe(true);
  });

  test('someone on both platforms is recorded under the unreviewed one', () => {
    const both = { ...config, team: { ...config.team, ios: ['jo', 'sam'] } };
    const h = historyOf([c('lee', reviewComment('android', 'request_changes', 'x')), c('priya', editComment(['priority P1 → P0'], false, []))]);
    expect(canReview(tcWith('in-review'), h, both, 'sam')).toEqual({ ok: true, platform: 'ios' });
  });
});

describe('line notes', () => {
  test('parse, outdated and applied', () => {
    const body = lineComment(2, 'an error is shown', 'Which error?', '"Card expired" shows under the card field');
    expect(parseMarker(body)?.kind).toBe('line');
    const h = historyOf([c('sam', body)]);
    const note = h.lineNotes[0];
    expect(note).toMatchObject({ step: 2, original: 'an error is shown', note: 'Which error?' });
    expect(note.suggestion).toBe('"Card expired" shows under the card field');
    const tc = tcWith('in-review');
    expect(isOutdated(note, tc)).toBe(false);
    expect(isApplied(note, tc)).toBe(false);
    tc.steps[2] = { keyword: 'Then', text: '"Card expired" shows under the card field' };
    expect(isOutdated(note, tc)).toBe(true);
    expect(isApplied(note, tc)).toBe(true);
  });

  test('step text with --> does not break the marker', () => {
    const h = historyOf([c('sam', lineComment(0, 'tap A --> B {x}', 'odd'))]);
    expect(h.lineNotes[0].original).toBe('tap A --> B {x}');
  });
});

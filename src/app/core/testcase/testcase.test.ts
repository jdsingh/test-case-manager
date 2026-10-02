import { describe, expect, test } from 'bun:test';
import { parseGherkin, renderGherkin, similarity, validateScenario, words } from './gherkin';
import {
  IssueNode,
  describeEdit,
  draftOf,
  fromIssue,
  isScenarioChange,
  labelsFor,
  parseBody,
  renderBody,
} from './model';
import { closeComment, commentText, editComment, parseMarker, reviewComment, submitComment } from './comments';

// The exact body the sandbox seed script (and the PRD example) produces.
const SEEDED = `<!-- tcm:testcase v1 -->
**Priority:** P0 · **Platforms:** Android, iOS

**Preconditions:** Logged-out user, one item in cart, card 4242… saved on device

\`\`\`gherkin
Scenario: Guest checkout with saved card
  Given a guest user with one item in the cart
    And a saved card on the device
  When the user taps "Pay" and confirms with biometrics
  Then the order confirmation screen shows an order number
    And a confirmation email is sent within 1 minute
\`\`\`
`;

function issue(over: Partial<IssueNode> = {}): IssueNode {
  return {
    id: 'I_1',
    number: 1,
    url: 'https://github.com/o/r/issues/1',
    title: '[TC] Guest checkout with saved card',
    body: SEEDED,
    state: 'OPEN',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    author: { login: 'priya' },
    assignees: { nodes: [] },
    labels: { nodes: ['testcase', 'priority:P0', 'platform:android', 'platform:ios', 'status:approved', 'regression'].map((name) => ({ name })) },
    ...over,
  };
}

describe('gherkin', () => {
  test('parses indentation, And/But, comments and multiple scenarios', () => {
    const s = parseGherkin(`Feature: Checkout
      # comment
      @smoke
      Scenario: One
        Given a
        But b
        When c
        Then d
      Scenario: Two
        Given x
        When y
        Then z`);
    expect(s.map((x) => x.name)).toEqual(['One', 'Two']);
    expect(s[0].steps.map((x) => x.keyword)).toEqual(['Given', 'And', 'When', 'Then']);
  });

  test('round-trips through render', () => {
    const [s] = parseGherkin(renderGherkin({
      name: 'X',
      steps: [
        { keyword: 'Given', text: 'a' },
        { keyword: 'And', text: 'b' },
        { keyword: 'When', text: 'c' },
        { keyword: 'Then', text: 'd' },
      ],
    }));
    expect(s.steps).toHaveLength(4);
    expect(s.steps[1]).toEqual({ keyword: 'And', text: 'b' });
  });

  test('validation enforces Given → When → Then', () => {
    const ok = { name: 'n', steps: [{ keyword: 'Given' as const, text: 'a' }, { keyword: 'When' as const, text: 'b' }, { keyword: 'Then' as const, text: 'c' }] };
    expect(validateScenario(ok)).toEqual([]);
    expect(validateScenario({ ...ok, name: '' })).toContain('Give the scenario a name.');
    const outOfOrder = { name: 'n', steps: [{ keyword: 'Given' as const, text: 'a' }, { keyword: 'Then' as const, text: 'c' }, { keyword: 'When' as const, text: 'b' }] };
    expect(validateScenario(outOfOrder).some((p) => p.includes('out of order'))).toBe(true);
    const noThen = { name: 'n', steps: [{ keyword: 'Given' as const, text: 'a' }, { keyword: 'When' as const, text: 'b' }] };
    expect(validateScenario(noThen)).toContain('Add at least one Then step.');
    const startsWithWhen = { name: 'n', steps: [{ keyword: 'When' as const, text: 'b' }, { keyword: 'Then' as const, text: 'c' }] };
    expect(validateScenario(startsWithWhen)).toContain('The first step must be a Given.');
  });

  test('similarity flags near-duplicates only', () => {
    const a = words('Guest checkout with saved card shows confirmation');
    expect(similarity(a, words('Guest checkout using a saved card shows the confirmation'))).toBeGreaterThan(0.6);
    expect(similarity(a, words('Promo code updates the order total'))).toBeLessThan(0.2);
  });
});

describe('issue model', () => {
  test('reads the seeded issue format', () => {
    const tc = fromIssue(issue());
    expect(tc.title).toBe('Guest checkout with saved card');
    expect(tc.priority).toBe('P0');
    expect(tc.platforms).toEqual(['android', 'ios']);
    expect(tc.status).toBe('approved');
    expect(tc.regression).toBe(true);
    expect(tc.preconditions).toStartWith('Logged-out user');
    expect(tc.steps).toHaveLength(5);
    expect(tc.parsed).toBe(true);
  });

  test('labels win over the body', () => {
    const tc = fromIssue(issue({ labels: { nodes: [{ name: 'testcase' }, { name: 'priority:P2' }, { name: 'platform:ios' }] } }));
    expect(tc.priority).toBe('P2');
    expect(tc.platforms).toEqual(['ios']);
  });

  test('render → parse round-trips and keeps extra text', () => {
    const d = draftOf(fromIssue(issue()));
    const body = renderBody(d, 'Notes from QA: use the staging account.');
    const parsed = parseBody(body);
    expect(parsed.scenario?.steps).toEqual(d.steps);
    expect(parsed.preconditions).toBe(d.preconditions);
    expect(parsed.extraBody).toBe('Notes from QA: use the staging account.');
    expect(body).toBe(renderBody(draftOf(fromIssue(issue({ body })))) + '\nNotes from QA: use the staging account.\n');
  });

  test('a hand-written issue is marked unparsed and keeps its text', () => {
    const tc = fromIssue(issue({ body: 'Just some notes' }));
    expect(tc.parsed).toBe(false);
    expect(tc.extraBody).toBe('Just some notes');
  });

  test('labelsFor replaces app labels and keeps hand-added ones', () => {
    expect(
      labelsFor(['testcase', 'priority:P0', 'status:draft', 'needs-design', 'platform:ios'], {
        priority: 'P1',
        platforms: ['android'],
        status: 'in-review',
        regression: false,
      }),
    ).toEqual(['testcase', 'priority:P1', 'platform:android', 'status:in-review', 'needs-design']);
  });

  test('describeEdit and scenario changes', () => {
    const before = draftOf(fromIssue(issue()));
    const priorityOnly = { ...before, priority: 'P1' as const };
    expect(describeEdit(before, priorityOnly)).toEqual(['priority P0 → P1']);
    expect(isScenarioChange(before, priorityOnly)).toBe(false);
    const stepEdit = { ...before, steps: [...before.steps, { keyword: 'And' as const, text: 'x' }] };
    expect(isScenarioChange(before, stepEdit)).toBe(true);
    expect(describeEdit(before, { ...before, platforms: ['ios'] })).toEqual(['platforms Android + iOS → iOS']);
  });
});

describe('comments', () => {
  test('markers round-trip', () => {
    for (const body of [
      submitComment(['sam'], false),
      editComment(['steps'], true, ['sam']),
      closeComment('Feature cut'),
      reviewComment('ios', 'request_changes', 'Too vague'),
    ]) {
      expect(parseMarker(body)).not.toBeNull();
    }
    const r = parseMarker(reviewComment('android', 'approve', ''));
    expect(r).toEqual({ kind: 'review', data: { platform: 'android', decision: 'approve' } });
    expect(commentText(submitComment(['sam', 'jo'], true))).toBe('🔁 **Resubmitted for review**\n\n@sam @jo please review.');
  });

  test('reads the seeded review format', () => {
    const seeded = '<!-- tcm:review {"platform":"android","decision":"request_changes"} -->\n✏️ **Changes requested (Android)**\n\nToo vague.';
    expect(parseMarker(seeded)?.data['decision']).toBe('request_changes');
  });

  test('ignores ordinary comments and broken markers', () => {
    expect(parseMarker('LGTM')).toBeNull();
    expect(parseMarker('<!-- tcm:review {broken -->')).toBeNull();
  });
});

import { buildStepLibrary, findSimilar } from './library';

describe('library', () => {
  const a = fromIssue(issue());
  const b = fromIssue(issue({
    id: 'I_2',
    number: 2,
    title: '[TC] Pay with Google Pay',
    body: renderBody({
      title: 'Pay with Google Pay',
      priority: 'P0',
      platforms: ['android'],
      preconditions: '',
      steps: [
        { keyword: 'Given', text: 'a guest user with one item in the cart' },
        { keyword: 'When', text: 'the user picks Google Pay and confirms' },
        { keyword: 'Then', text: 'the order confirmation screen shows an order number' },
      ],
    }),
  }));

  test('step library counts by section, And included', () => {
    const lib = buildStepLibrary([a, b]);
    expect(lib.Given[0]).toEqual({ text: 'a guest user with one item in the cart', count: 2 });
    expect(lib.Given.map((s) => s.text)).toContain('a saved card on the device');
    expect(lib.Then[0].count).toBe(2);
  });

  test('finds a near-duplicate and skips itself', () => {
    const draft = { ...draftOf(a), title: 'Guest checkout using a saved card' };
    expect(findSimilar(draft, [a, b]).map((s) => s.testCase.number)).toEqual([1]);
    expect(findSimilar(draftOf(a), [a, b], 1)).toEqual([]);
  });
});

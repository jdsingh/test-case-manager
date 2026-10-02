import { describe, expect, test } from 'bun:test';
import { detectDelimiter, parseDelimited, toCsv } from './csv';
import {
  ImportDefaults,
  detectMapping,
  markAgainst,
  normalizePlatforms,
  normalizePriority,
  rowsFromGherkin,
  rowsFromTable,
} from './import-rows';
import { casesToCsv, latestRun } from './export';
import { IssueNode, fromIssue, renderBody } from '../testcase/model';

const DEFAULTS: ImportDefaults = { priority: 'P2', platforms: ['android', 'ios'] };

describe('csv', () => {
  test('parses quotes, doubled quotes and newlines inside cells', () => {
    const rows = parseDelimited('a,b,c\n"x, y","he said ""hi""","line1\nline2"\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'line1\nline2'],
    ]);
  });

  test('detects tabs from a Google Sheets paste', () => {
    const text = 'Title\tPriority\nLogin\tP0\n';
    expect(detectDelimiter(text)).toBe('\t');
    expect(parseDelimited(text)).toEqual([['Title', 'Priority'], ['Login', 'P0']]);
  });

  test('handles CRLF, a BOM and blank lines', () => {
    expect(parseDelimited('﻿a,b\r\n\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  test('writes CSV that round-trips and neutralises formulas', () => {
    const csv = toCsv([['name', 'note'], ['=HYPERLINK("x")', 'a, "b"\nc']]);
    expect(csv.startsWith('﻿')).toBe(true);
    const back = parseDelimited(csv);
    expect(back[1][0]).toBe(`'=HYPERLINK("x")`);
    expect(back[1][1]).toBe('a, "b"\nc');
  });
});

describe('normalising', () => {
  test('priority', () => {
    expect(['P0', 'p1', '2', 'P 3', 'Critical', 'High', 'medium', 'Low', 'whatever', ''].map(normalizePriority)).toEqual([
      'P0', 'P1', 'P2', 'P3', 'P0', 'P1', 'P2', 'P3', null, null,
    ]);
  });

  test('platforms', () => {
    expect(normalizePlatforms('Android')).toEqual(['android']);
    expect(normalizePlatforms('iOS, Android')).toEqual(['android', 'ios']);
    expect(normalizePlatforms('Both')).toEqual(['android', 'ios']);
    expect(normalizePlatforms('iPhone only')).toEqual(['ios']);
    expect(normalizePlatforms('a web thing')).toBeNull();
  });
});

describe('sheet import', () => {
  const sheet = parseDelimited(
    [
      'Test case\tPriority\tPlatform\tPreconditions\tGiven\tWhen\tExpected result',
      'Login with email\tHigh\tBoth\tAccount exists\ta registered user\t"enters email\nand taps Log in"\tthe home screen shows',
      'Logout\tP3\tiOS\t\ta logged-in user\ttaps Log out\tthe login screen shows',
      'Broken row\tP1\tAndroid\t\t\tdoes something\t',
    ].join('\n'),
  );

  test('detects columns from headers', () => {
    const m = detectMapping(sheet[0]);
    expect(m.title).toBe(0);
    expect(m.priority).toBe(1);
    expect(m.platforms).toBe(2);
    expect(m.preconditions).toBe(3);
    expect(m.given).toBe(4);
    expect(m.when).toBe(5);
    expect(m.then).toBe(6);
    expect(m.scenario).toBe(-1);
  });

  test('builds drafts from separate Given/When/Then columns', () => {
    const rows = rowsFromTable(sheet, detectMapping(sheet[0]), DEFAULTS);
    expect(rows[0].state).toBe('ready');
    expect(rows[0].draft).toEqual({
      title: 'Login with email',
      priority: 'P1',
      platforms: ['android', 'ios'],
      preconditions: 'Account exists',
      steps: [
        { keyword: 'Given', text: 'a registered user' },
        { keyword: 'When', text: 'enters email' },
        { keyword: 'And', text: 'taps Log in' },
        { keyword: 'Then', text: 'the home screen shows' },
      ],
    });
    expect(rows[1].draft.platforms).toEqual(['ios']);
    expect(rows[2].state).toBe('invalid');
    expect(rows[2].source).toBe(4);
  });

  test('builds drafts from one Gherkin column and takes the title from it', () => {
    const t = parseDelimited('Steps,Priority\n"Scenario: Search\nGiven the home screen\nWhen the user searches ""shoes""\nThen results show",P0\n');
    const m = detectMapping(t[0]);
    const [row] = rowsFromTable(t, m, DEFAULTS);
    expect(row.state).toBe('ready');
    expect(row.draft.title).toBe('Search');
    expect(row.draft.steps[1].text).toBe('the user searches "shoes"');
  });

  test('keeps unknown values as warnings and falls back to defaults', () => {
    const t = [['Title', 'Priority', 'Platform', 'Given', 'When', 'Then'], ['X', 'urgent-ish?', 'web', 'a', 'b', 'c']];
    const [row] = rowsFromTable(t, detectMapping(t[0]), DEFAULTS);
    expect(row.draft.priority).toBe('P0'); // "urgent" maps to P0
    expect(row.draft.platforms).toEqual(['android', 'ios']);
    expect(row.problems.some((p) => p.includes('Unknown platform'))).toBe(true);
    expect(row.state).toBe('ready');
  });
});

describe('gherkin import', () => {
  test('several scenarios with tags', () => {
    const rows = rowsFromGherkin(
      `Feature: Checkout
      @P0 @ios
      Scenario: Apple Pay
        Given a cart
        When the user pays with Apple Pay
        Then the order is placed

      Scenario: No steps here`,
      DEFAULTS,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].draft.priority).toBe('P0');
    expect(rows[0].draft.platforms).toEqual(['ios']);
    expect(rows[0].state).toBe('ready');
    expect(rows[1].state).toBe('invalid');
  });
});

function caseNode(n: number, title: string, labels: string[], state: 'OPEN' | 'CLOSED' = 'OPEN'): IssueNode {
  return {
    id: `I_${n}`,
    number: n,
    url: `https://github.com/o/r/issues/${n}`,
    title: `[TC] ${title}`,
    body: renderBody({
      title, priority: 'P1', platforms: ['android', 'ios'], preconditions: '',
      steps: [{ keyword: 'Given', text: 'a registered user' }, { keyword: 'When', text: 'they log in with email' }, { keyword: 'Then', text: 'the home screen shows' }],
    }),
    state,
    createdAt: '', updatedAt: '',
    author: null,
    assignees: { nodes: [{ login: 'sam', avatarUrl: '' }] },
    labels: { nodes: labels.map((name) => ({ name })) },
  };
}

describe('re-runs and duplicates', () => {
  test('existing names are skipped, repeats within the import flagged', () => {
    const existing = fromIssue(caseNode(1, 'Login with email', ['testcase']));
    const rows = rowsFromGherkin(
      `Scenario: login with email
        Given a
        When b
        Then c
      Scenario: New one
        Given a
        When b
        Then c
      Scenario: New one
        Given a
        When b
        Then c`,
      DEFAULTS,
    );
    const marked = markAgainst(rows, [existing]);
    expect(marked.map((r) => r.state)).toEqual(['exists', 'ready', 'invalid']);
    expect(marked[0].existing?.number).toBe(1);
  });
});

describe('export', () => {
  test('one row per case with run results from labels', () => {
    const tc = fromIssue(caseNode(7, 'Login with email', ['testcase', 'priority:P1', 'platform:android', 'platform:ios', 'status:failed', 'run:android:passed', 'run:ios:failed']));
    expect(latestRun(tc, 'android')).toBe('Passed');
    expect(latestRun(tc, 'ios')).toBe('Failed');
    const rows = parseDelimited(casesToCsv([tc]));
    expect(rows[0][0]).toBe('#');
    expect(rows[1].slice(0, 5)).toEqual(['7', 'Login with email', 'P1', 'Android, iOS', 'Failed']);
    expect(rows[1][7]).toContain('Given a registered user');
    expect(rows[1][11]).toBe('https://github.com/o/r/issues/7');
  });
});

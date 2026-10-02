import { describe, expect, test } from 'bun:test';
import { CommentNode } from '../github/api';
import { IssueNode, fromIssue, renderBody } from './model';
import { reviewComment, submitComment } from './comments';
import { RunMeta, bugComment, runComment } from './runs';
import { blockers, burndown, changesSince, platformProgress, readinessReport, statusGrid, verdict } from './readiness';
import { setFeatureSettings, parseConfig } from '../config/team-config';

let num = 0;
function tc(priority: string, status: string, platforms: ('android' | 'ios')[], runs: string[] = [], closed = false) {
  num++;
  const node: IssueNode = {
    id: `I${num}`, number: num, url: `https://github.com/o/r/issues/${num}`, title: `[TC] Case ${num}`,
    body: renderBody({ title: `Case ${num}`, priority: priority as 'P0', platforms, preconditions: '', steps: [{ keyword: 'Given', text: 'a' }, { keyword: 'When', text: 'b' }, { keyword: 'Then', text: 'c' }] }),
    state: closed ? 'CLOSED' : 'OPEN', createdAt: '', updatedAt: '', author: null, assignees: { nodes: [] },
    labels: { nodes: ['testcase', `priority:${priority}`, `status:${status}`, ...platforms.map((p) => `platform:${p}`), ...runs].map((name) => ({ name })) },
  };
  return fromIssue(node);
}

describe('counts and progress', () => {
  num = 0;
  const cases = [
    tc('P0', 'passed', ['android', 'ios'], ['run:android:passed', 'run:ios:passed']),
    tc('P0', 'failed', ['android', 'ios'], ['run:android:passed', 'run:ios:failed']),
    tc('P0', 'approved', ['android']),
    tc('P1', 'blocked', ['ios'], ['run:ios:blocked']),
    tc('P2', 'draft', ['android']),
    tc('P0', 'draft', ['ios'], [], true),
  ];

  test('grid ignores closed cases', () => {
    const g = statusGrid(cases);
    expect(g.P0.passed).toBe(1);
    expect(g.P0.failed).toBe(1);
    expect(g.P0.approved).toBe(1);
    expect(g.P0.draft).toBe(0);
    expect(g.P2.draft).toBe(1);
  });

  test('platform progress counts approved cases only', () => {
    const [android, ios] = platformProgress(cases);
    expect(android).toEqual({ platform: 'android', pass: 2, fail: 0, blocked: 0, none: 1, total: 3 });
    expect(ios).toEqual({ platform: 'ios', pass: 1, fail: 1, blocked: 1, none: 0, total: 3 });
  });

  test('verdict: P0 failing and not run block; P1 trouble is a warning', () => {
    const v = verdict(cases, ['P0'], '4.12.0');
    expect(v.ready).toBe(false);
    expect(v.headline).toBe('Not ready: 1 P0 failing on iOS, 1 P0 not run.');
    expect(v.warnings).toEqual([]);
    const strict = verdict(cases, ['P0', 'P1'], null);
    expect(strict.reasons).toContain('1 P0/P1 blocked on iOS');
  });

  test('ready when every blocking case passed everywhere', () => {
    num = 100;
    const ok = [tc('P0', 'passed', ['android', 'ios'], ['run:android:passed', 'run:ios:passed']), tc('P1', 'failed', ['android'], ['run:android:failed'])];
    const v = verdict(ok, ['P0'], '4.12.0');
    expect(v.ready).toBe(true);
    expect(v.headline).toBe('Ready to ship: all 1 P0 case passed on v4.12.0.');
    expect(v.warnings).toEqual(['1 P1 failing']);
  });

  test('no blocking cases is not "ready"', () => {
    num = 200;
    expect(verdict([tc('P2', 'approved', ['ios'])], ['P0'], null).ready).toBe(false);
  });
});

function c(author: string, body: string, at: string): CommentNode {
  return { id: `${author}${at}`, body, url: '', createdAt: at, author: { login: author, avatarUrl: '' } };
}
const meta = (over: Partial<RunMeta>): RunMeta => ({
  platform: 'android', result: 'pass', appVersion: '4.12.0', build: '', device: '', os: '', env: 'staging', executedAt: '', ...over,
});

describe('burndown and changes', () => {
  num = 300;
  const a = tc('P0', 'approved', ['android', 'ios']);
  const b = tc('P1', 'approved', ['android']);
  const comments = new Map<number, CommentNode[]>([
    [a.number, [
      c('pm', submitComment(['sam'], false), '2026-10-05T09:00:00Z'),
      c('sam', reviewComment('android', 'approve', ''), '2026-10-05T10:00:00Z'),
      c('sam', runComment('o/r', meta({ executedAt: '2026-10-07T10:00:00Z' }), '', []), '2026-10-07T10:00:00Z'),
      c('jo', runComment('o/r', meta({ platform: 'ios', result: 'fail', executedAt: '2026-10-08T10:00:00Z' }), '', []), '2026-10-08T10:00:00Z'),
      c('jo', bugComment({ platform: 'ios', issue: 'o/app#9', url: 'u' }), '2026-10-08T10:05:00Z'),
    ]],
    [b.number, [c('sam', runComment('o/r', meta({ appVersion: '4.11.0', executedAt: '2026-10-06T10:00:00Z' }), '', []), '2026-10-06T10:00:00Z')]],
  ]);

  test('remaining slots per day, only target-version passes count', () => {
    const bd = burndown([a, b], comments, '4.12.0', '2026-10-20', '2026-10-09')!;
    expect(bd.total).toBe(3);
    expect(bd.start).toBe('2026-10-06'); // the day before the first counted run
    expect(bd.end).toBe('2026-10-20');
    expect(bd.points.map((p) => [p.date.slice(5), p.remaining])).toEqual([
      ['10-06', 3], ['10-07', 2], ['10-08', 2], ['10-09', 2],
    ]);
  });

  test('what changed since a time, newest first', () => {
    const ev = changesSince([a, b], comments, '2026-10-06T12:00:00Z');
    expect(ev.map((e) => e.kind)).toEqual(['bug', 'fail', 'pass']);
    expect(ev[1].text).toBe('failed on iOS v4.12.0');
  });

  test('report is Markdown with the verdict and tables', () => {
    num = 400;
    const cases = [tc('P0', 'failed', ['ios'], ['run:ios:failed'])];
    const md = readinessReport({
      feature: 'Checkout v2', targetVersion: '4.12.0', releaseDate: '2026-11-10',
      verdict: verdict(cases, ['P0'], '4.12.0'), grid: statusGrid(cases), progress: platformProgress(cases),
      problems: [{ tc: cases[0], platform: 'ios', result: 'fail', bugs: [{ platform: 'ios', issue: 'o/app#9', url: 'https://x/9' }] }],
      generatedAt: '2026-10-09',
    });
    expect(md).toContain('## Checkout v2: test readiness');
    expect(md).toContain('**⛔ Not ready: 1 P0 failing on iOS.**');
    expect(md).toContain('| iOS | 0 | 1 | 0 | 0 |');
    expect(md).toContain('bug [o/app#9](https://x/9)');
  });
});

describe('feature settings', () => {
  test('written into the config, keeping other keys', () => {
    const text = setFeatureSettings({ version: 1, team: { pm: ['a'] }, features: { '3': { targetVersion: '1.0' } }, x: 1 }, 7, {
      targetVersion: 'v4.12.0',
      releaseDate: '2026-11-10',
    });
    const parsed = parseConfig(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.features['7']).toEqual({ targetVersion: '4.12.0', releaseDate: '2026-11-10' });
      expect(parsed.config.features['3']).toEqual({ targetVersion: '1.0' });
      expect(parsed.raw['x']).toBe(1);
    }
  });
});

describe('blockers', () => {
  test('lists the blocking cases by name, failures first, with what each platform still needs', () => {
    num = 0;
    const cases = [
      tc('P0', 'passed', ['android', 'ios'], ['run:android:passed', 'run:ios:passed']),
      tc('P0', 'approved', ['android', 'ios'], ['run:android:passed']),
      tc('P0', 'failed', ['android', 'ios'], ['run:ios:failed']),
      tc('P0', 'in-review', ['ios']),
      tc('P1', 'failed', ['ios'], ['run:ios:failed']),
      tc('P0', 'failed', ['ios'], ['run:ios:failed'], true),
    ];
    const b = blockers(cases, ['P0']);
    expect(b.map((x) => x.tc.number)).toEqual([3, 2, 4]);
    expect(b[0].gaps).toEqual([{ platform: 'ios', state: 'fail' }, { platform: 'android', state: 'none' }]);
    expect(b[1].gaps).toEqual([{ platform: 'ios', state: 'none' }]);
    expect(b[2].unapproved).toBe(true);
  });
});

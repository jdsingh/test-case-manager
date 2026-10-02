import { describe, expect, test } from 'bun:test';
import { CommentNode } from '../github/api';
import { evidenceMarkdown, evidencePath, githubAttachments, kindOf } from '../evidence/evidence';
import { parseMarker } from './comments';
import { labelsFor } from './model';
import { RunMeta, bugComment, bugsOf, latestRuns, runComment, runLabels, runsOf, statusFromRuns } from './runs';

let n = 0;
function c(author: string, body: string, at?: string): CommentNode {
  n++;
  return { id: `r${n}`, body, url: '', createdAt: at ?? `2026-10-10T10:${String(n).padStart(2, '0')}:00Z`, author: { login: author, avatarUrl: '' } };
}

const meta = (over: Partial<RunMeta> = {}): RunMeta => ({
  platform: 'android',
  result: 'pass',
  appVersion: '4.12.0',
  build: '41207',
  device: 'Pixel 8',
  os: 'Android 15',
  env: 'staging',
  executedAt: '2026-10-14T10:32:00Z',
  ...over,
});

const shot = { path: 'evidence/12/20261014T103200Z-android-1.png', name: 'confirmation.png', type: 'image/png', size: 1000 };

describe('run comments', () => {
  test('match the PRD format and round-trip', () => {
    const body = runComment('acme/app-testbank', meta(), 'Email arrived after ~20 s.', [shot]);
    expect(body).toContain('✅ **Passed on Android** · v4.12.0 (41207) · Pixel 8, Android 15 · staging');
    expect(body).toContain('Notes: Email arrived after ~20 s.');
    expect(body).toContain('![confirmation.png](https://github.com/acme/app-testbank/blob/tcm-evidence/evidence/12/20261014T103200Z-android-1.png?raw=true)');
    const [run] = runsOf([c('sam', body)]);
    expect(run).toMatchObject({ ...meta(), author: 'sam', notes: 'Email arrived after ~20 s.', evidence: [shot] });
  });

  test('the author is GitHub’s, not anything typed', () => {
    const body = runComment('a/b', meta(), '', []).replace('"platform"', '"author":"mallory","platform"');
    expect(runsOf([c('sam', body)])[0].author).toBe('sam');
  });

  test('notes containing --> stay inside the marker', () => {
    const [run] = runsOf([c('sam', runComment('a/b', meta(), 'tap A --> B', []))]);
    expect(run.notes).toBe('tap A --> B');
  });

  test('bug links', () => {
    const body = bugComment({ platform: 'ios', issue: 'acme/app#88', url: 'https://github.com/acme/app/issues/88' });
    expect(parseMarker(body)?.kind).toBe('bug');
    expect(bugsOf([c('jo', body)])).toEqual([{ platform: 'ios', issue: 'acme/app#88', url: 'https://github.com/acme/app/issues/88' }]);
  });
});

describe('latest runs and status', () => {
  const runs = runsOf([
    c('sam', runComment('a/b', meta({ result: 'fail', executedAt: '2026-10-14T09:00:00Z' }), '', [])),
    c('sam', runComment('a/b', meta({ result: 'pass', executedAt: '2026-10-14T11:00:00Z' }), '', [])),
    c('jo', runComment('a/b', meta({ platform: 'ios', result: 'blocked', appVersion: '4.11.0' }), '', [])),
    c('jo', runComment('a/b', meta({ platform: 'ios', result: 'pass', appVersion: 'v4.12.0', executedAt: '2026-10-14T08:00:00Z' }), '', [])),
  ]);

  test('latest executed run per platform on the target version', () => {
    const latest = latestRuns(runs, ['android', 'ios'], '4.12.0', null);
    expect(latest.android?.result).toBe('pass');
    expect(latest.ios?.result).toBe('pass'); // the 4.11.0 run doesn't count; "v4.12.0" does
    expect(statusFromRuns(['android', 'ios'], latest)).toBe('passed');
    expect(runLabels(latest)).toEqual(['run:android:passed', 'run:ios:passed']);
  });

  test('without a target version the latest of any version counts', () => {
    const latest = latestRuns(runs, ['android', 'ios'], null, null);
    expect(latest.ios?.appVersion).toBe('4.11.0'); // executed latest
    expect(statusFromRuns(['android', 'ios'], latest)).toBe('blocked');
  });

  test('runs before the current version was approved are ignored', () => {
    const latest = latestRuns(runs, ['android'], '4.12.0', '2026-10-10T10:59:00Z');
    expect(latest.android).toBeUndefined();
    expect(statusFromRuns(['android'], latest)).toBe('approved');
  });

  test('fail beats blocked beats pass; missing platforms keep it approved', () => {
    const r = (result: 'pass' | 'fail' | 'blocked') => runsOf([c('x', runComment('a/b', meta({ result }), '', []))])[0];
    expect(statusFromRuns(['android', 'ios'], { android: r('pass'), ios: r('fail') })).toBe('failed');
    expect(statusFromRuns(['android', 'ios'], { android: r('blocked'), ios: r('pass') })).toBe('blocked');
    expect(statusFromRuns(['android', 'ios'], { android: r('pass') })).toBe('approved');
  });

  test('labelsFor replaces run labels only when asked', () => {
    const existing = ['testcase', 'status:approved', 'run:android:failed', 'needs-design'];
    const base = { priority: 'P1' as const, platforms: ['android' as const], status: 'passed' as const, regression: false };
    expect(labelsFor(existing, { ...base, runLabels: ['run:android:passed'] })).toEqual(['testcase', 'priority:P1', 'platform:android', 'status:passed', 'run:android:passed', 'needs-design']);
    expect(labelsFor(existing, base)).toContain('run:android:failed');
  });
});

describe('evidence helpers', () => {
  test('paths, kinds and markdown', () => {
    expect(evidencePath(12, 'ios', 1, 'Screen Recording.MOV', new Date('2026-10-14T10:32:05.123Z'))).toBe('evidence/12/20261014T103205Z-ios-2.mov');
    expect(kindOf('video/quicktime')).toBe('video');
    expect(kindOf('', 'x.heic')).toBe('image');
    expect(evidenceMarkdown('a/b', { path: 'evidence/1/x.mp4', name: 'x.mp4', type: 'video/mp4', size: 1 })).toBe(
      '[▶ x.mp4](https://github.com/a/b/blob/tcm-evidence/evidence/1/x.mp4?raw=true)',
    );
  });

  test('finds attachments added in GitHub', () => {
    const body = 'Repro:\n![Screenshot 2026](https://github.com/user-attachments/assets/abc-123)\nhttps://github.com/user-attachments/assets/def-456\n![ours](https://github.com/a/b/blob/tcm-evidence/evidence/1/x.png?raw=true)';
    expect(githubAttachments(body).map((a) => a.url)).toEqual([
      'https://github.com/user-attachments/assets/abc-123',
      'https://github.com/user-attachments/assets/def-456',
    ]);
  });
});

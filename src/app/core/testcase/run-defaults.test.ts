import { describe, expect, test } from 'bun:test';
import { CommentNode } from '../github/api';
import { RunMeta, runComment } from './runs';
import { lastOwnRun } from './run-defaults';

let n = 0;
function run(author: string, platform: 'android' | 'ios', device: string, executedAt: string): CommentNode {
  n++;
  const meta: RunMeta = { platform, result: 'pass', appVersion: '4.12.0', build: '1', device, os: 'OS', env: 'staging', executedAt };
  return { id: `c${n}`, body: runComment('o/r', meta, '', []), url: '', createdAt: executedAt, author: { login: author, avatarUrl: '' } };
}

describe('lastOwnRun', () => {
  test("finds the person's latest run on the platform across cases", () => {
    const byCase = [
      [run('sam', 'android', 'Pixel 7', '2026-10-01T10:00:00Z'), run('lee', 'android', 'Pixel 9', '2026-10-05T10:00:00Z')],
      [run('Sam', 'android', 'Pixel 8', '2026-10-03T10:00:00Z'), run('sam', 'ios', 'iPhone 15', '2026-10-06T10:00:00Z')],
    ];
    expect(lastOwnRun(byCase, 'sam', 'android')?.device).toBe('Pixel 8');
    expect(lastOwnRun(byCase, 'sam', 'ios')?.device).toBe('iPhone 15');
    expect(lastOwnRun(byCase, 'jo', 'ios')).toBeNull();
  });
});

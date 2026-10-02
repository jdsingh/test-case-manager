import { Platform, sameLogin } from '../config/team-config';
import { CommentNode } from '../github/api';
import { Environment, RunEvent, runsOf } from './runs';

/** The run details an engineer typed last time, per platform, so they never retype them (TS-4). */
export interface RunDefaults {
  appVersion: string;
  build: string;
  device: string;
  os: string;
  env: Environment;
}

const KEY = 'tcm.runDefaults.';

export function loadRunDefaults(platform: Platform): RunDefaults {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + platform) ?? 'null');
    if (v && typeof v === 'object') {
      return {
        appVersion: String(v.appVersion ?? ''),
        build: String(v.build ?? ''),
        device: String(v.device ?? ''),
        os: String(v.os ?? ''),
        env: v.env === 'production' ? 'production' : 'staging',
      };
    }
  } catch {
    // ignore bad stored data
  }
  return { appVersion: '', build: '', device: '', os: '', env: 'staging' };
}

export function saveRunDefaults(platform: Platform, d: RunDefaults): void {
  localStorage.setItem(KEY + platform, JSON.stringify(d));
}

/**
 * The person's most recent run on a platform across a feature's cases, for a browser
 * with nothing saved yet (a new laptop shouldn't mean retyping the test phone).
 */
export function lastOwnRun(commentsByCase: Iterable<CommentNode[]>, login: string, platform: Platform): RunEvent | null {
  let best: RunEvent | null = null;
  for (const comments of commentsByCase) {
    for (const r of runsOf(comments)) {
      if (r.platform === platform && sameLogin(r.author, login) && (!best || r.executedAt > best.executedAt)) best = r;
    }
  }
  return best;
}

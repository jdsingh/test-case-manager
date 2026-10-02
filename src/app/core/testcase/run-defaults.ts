import { Platform } from '../config/team-config';
import { Environment } from './runs';

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

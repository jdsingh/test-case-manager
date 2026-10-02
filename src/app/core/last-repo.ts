// Remembers the last opened repo so returning users skip the picker.

const KEY = 'tcm.lastRepo';

export function rememberRepo(owner: string, name: string): void {
  localStorage.setItem(KEY, `${owner}/${name}`);
}

export function forgetRepo(): void {
  localStorage.removeItem(KEY);
}

export function lastRepoUrl(): string | null {
  const v = localStorage.getItem(KEY);
  return v && /^[\w.-]+\/[\w.-]+$/.test(v) ? `/r/${v}` : null;
}

/** Asks GitHub's avatar CDN for a size, whatever query string the URL already has. */
export function avatarAt(url: string, px: number): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return url;
    u.searchParams.set('s', String(px));
    return u.toString();
  } catch {
    return url;
  }
}

let override: ((login: string) => string) | null = null;

/** Sample-data mode draws avatars locally instead of loading them from github.com. */
export function setLoginAvatar(fn: ((login: string) => string) | null): void {
  override = fn;
}

/** A person's avatar by login (Team settings chips). */
export function loginAvatar(login: string): string {
  return override ? override(login) : `https://github.com/${encodeURIComponent(login)}.png?size=44`;
}

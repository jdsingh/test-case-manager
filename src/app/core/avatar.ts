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

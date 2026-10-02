import { describe, expect, test } from 'bun:test';
import { GitHubClient, GitHubError } from './client';
import { isProtectedBranchError, toBase64 } from './api';
import { LABELS, missingLabels } from '../config/labels';

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { fn, calls };
}

async function errorOf(p: Promise<unknown>): Promise<GitHubError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitHubError) return e;
    throw e;
  }
  throw new Error('expected a GitHubError');
}

describe('GitHubClient', () => {
  test('sends the token and returns data', async () => {
    const f = fakeFetch(200, { data: { viewer: { login: 'sam' } } }, { 'X-OAuth-Scopes': 'repo, project' });
    const gh = new GitHubClient('t0k', f.fn);
    const data = await gh.graphql<{ viewer: { login: string } }>('query { viewer { login } }');
    expect(data.viewer.login).toBe('sam');
    expect(f.calls[0].url).toBe('https://api.github.com/graphql');
    expect((f.calls[0].init?.headers as Record<string, string>)['Authorization']).toBe('bearer t0k');
    expect(gh.scopes).toEqual(['repo', 'project']);
  });

  test('fine-grained tokens report no scopes', async () => {
    const gh = new GitHubClient('t', fakeFetch(200, { data: {} }).fn);
    await gh.graphql('query { viewer { login } }');
    expect(gh.scopes).toBeNull();
  });

  test('401 → auth', async () => {
    const gh = new GitHubClient('bad', fakeFetch(401, { message: 'Bad credentials' }).fn);
    expect((await errorOf(gh.graphql('{}'))).kind).toBe('auth');
  });

  test('403 with no remaining quota → rate_limited', async () => {
    const gh = new GitHubClient('t', fakeFetch(403, { message: 'x' }, { 'X-RateLimit-Remaining': '0' }).fn);
    expect((await errorOf(gh.graphql('{}'))).kind).toBe('rate_limited');
  });

  test('GraphQL INSUFFICIENT_SCOPES → forbidden', async () => {
    const body = { errors: [{ type: 'INSUFFICIENT_SCOPES', message: "requires ['read:project']" }] };
    const gh = new GitHubClient('t', fakeFetch(200, body).fn);
    expect((await errorOf(gh.graphql('{}'))).kind).toBe('forbidden');
  });

  test('stale expectedHeadOid → conflict', async () => {
    const body = { errors: [{ message: 'Expected branch to point to "abc" but it did not.' }] };
    const gh = new GitHubClient('t', fakeFetch(200, body).fn);
    expect((await errorOf(gh.graphql('{}'))).kind).toBe('conflict');
  });

  test('network failure → network', async () => {
    const gh = new GitHubClient('t', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await errorOf(gh.graphql('{}'))).kind).toBe('network');
  });
});

describe('helpers', () => {
  test('toBase64 handles UTF-8', () => {
    expect(toBase64('héllo ✓')).toBe(Buffer.from('héllo ✓').toString('base64'));
  });

  test('recognises protected-branch refusals', () => {
    expect(isProtectedBranchError(new GitHubError('graphql', 'Repository rule violations found'))).toBe(true);
    expect(isProtectedBranchError(new GitHubError('conflict', 'Expected branch to point to'))).toBe(false);
  });

  test('labels: unique names, and missing ones are found case-insensitively', () => {
    const names = LABELS.map((l) => l.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(missingLabels(LABELS.map((l) => l.name.toUpperCase()))).toEqual([]);
    expect(missingLabels(['testcase']).length).toBe(LABELS.length - 1);
  });
});

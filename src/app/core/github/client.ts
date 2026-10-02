// Thin, framework-free GitHub API client. All reads and most writes go through
// GraphQL; `rest` exists for the few things GraphQL can't do (binary uploads).

export const GITHUB_API = 'https://api.github.com';

export type GitHubErrorKind =
  | 'auth' // token missing, revoked or invalid (HTTP 401)
  | 'forbidden' // token lacks a permission/scope, or SSO not authorised
  | 'not_found'
  | 'rate_limited'
  | 'conflict' // e.g. createCommitOnBranch expectedHeadOid mismatch
  | 'graphql' // any other GraphQL-level error
  | 'network';

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface GraphQLErrorItem {
  type?: string;
  message: string;
  path?: (string | number)[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubClient {
  /** Classic-PAT scopes from the last response; null for fine-grained tokens. */
  scopes: string[] | null = null;
  rateLimit: RateLimit | null = null;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.send('POST', '/graphql', { query, variables });
    const body = (await res.json()) as { data?: T; errors?: GraphQLErrorItem[] };
    if (body.errors?.length) throw toGraphQLError(body.errors);
    if (body.data === undefined) throw new GitHubError('graphql', 'Empty GraphQL response');
    return body.data;
  }

  /** Like graphql(), but returns whatever data came back alongside per-field errors. */
  async graphqlPartial<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ data: Partial<T>; errors: GraphQLErrorItem[] }> {
    const res = await this.send('POST', '/graphql', { query, variables });
    const body = (await res.json()) as { data?: Partial<T> | null; errors?: GraphQLErrorItem[] };
    if (!body.data && body.errors?.length) throw toGraphQLError(body.errors);
    return { data: body.data ?? {}, errors: body.errors ?? [] };
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Raw file bytes from a REST endpoint (e.g. repo contents with the raw media type). */
  async restBlob(path: string): Promise<Blob> {
    const res = await this.send('GET', path, undefined, 'application/vnd.github.raw');
    return res.blob();
  }

  private async send(method: string, path: string, body?: unknown, accept?: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(GITHUB_API + path, {
        method,
        headers: {
          Authorization: `bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(accept ? { Accept: accept } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new GitHubError('network', 'Could not reach GitHub. Check your connection.', undefined, e);
    }
    this.readHeaders(res);
    if (res.ok) return res;
    throw await toHttpError(res);
  }

  private readHeaders(res: Response): void {
    const scopes = res.headers.get('X-OAuth-Scopes');
    this.scopes = scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean);
    const remaining = res.headers.get('X-RateLimit-Remaining');
    const limit = res.headers.get('X-RateLimit-Limit');
    const reset = res.headers.get('X-RateLimit-Reset');
    if (remaining && limit && reset) {
      this.rateLimit = {
        limit: Number(limit),
        remaining: Number(remaining),
        resetAt: new Date(Number(reset) * 1000),
      };
    }
  }
}

async function toHttpError(res: Response): Promise<GitHubError> {
  let message = `GitHub returned HTTP ${res.status}`;
  let details: unknown;
  try {
    details = await res.json();
    const m = (details as { message?: string }).message;
    if (m) message = m;
  } catch {
    // non-JSON error body
  }
  if (res.status === 401) {
    return new GitHubError('auth', 'GitHub rejected the token. It may be expired or revoked.', 401, details);
  }
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('X-RateLimit-Remaining') === '0' || res.status === 429 || /rate limit/i.test(message)) {
      return new GitHubError('rate_limited', 'GitHub rate limit reached. Try again shortly.', res.status, details);
    }
    return new GitHubError('forbidden', message, 403, details);
  }
  if (res.status === 404) return new GitHubError('not_found', message, 404, details);
  if (res.status === 409 || res.status === 422) return new GitHubError('conflict', message, res.status, details);
  return new GitHubError('graphql', message, res.status, details);
}

export function toGraphQLError(errors: GraphQLErrorItem[]): GitHubError {
  const first = errors[0];
  const message = errors.map((e) => e.message).join('; ');
  switch (first.type) {
    case 'NOT_FOUND':
      return new GitHubError('not_found', message, undefined, errors);
    case 'FORBIDDEN':
    case 'INSUFFICIENT_SCOPES':
      return new GitHubError('forbidden', message, undefined, errors);
    case 'RATE_LIMITED':
      return new GitHubError('rate_limited', message, undefined, errors);
  }
  if (/expected branch to point to|expectedHeadOid/i.test(message)) {
    return new GitHubError('conflict', message, undefined, errors);
  }
  return new GitHubError('graphql', message, undefined, errors);
}

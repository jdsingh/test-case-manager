// An in-memory stand-in for GitHub's GraphQL API, wired in with Playwright's page.route.
// It understands exactly the operations the app sends (matched by query text).

import type { Page, Route } from 'playwright';

export interface MockUser {
  login: string;
  name: string;
}

export class MockGitHub {
  tokens = new Map<string, MockUser>();
  users: MockUser[] = [
    { login: 'priya-pm', name: 'Priya' },
    { login: 'alex-lead', name: 'Alex' },
    { login: 'sam-android', name: 'Sam' },
    { login: 'lee-android', name: 'Lee' },
    { login: 'jo-ios', name: 'Jo' },
    { login: 'max-ios', name: 'Max' },
    { login: 'stranger', name: 'Stranger' },
  ];
  owner = 'acme';
  name = 'shop-app-testbank';
  head = 'c0';
  configText: string | null = null;
  labels: string[] = ['bug'];
  commits: { headline: string; body?: string; contents: string }[] = [];
  protectedBranch = false;
  pullRequests: { branch: string; title: string }[] = [];
  private commitSeq = 0;

  constructor() {
    for (const u of this.users) this.tokens.set(`tok-${u.login}`, u);
  }

  /** Simulates another person saving the config. */
  externalSave(contents: string): void {
    this.configText = contents;
    this.head = `c${++this.commitSeq}x`;
  }

  async install(page: Page): Promise<void> {
    await page.route('https://api.github.com/**', (route) => this.handle(route));
    // Chip avatars load from github.com/<login>.png.
    await page.route(/^https:\/\/github\.com\/[^/]+\.png/, (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: decodeURIComponent(avatar('x').split(',')[1]) }),
    );
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors() });
    const token = (req.headers()['authorization'] ?? '').replace(/^bearer /i, '');
    const viewer = this.tokens.get(token);
    if (!viewer) return json(route, 401, { message: 'Bad credentials' });
    const { query, variables } = req.postDataJSON() as { query: string; variables: Record<string, any> };
    const v = variables ?? {};
    const ok = (data: unknown) => json(route, 200, { data }, { 'X-OAuth-Scopes': 'repo, project' });
    const fail = (message: string, type?: string) => json(route, 200, { errors: [{ type, message }] });

    if (/viewer\s*{\s*login name avatarUrl/.test(query)) {
      return ok({ viewer: { ...viewer, avatarUrl: avatar(viewer.login) } });
    }
    if (/viewer\s*{\s*repositories/.test(query)) {
      return ok({
        viewer: {
          repositories: {
            nodes: [
              { nameWithOwner: 'acme/shop-app', isPrivate: true, viewerPermission: 'WRITE' },
              { nameWithOwner: `${this.owner}/${this.name}`, isPrivate: true, viewerPermission: 'WRITE' },
            ],
          },
        },
      });
    }
    if (query.includes('createLabel')) {
      this.labels.push(v['input'].name);
      return ok({ createLabel: { label: { id: 'L' } } });
    }
    if (query.includes('createRef')) return ok({ createRef: { ref: { name: v['input'].name } } });
    if (query.includes('createPullRequest')) {
      this.pullRequests.push({ branch: v['input'].headRefName, title: v['input'].title });
      return ok({ createPullRequest: { pullRequest: { url: 'https://github.com/acme/pr/1', number: 1 } } });
    }
    if (query.includes('createCommitOnBranch')) {
      const input = v['input'];
      const branch = input.branch.branchName as string;
      if (branch === 'main') {
        if (this.protectedBranch) return fail('Repository rule violations found\n\nChanges must be made through a pull request.');
        if (input.expectedHeadOid !== this.head) {
          return fail(`Expected branch to point to "${input.expectedHeadOid}" but it did not. Pull and try again.`);
        }
      }
      const contents = Buffer.from(input.fileChanges.additions[0].contents, 'base64').toString('utf8');
      this.commits.push({ headline: input.message.headline, body: input.message.body, contents });
      if (branch === 'main') {
        this.configText = contents;
        this.head = `c${++this.commitSeq}`;
      }
      return ok({ createCommitOnBranch: { commit: { oid: this.head, url: `https://github.com/commit/${this.head}` } } });
    }
    if (query.includes('projectsV2')) {
      return ok({
        repository: {
          projectsV2: {
            nodes: [
              { id: 'P7', number: 7, title: 'Checkout v2', closed: false, url: 'https://github.com/orgs/acme/projects/7' },
              { id: 'P3', number: 3, title: 'Old release', closed: true, url: 'https://github.com/orgs/acme/projects/3' },
            ],
          },
        },
      });
    }
    if (query.includes('assignableUsers(first: 20')) {
      const q = String(v['q'] ?? '').toLowerCase();
      const nodes = this.users
        .filter((u) => u.login !== 'stranger' && (!q || u.login.includes(q)))
        .map((u) => ({ ...u, avatarUrl: avatar(u.login) }));
      return ok({ repository: { assignableUsers: { nodes } } });
    }
    if (query.includes('assignableUsers(first: 5')) {
      const repository: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (!/^q\d+$/.test(k)) continue;
        const nodes = this.users.filter((u) => u.login !== 'stranger' && u.login === val).map((u) => ({ login: u.login }));
        repository[`u${k.slice(1)}`] = { nodes };
      }
      return ok({ repository });
    }
    if (query.includes('repository(owner: $owner, name: $name)') && query.includes('defaultBranchRef')) {
      if (`${v['owner']}/${v['name']}`.toLowerCase() !== `${this.owner}/${this.name}`) {
        return fail(`Could not resolve to a Repository with the name '${v['owner']}/${v['name']}'.`, 'NOT_FOUND');
      }
      return ok({
        repository: {
          id: 'R1',
          name: this.name,
          nameWithOwner: `${this.owner}/${this.name}`,
          owner: { login: this.owner },
          isEmpty: false,
          viewerPermission: 'WRITE',
          defaultBranchRef: { name: 'main', target: { oid: this.head } },
          config: this.configText === null ? null : { text: this.configText },
          labels: { nodes: this.labels.map((name) => ({ name })) },
        },
      });
    }
    return fail(`mock-github: unhandled query: ${query.slice(0, 120)}`);
  }
}

function avatar(login: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#94a3b8"/><text x="20" y="26" font-size="16" text-anchor="middle" fill="white">${login[0].toUpperCase()}</text></svg>`)}`;
}

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version',
    'Access-Control-Expose-Headers': 'X-OAuth-Scopes, X-RateLimit-Remaining, X-RateLimit-Limit, X-RateLimit-Reset',
  };
}

function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { ...cors(), ...headers },
    body: JSON.stringify(body),
  });
}

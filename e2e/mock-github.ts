// An in-memory stand-in for GitHub's GraphQL API, wired in with Playwright's page.route.
// It understands exactly the operations the app sends (matched by query text).

import type { Page, Route } from 'playwright';

export interface MockUser {
  login: string;
  name: string;
}

export interface MockIssue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  comments: { id: string; body: string; createdAt: string; author: string }[];
  projectIds: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
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
  issues: MockIssue[] = [];
  private issueSeq = 0;
  private clock = Date.parse('2026-10-01T10:00:00Z');
  viewerLogin = '';

  /** Seeds a test case issue on the Checkout v2 board (P7). */
  addIssue(i: Partial<MockIssue> & { title: string; body: string; labels: string[] }): MockIssue {
    const issue: MockIssue = {
      number: ++this.issueSeq,
      id: `I_${this.issueSeq + 1000}`,
      state: 'OPEN',
      assignees: [],
      comments: [],
      projectIds: ['P7'],
      author: 'priya-pm',
      createdAt: this.now(),
      updatedAt: this.now(),
      ...i,
    };
    for (const l of issue.labels) if (!this.labels.includes(l)) this.labels.push(l);
    this.issues.push(issue);
    return issue;
  }

  issue(n: number): MockIssue {
    const i = this.issues.find((x) => x.number === n);
    if (!i) throw new Error(`mock: no issue #${n}`);
    return i;
  }

  private now(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private labelId(name: string): string {
    return `LA_${name}`;
  }

  private userId(login: string): string {
    return `U_${login}`;
  }

  private issueNode(i: MockIssue) {
    return {
      id: i.id,
      number: i.number,
      url: `https://github.com/${this.owner}/${this.name}/issues/${i.number}`,
      title: i.title,
      body: i.body,
      state: i.state,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      author: { login: i.author },
      assignees: { nodes: i.assignees.map((login) => ({ login, avatarUrl: avatar(login) })) },
      labels: { nodes: i.labels.map((name) => ({ name })) },
      repository: { nameWithOwner: `${this.owner}/${this.name}` },
    };
  }

  private applyIssueInput(i: MockIssue, input: Record<string, any>): void {
    if (input['title'] !== undefined) i.title = input['title'];
    if (input['body'] !== undefined) i.body = input['body'];
    if (input['labelIds'] !== undefined) {
      i.labels = (input['labelIds'] as string[]).map((id) => {
        const name = id.replace(/^LA_/, '');
        if (!this.labels.includes(name)) throw new Error(`mock: unknown label id ${id}`);
        return name;
      });
    }
    if (input['assigneeIds'] !== undefined) i.assignees = (input['assigneeIds'] as string[]).map((id) => id.replace(/^U_/, ''));
    i.updatedAt = this.now();
  }

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

    this.viewerLogin = viewer.login;
    if (/viewer\s*{\s*id login name avatarUrl/.test(query)) {
      return ok({ viewer: { ...viewer, id: this.userId(viewer.login), avatarUrl: avatar(viewer.login) } });
    }
    // ---- test case issues ----
    if (query.includes('items(first: 100')) {
      const nodes = this.issues
        .filter((i) => i.projectIds.includes(String(v['id'])))
        .map((i) => ({ content: { __typename: 'Issue', ...this.issueNode(i) } }));
      return ok({ node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }
    if (query.includes('issue(number: $number)')) {
      const i = this.issues.find((x) => x.number === v['number']);
      if (!i) return ok({ repository: { issue: null } });
      return ok({
        repository: {
          issue: {
            ...this.issueNode(i),
            comments: { nodes: i.comments.map((c) => ({ ...c, url: `https://github.com/c/${c.id}`, author: { login: c.author, avatarUrl: avatar(c.author) } })) },
            projectItems: { nodes: i.projectIds.map((id) => ({ project: { id } })) },
          },
        },
      });
    }
    if (/u0: user\(login:/.test(query)) {
      const data: Record<string, unknown> = {};
      for (const m of query.matchAll(/(u\d+): user\(login: "([^"]+)"\)/g)) {
        const u = this.users.find((x) => x.login === m[2]);
        data[m[1]] = u ? { id: this.userId(u.login), login: u.login } : null;
      }
      return ok(data);
    }
    if (query.includes('createIssue(')) {
      const input = v['input'];
      const i = this.addIssue({
        title: input.title,
        body: input.body,
        labels: [],
        author: viewer.login,
        projectIds: input.projectV2Ids ?? [],
      });
      this.applyIssueInput(i, input);
      return ok({ createIssue: { issue: this.issueNode(i) } });
    }
    if (query.includes('updateIssue(')) {
      const i = this.issues.find((x) => x.id === v['input'].id)!;
      this.applyIssueInput(i, v['input']);
      return ok({ updateIssue: { issue: this.issueNode(i) } });
    }
    if (query.includes('addComment(')) {
      const i = this.issues.find((x) => x.id === v['input'].subjectId)!;
      const c = { id: `C_${i.comments.length + 1}_${i.number}`, body: v['input'].body, createdAt: this.now(), author: viewer.login };
      i.comments.push(c);
      return ok({ addComment: { commentEdge: { node: { ...c, url: '', author: { login: c.author, avatarUrl: avatar(c.author) } } } } });
    }
    if (query.includes('closeIssue(')) {
      const i = this.issues.find((x) => x.id === v['input'].issueId)!;
      i.state = 'CLOSED';
      i.updatedAt = this.now();
      return ok({ closeIssue: { issue: this.issueNode(i) } });
    }
    if (query.includes('reopenIssue(')) {
      const i = this.issues.find((x) => x.id === v['input'].issueId)!;
      i.state = 'OPEN';
      i.updatedAt = this.now();
      return ok({ reopenIssue: { issue: this.issueNode(i) } });
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
      return ok({ createLabel: { label: { id: this.labelId(v['input'].name) } } });
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
          labels: { nodes: this.labels.map((name) => ({ id: this.labelId(name), name })) },
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

// An in-memory GitHub that understands exactly the API calls the app makes (matched by
// query text). The e2e suite routes the browser's requests to it; sample-data mode
// (NV-3) plugs it into the GitHub client as its fetch, so nothing leaves the browser.

import { CONFIG_PATH } from '../github/api';
import { SKILL_PATH } from '../skill/skill';

export interface FakeUser {
  login: string;
  name: string;
}

export interface FakeComment {
  id: string;
  body: string;
  createdAt: string;
  author: string;
}

export interface FakeIssue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  comments: FakeComment[];
  projectIds: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface FakeProject {
  id: string;
  number: number;
  title: string;
  closed: boolean;
  url: string;
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
  contentType: string;
}

type Vars = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class FakeGitHub {
  tokens = new Map<string, FakeUser>();
  users: FakeUser[] = [
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
  projects: FakeProject[] = [
    { id: 'P7', number: 7, title: 'Checkout v2', closed: false, url: 'https://github.com/orgs/acme/projects/7' },
    { id: 'P3', number: 3, title: 'Old release', closed: true, url: 'https://github.com/orgs/acme/projects/3' },
  ];
  head = 'c0';
  configText: string | null = null;
  hasSkill = false;
  labels: string[] = ['bug'];
  commits: { headline: string; body?: string; path: string; contents: string }[] = [];
  protectedBranch = false;
  pullRequests: { branch: string; title: string }[] = [];
  issues: FakeIssue[] = [];
  /** Evidence branch: path → bytes, plus a simple commit chain. */
  evidence = new Map<string, Uint8Array>();
  evidenceHead: string | null = null;
  evidenceCommits: { sha: string; parents: string[]; message: string }[] = [];
  /** Make the next ref update fail as if someone else pushed first. */
  raceOnce = false;
  viewerLogin = '';

  private commitSeq = 0;
  private blobs = new Map<string, Uint8Array>();
  private trees = new Map<string, Map<string, string>>();
  private commitTrees = new Map<string, string>();
  private gitSeq = 0;
  private issueSeq = 0;
  protected clock = Date.parse('2026-10-01T10:00:00Z');

  constructor() {
    for (const u of this.users) this.tokens.set(`tok-${u.login}`, u);
  }

  /** Seeds a test case issue (on the first project unless given). */
  addIssue(i: Partial<FakeIssue> & { title: string; body: string; labels: string[] }): FakeIssue {
    const issue: FakeIssue = {
      number: ++this.issueSeq,
      id: `I_${this.issueSeq + 1000}`,
      state: 'OPEN',
      assignees: [],
      comments: [],
      projectIds: [this.projects[0]?.id ?? 'P7'],
      author: 'priya-pm',
      createdAt: this.now(),
      updatedAt: this.now(),
      ...i,
    };
    for (const l of issue.labels) if (!this.labels.includes(l)) this.labels.push(l);
    this.issues.push(issue);
    return issue;
  }

  issue(n: number): FakeIssue {
    const i = this.issues.find((x) => x.number === n);
    if (!i) throw new Error(`fake-github: no issue #${n}`);
    return i;
  }

  /** Simulates another person saving the config. */
  externalSave(contents: string): void {
    this.configText = contents;
    this.head = `c${++this.commitSeq}x`;
  }

  /** A fetch() for the GitHub client (sample-data mode). */
  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const res = this.handle({ method: init?.method ?? 'GET', url: input, headers, body });
    const payload = typeof res.body === 'string' ? res.body : new Blob([res.body as BlobPart]);
    return new Response(res.status === 204 ? null : payload, {
      status: res.status,
      headers: { 'Content-Type': res.contentType, ...res.headers },
    });
  };

  handle(req: FakeRequest): FakeResponse {
    if (req.method === 'OPTIONS') return { status: 204, headers: cors(), body: '', contentType: 'text/plain' };
    const token = (req.headers['authorization'] ?? '').replace(/^bearer /i, '');
    const viewer = this.tokens.get(token);
    if (!viewer) return json(401, { message: 'Bad credentials' });
    const url = new URL(req.url);
    if (url.pathname !== '/graphql') return this.handleRest(req.method, url, req.body as Vars);
    const { query, variables } = req.body as { query: string; variables: Vars };
    return this.handleGraphQL(viewer, query, variables ?? {});
  }

  protected now(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private labelId(name: string): string {
    return `LA_${name}`;
  }

  private userId(login: string): string {
    return `U_${login}`;
  }

  private projectsOf(i: FakeIssue) {
    return i.projectIds
      .map((id) => this.projects.find((p) => p.id === id))
      .filter((p): p is FakeProject => !!p)
      .map((p) => ({ id: p.id, number: p.number, title: p.title }));
  }

  private issueNode(i: FakeIssue) {
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
      assignees: { nodes: i.assignees.map((login) => ({ login, avatarUrl: fakeAvatar(login) })) },
      labels: { nodes: i.labels.map((name) => ({ name })) },
      repository: { nameWithOwner: `${this.owner}/${this.name}` },
    };
  }

  private commentNode(c: FakeComment) {
    return { ...c, url: `https://github.com/${this.owner}/${this.name}/issues#${c.id}`, author: { login: c.author, avatarUrl: fakeAvatar(c.author) } };
  }

  private applyIssueInput(i: FakeIssue, input: Vars): void {
    if (input['title'] !== undefined) i.title = input['title'];
    if (input['body'] !== undefined) i.body = input['body'];
    if (input['labelIds'] !== undefined) {
      i.labels = (input['labelIds'] as string[]).map((id) => {
        const name = id.replace(/^LA_/, '');
        if (!this.labels.includes(name)) throw new Error(`fake-github: unknown label id ${id}`);
        return name;
      });
    }
    if (input['assigneeIds'] !== undefined) i.assignees = (input['assigneeIds'] as string[]).map((id) => id.replace(/^U_/, ''));
    i.updatedAt = this.now();
  }

  private handleRest(method: string, url: URL, body: Vars): FakeResponse {
    const base = `/repos/${this.owner}/${this.name}`;
    const path = url.pathname;
    const sha = () => `g${++this.gitSeq}`;
    if (!path.startsWith(base)) return json(404, { message: 'Not Found' });
    const rest = path.slice(base.length);
    if (method === 'GET' && rest === '/git/ref/heads/tcm-evidence') {
      return this.evidenceHead ? json(200, { object: { sha: this.evidenceHead } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'POST' && rest === '/git/blobs') {
      const id = sha();
      this.blobs.set(id, body['encoding'] === 'base64' ? fromBase64(body['content']) : new TextEncoder().encode(body['content']));
      return json(201, { sha: id });
    }
    if (method === 'POST' && rest === '/git/trees') {
      const id = sha();
      const tree = new Map(body['base_tree'] ? this.trees.get(body['base_tree']) : []);
      for (const e of body['tree']) tree.set(e.path, e.sha);
      this.trees.set(id, tree);
      return json(201, { sha: id });
    }
    if (method === 'POST' && rest === '/git/commits') {
      const id = sha();
      this.evidenceCommits.push({ sha: id, parents: body['parents'], message: body['message'] });
      this.commitTrees.set(id, body['tree']);
      return json(201, { sha: id, tree: { sha: body['tree'] } });
    }
    const commitMatch = /^\/git\/commits\/(\w+)$/.exec(rest);
    if (method === 'GET' && commitMatch) {
      return json(200, { sha: commitMatch[1], tree: { sha: this.commitTrees.get(commitMatch[1]) } });
    }
    if (method === 'POST' && rest === '/git/refs') {
      if (this.evidenceHead) return json(422, { message: 'Reference already exists' });
      this.setHead(body['sha']);
      return json(201, { object: { sha: body['sha'] } });
    }
    if (method === 'PATCH' && rest === '/git/refs/heads/tcm-evidence') {
      if (this.raceOnce) {
        this.raceOnce = false;
        return json(422, { message: 'Update is not a fast forward' });
      }
      const parent = this.evidenceCommits.find((c) => c.sha === body['sha'])?.parents[0];
      if (parent !== this.evidenceHead) return json(422, { message: 'Update is not a fast forward' });
      this.setHead(body['sha']);
      return json(200, { object: { sha: body['sha'] } });
    }
    if (method === 'GET' && rest.startsWith('/contents/') && url.searchParams.get('ref') === 'tcm-evidence') {
      const file = this.evidence.get(decodeURIComponent(rest.slice('/contents/'.length)));
      if (!file) return json(404, { message: 'Not Found' });
      return { status: 200, headers: cors(), contentType: 'application/octet-stream', body: file };
    }
    return json(404, { message: `fake-github: unhandled REST ${method} ${rest}` });
  }

  private setHead(commit: string): void {
    this.evidenceHead = commit;
    const tree = this.trees.get(this.commitTrees.get(commit) ?? '') ?? new Map<string, string>();
    this.evidence = new Map([...tree].map(([p, blob]) => [p, this.blobs.get(blob)!]));
  }

  private handleGraphQL(viewer: FakeUser, query: string, v: Vars): FakeResponse {
    const ok = (data: unknown) => json(200, { data }, { 'X-OAuth-Scopes': 'repo, project' });
    const fail = (message: string, type?: string) => json(200, { errors: [{ type, message }] });
    this.viewerLogin = viewer.login;

    if (/viewer\s*{\s*id login name avatarUrl/.test(query)) {
      return ok({ viewer: { ...viewer, id: this.userId(viewer.login), avatarUrl: fakeAvatar(viewer.login) } });
    }
    if (query.includes('search(query: $q, type: ISSUE')) {
      const q = String(v['q']);
      const assignee = /assignee:(\S+)/.exec(q)?.[1] ?? null;
      const labels = [...q.matchAll(/label:(\S+)/g)].map((m) => m[1]);
      const nodes = this.issues
        .filter((i) => i.state === 'OPEN' && labels.every((l) => i.labels.includes(l)) && (!assignee || i.assignees.includes(assignee)))
        .map((i) => ({ ...this.issueNode(i), projectItems: { nodes: this.projectsOf(i).map((project) => ({ project })) } }));
      return ok({ search: { issueCount: nodes.length, nodes } });
    }
    if (query.includes('items(first: 50') && query.includes('comments(last: 60)')) {
      const nodes = this.issues
        .filter((i) => i.projectIds.includes(String(v['id'])))
        .map((i) => ({
          content: {
            __typename: 'Issue',
            number: i.number,
            repository: { nameWithOwner: `${this.owner}/${this.name}` },
            comments: { nodes: i.comments.map((c) => this.commentNode(c)) },
          },
        }));
      return ok({ node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }
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
            comments: { nodes: i.comments.map((c) => this.commentNode(c)) },
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
      const i = this.addIssue({ title: input.title, body: input.body, labels: [], author: viewer.login, projectIds: input.projectV2Ids ?? [] });
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
      const c: FakeComment = { id: `C_${i.comments.length + 1}_${i.number}`, body: v['input'].body, createdAt: this.now(), author: viewer.login };
      i.comments.push(c);
      i.updatedAt = c.createdAt;
      return ok({ addComment: { commentEdge: { node: this.commentNode(c) } } });
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
              { nameWithOwner: `${this.owner}/shop-app`, isPrivate: true, viewerPermission: 'WRITE' },
              { nameWithOwner: `${this.owner}/${this.name}`, isPrivate: true, viewerPermission: 'WRITE' },
            ],
          },
        },
      });
    }
    if (query.includes('ref(qualifiedName: $ref)')) {
      return ok({ repository: { ref: this.evidenceHead ? { id: 'REF1' } : null } });
    }
    if (query.includes('labels(first: 10, query: "bug")')) {
      const nodes = this.labels.filter((l) => l === 'bug').map((name) => ({ id: this.labelId(name), name }));
      return ok({ repository: { id: 'R1', labels: { nodes } } });
    }
    if (query.includes('createLabel')) {
      this.labels.push(v['input'].name);
      return ok({ createLabel: { label: { id: this.labelId(v['input'].name) } } });
    }
    if (query.includes('createRef')) return ok({ createRef: { ref: { name: v['input'].name } } });
    if (query.includes('createPullRequest')) {
      this.pullRequests.push({ branch: v['input'].headRefName, title: v['input'].title });
      return ok({ createPullRequest: { pullRequest: { url: `https://github.com/${this.owner}/pr/1`, number: 1 } } });
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
      const add = input.fileChanges.additions[0];
      const contents = new TextDecoder().decode(fromBase64(add.contents));
      this.commits.push({ headline: input.message.headline, body: input.message.body, path: add.path, contents });
      if (branch === 'main') {
        if (add.path === CONFIG_PATH) this.configText = contents;
        if (add.path === SKILL_PATH) this.hasSkill = true;
        this.head = `c${++this.commitSeq}`;
      }
      return ok({ createCommitOnBranch: { commit: { oid: this.head, url: `https://github.com/${this.owner}/${this.name}/commit/${this.head}` } } });
    }
    if (query.includes('projectsV2')) {
      return ok({ repository: { projectsV2: { nodes: this.projects } } });
    }
    if (query.includes('assignableUsers(first: 20')) {
      const q = String(v['q'] ?? '').toLowerCase();
      const nodes = this.users
        .filter((u) => u.login !== 'stranger' && (!q || u.login.includes(q)))
        .map((u) => ({ ...u, avatarUrl: fakeAvatar(u.login) }));
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
          skill: this.hasSkill ? { oid: 'skill' } : null,
          labels: { nodes: this.labels.map((name) => ({ id: this.labelId(name), name })) },
        },
      });
    }
    return fail(`fake-github: unhandled query: ${query.slice(0, 120)}`);
  }
}

/** A grey initial avatar, so nothing is fetched from github.com. */
export function fakeAvatar(login: string): string {
  const hue = [...login].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${hue} 30% 55%)"/><text x="20" y="26" font-family="Arial,sans-serif" font-size="16" text-anchor="middle" fill="white">${login[0]?.toUpperCase() ?? '?'}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cors(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version',
    'Access-Control-Expose-Headers': 'X-OAuth-Scopes, X-RateLimit-Remaining, X-RateLimit-Limit, X-RateLimit-Reset',
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  return { status, headers: { ...cors(), ...headers }, contentType: 'application/json', body: JSON.stringify(body) };
}

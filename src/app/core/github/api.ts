// Typed GitHub operations used by the app. Each function is one GraphQL call.

import { GitHubClient, GitHubError } from './client';
import type { IssueNode } from '../testcase/model';

export const CONFIG_PATH = '.testcases/config.json';

export interface Viewer {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface RepoSummary {
  nameWithOwner: string;
  isPrivate: boolean;
  viewerPermission: RepoPermission | null;
}

export type RepoPermission = 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ';

export interface Project {
  id: string;
  number: number;
  title: string;
  closed: boolean;
  url: string;
}

export interface RepoInfo {
  id: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  isEmpty: boolean;
  viewerPermission: RepoPermission | null;
  defaultBranch: string | null;
  headOid: string | null;
  /** Raw text of .testcases/config.json on the default branch, or null if missing. */
  configText: string | null;
  labelNames: string[];
  /** Label name (lowercased) → node id. */
  labelIds: Record<string, string>;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export async function fetchViewer(gh: GitHubClient): Promise<Viewer> {
  const data = await gh.graphql<{ viewer: Viewer }>(`query { viewer { id login name avatarUrl } }`);
  return data.viewer;
}

export async function listViewerRepos(gh: GitHubClient): Promise<RepoSummary[]> {
  const data = await gh.graphql<{ viewer: { repositories: { nodes: RepoSummary[] } } }>(`
    query {
      viewer {
        repositories(
          first: 100
          orderBy: { field: PUSHED_AT, direction: DESC }
          affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
        ) {
          nodes { nameWithOwner isPrivate viewerPermission }
        }
      }
    }`);
  return data.viewer.repositories.nodes;
}

interface RepoQuery {
  repository: {
    id: string;
    name: string;
    nameWithOwner: string;
    owner: { login: string };
    isEmpty: boolean;
    viewerPermission: RepoPermission | null;
    defaultBranchRef: { name: string; target: { oid: string } } | null;
    config: { text: string | null } | null;
    labels: { nodes: { id: string; name: string }[] };
  } | null;
}

export async function fetchRepo(gh: GitHubClient, owner: string, name: string): Promise<RepoInfo> {
  const data = await gh.graphql<RepoQuery>(
    `query($owner: String!, $name: String!, $configExpr: String!) {
      repository(owner: $owner, name: $name) {
        id name nameWithOwner owner { login } isEmpty viewerPermission
        defaultBranchRef { name target { oid } }
        config: object(expression: $configExpr) { ... on Blob { text } }
        labels(first: 100) { nodes { id name } }
      }
    }`,
    { owner, name, configExpr: `HEAD:${CONFIG_PATH}` },
  );
  const r = data.repository;
  if (!r) throw new GitHubError('not_found', `Repository ${owner}/${name} was not found, or the token can't see it.`);
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    nameWithOwner: r.nameWithOwner,
    isEmpty: r.isEmpty,
    viewerPermission: r.viewerPermission,
    defaultBranch: r.defaultBranchRef?.name ?? null,
    headOid: r.defaultBranchRef?.target.oid ?? null,
    configText: r.config?.text ?? null,
    labelNames: r.labels.nodes.map((l) => l.name),
    labelIds: Object.fromEntries(r.labels.nodes.map((l) => [l.name.toLowerCase(), l.id])),
  };
}

/**
 * Projects (v2) linked to the repo. Kept separate from fetchRepo because a token
 * without the `project` scope fails the whole query, and the repo should still load.
 */
export async function fetchRepoProjects(gh: GitHubClient, owner: string, name: string): Promise<Project[]> {
  const data = await gh.graphql<{ repository: { projectsV2: { nodes: Project[] } } }>(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { id number title closed url }
        }
      }
    }`,
    { owner, name },
  );
  return data.repository.projectsV2.nodes;
}

export async function searchAssignableUsers(
  gh: GitHubClient,
  owner: string,
  name: string,
  query: string,
): Promise<GitHubUser[]> {
  const data = await gh.graphql<{ repository: { assignableUsers: { nodes: GitHubUser[] } } }>(
    `query($owner: String!, $name: String!, $q: String) {
      repository(owner: $owner, name: $name) {
        assignableUsers(first: 20, query: $q) { nodes { login name avatarUrl } }
      }
    }`,
    { owner, name, q: query || null },
  );
  return data.repository.assignableUsers.nodes;
}

/** Returns the subset of `logins` that are assignable users of the repo. */
export async function filterAssignable(
  gh: GitHubClient,
  owner: string,
  name: string,
  logins: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  // One aliased lookup per login keeps this to a single request.
  const unique = [...new Set(logins.map((l) => l.toLowerCase()))];
  if (!unique.length) return found;
  const fields = unique
    .map((_, i) => `u${i}: assignableUsers(first: 5, query: $q${i}) { nodes { login } }`)
    .join('\n');
  const params = unique.map((_, i) => `$q${i}: String!`).join(', ');
  const vars: Record<string, unknown> = { owner, name };
  unique.forEach((l, i) => (vars[`q${i}`] = l));
  const data = await gh.graphql<{ repository: Record<string, { nodes: { login: string }[] }> }>(
    `query($owner: String!, $name: String!, ${params}) {
      repository(owner: $owner, name: $name) { ${fields} }
    }`,
    vars,
  );
  unique.forEach((l, i) => {
    const hit = data.repository[`u${i}`]?.nodes.some((n) => n.login.toLowerCase() === l);
    if (hit) found.add(l);
  });
  return found;
}

export async function createLabel(
  gh: GitHubClient,
  repositoryId: string,
  label: { name: string; color: string; description: string },
): Promise<string> {
  const data = await gh.graphql<{ createLabel: { label: { id: string } } }>(
    `mutation($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }`,
    { input: { repositoryId, ...label } },
  );
  return data.createLabel.label.id;
}

export interface CommitResult {
  oid: string;
  url: string;
}

/** Commits one file to a branch. Fails with kind 'conflict' if the branch moved past expectedHeadOid. */
export async function commitFile(
  gh: GitHubClient,
  args: {
    nameWithOwner: string;
    branch: string;
    expectedHeadOid: string;
    path: string;
    contents: string;
    headline: string;
    body?: string;
  },
): Promise<CommitResult> {
  const data = await gh.graphql<{ createCommitOnBranch: { commit: CommitResult } }>(
    `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid url } }
    }`,
    {
      input: {
        branch: { repositoryNameWithOwner: args.nameWithOwner, branchName: args.branch },
        message: { headline: args.headline, body: args.body },
        expectedHeadOid: args.expectedHeadOid,
        fileChanges: { additions: [{ path: args.path, contents: toBase64(args.contents) }] },
      },
    },
  );
  return data.createCommitOnBranch.commit;
}

/** Creates a branch at `oid`, commits the file there and opens a pull request into `base`. */
export async function commitFileViaPullRequest(
  gh: GitHubClient,
  args: {
    repositoryId: string;
    nameWithOwner: string;
    base: string;
    baseOid: string;
    branch: string;
    path: string;
    contents: string;
    headline: string;
    body?: string;
  },
): Promise<{ url: string; number: number }> {
  await gh.graphql(
    `mutation($input: CreateRefInput!) { createRef(input: $input) { ref { name } } }`,
    { input: { repositoryId: args.repositoryId, name: `refs/heads/${args.branch}`, oid: args.baseOid } },
  );
  await commitFile(gh, {
    nameWithOwner: args.nameWithOwner,
    branch: args.branch,
    expectedHeadOid: args.baseOid,
    path: args.path,
    contents: args.contents,
    headline: args.headline,
    body: args.body,
  });
  const data = await gh.graphql<{ createPullRequest: { pullRequest: { url: string; number: number } } }>(
    `mutation($input: CreatePullRequestInput!) {
      createPullRequest(input: $input) { pullRequest { url number } }
    }`,
    {
      input: {
        repositoryId: args.repositoryId,
        baseRefName: args.base,
        headRefName: args.branch,
        title: args.headline,
        body: args.body ?? '',
      },
    },
  );
  return data.createPullRequest.pullRequest;
}

/** True when a commit was refused because the branch is protected by rules. */
export function isProtectedBranchError(e: unknown): boolean {
  return (
    e instanceof GitHubError &&
    (e.kind === 'forbidden' || e.kind === 'graphql') &&
    /protected branch|rule violation|repository rule|required status|pull request/i.test(e.message)
  );
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ---- Test case issues ---------------------------------------------------------

const ISSUE_FIELDS = `
  id number url title body state createdAt updatedAt
  author { login }
  assignees(first: 10) { nodes { login avatarUrl } }
  labels(first: 30) { nodes { name } }
`;

export interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: { login: string; avatarUrl: string } | null;
}

/** All issues on a project board that belong to `nameWithOwner`, following pagination. */
export async function fetchProjectIssues(
  gh: GitHubClient,
  projectId: string,
  nameWithOwner: string,
): Promise<IssueNode[]> {
  const out: IssueNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    type Item = { content: (IssueNode & { __typename: string; repository: { nameWithOwner: string } }) | null };
    const data: { node: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Item[] } } | null } =
      await gh.graphql(
        `query($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { content { __typename ... on Issue { ${ISSUE_FIELDS} repository { nameWithOwner } } } }
              }
            }
          }
        }`,
        { id: projectId, after },
      );
    if (!data.node) throw new GitHubError('not_found', 'The feature board was not found.');
    for (const item of data.node.items.nodes) {
      const c = item.content;
      if (c?.__typename === 'Issue' && c.repository.nameWithOwner.toLowerCase() === nameWithOwner.toLowerCase()) {
        out.push(c);
      }
    }
    if (!data.node.items.pageInfo.hasNextPage) break;
    after = data.node.items.pageInfo.endCursor;
  }
  return out;
}

export async function fetchIssue(
  gh: GitHubClient,
  owner: string,
  name: string,
  number: number,
): Promise<{ issue: IssueNode; comments: CommentNode[]; projectIds: string[] }> {
  const data = await gh.graphql<{
    repository: {
      issue: (IssueNode & { comments: { nodes: CommentNode[] }; projectItems: { nodes: { project: { id: string } }[] } }) | null;
    };
  }>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          ${ISSUE_FIELDS}
          comments(last: 100) { nodes { id body createdAt url author { login avatarUrl } } }
          projectItems(first: 20) { nodes { project { id } } }
        }
      }
    }`,
    { owner, name, number },
  );
  const issue = data.repository.issue;
  if (!issue) throw new GitHubError('not_found', `Issue #${number} was not found.`);
  const { comments, projectItems, ...rest } = issue;
  return { issue: rest, comments: comments.nodes, projectIds: projectItems.nodes.map((n) => n.project.id) };
}

/** GitHub node ids for logins; unknown logins are left out. */
export async function fetchUserIds(gh: GitHubClient, logins: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(logins.map((l) => l.toLowerCase()))].filter((l) => /^[a-z\d-]+$/.test(l));
  if (!unique.length) return {};
  const fields = unique.map((l, i) => `u${i}: user(login: "${l}") { id login }`).join('\n');
  // A missing user fails only its own field, so accept partial data.
  const { data } = await gh.graphqlPartial<Record<string, { id: string; login: string } | null>>(`query { ${fields} }`);
  const out: Record<string, string> = {};
  for (const u of Object.values(data)) if (u) out[u.login.toLowerCase()] = u.id;
  return out;
}

export async function createIssue(
  gh: GitHubClient,
  input: {
    repositoryId: string;
    title: string;
    body: string;
    labelIds: string[];
    assigneeIds: string[];
    projectV2Ids?: string[];
  },
): Promise<IssueNode> {
  const data = await gh.graphql<{ createIssue: { issue: IssueNode } }>(
    `mutation($input: CreateIssueInput!) { createIssue(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
    { input },
  );
  return data.createIssue.issue;
}

export async function updateIssue(
  gh: GitHubClient,
  input: { id: string; title?: string; body?: string; labelIds?: string[]; assigneeIds?: string[] },
): Promise<IssueNode> {
  const data = await gh.graphql<{ updateIssue: { issue: IssueNode } }>(
    `mutation($input: UpdateIssueInput!) { updateIssue(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
    { input },
  );
  return data.updateIssue.issue;
}

export async function addToProject(gh: GitHubClient, projectId: string, contentId: string): Promise<void> {
  await gh.graphql(
    `mutation($input: AddProjectV2ItemByIdInput!) { addProjectV2ItemById(input: $input) { item { id } } }`,
    { input: { projectId, contentId } },
  );
}

export async function addComment(gh: GitHubClient, subjectId: string, body: string): Promise<CommentNode> {
  const data = await gh.graphql<{ addComment: { commentEdge: { node: CommentNode } } }>(
    `mutation($input: AddCommentInput!) {
      addComment(input: $input) { commentEdge { node { id body createdAt url author { login avatarUrl } } } }
    }`,
    { input: { subjectId, body } },
  );
  return data.addComment.commentEdge.node;
}

export async function closeIssue(gh: GitHubClient, issueId: string): Promise<IssueNode> {
  const data = await gh.graphql<{ closeIssue: { issue: IssueNode } }>(
    `mutation($input: CloseIssueInput!) { closeIssue(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
    { input: { issueId, stateReason: 'NOT_PLANNED' } },
  );
  return data.closeIssue.issue;
}

export async function reopenIssue(gh: GitHubClient, issueId: string): Promise<IssueNode> {
  const data = await gh.graphql<{ reopenIssue: { issue: IssueNode } }>(
    `mutation($input: ReopenIssueInput!) { reopenIssue(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
    { input: { issueId } },
  );
  return data.reopenIssue.issue;
}

export interface AssignedIssue {
  issue: IssueNode;
  projects: { id: string; number: number; title: string }[];
}

/** Open test cases in the repo assigned to `login`: the same set as GitHub's "Assigned to me" (IN-1). */
export async function searchAssignedCases(
  gh: GitHubClient,
  nameWithOwner: string,
  login: string,
): Promise<{ total: number; items: AssignedIssue[] }> {
  const q = `repo:${nameWithOwner} is:issue is:open label:testcase assignee:${login}`;
  type Node = IssueNode & { projectItems: { nodes: { project: { id: string; number: number; title: string } }[] } };
  const data = await gh.graphql<{ search: { issueCount: number; nodes: (Node | Record<string, never>)[] } }>(
    `query($q: String!) {
      search(query: $q, type: ISSUE, first: 100) {
        issueCount
        nodes { ... on Issue { ${ISSUE_FIELDS} projectItems(first: 10) { nodes { project { id number title } } } } }
      }
    }`,
    { q },
  );
  const items = data.search.nodes
    .filter((n): n is Node => 'id' in n)
    .map(({ projectItems, ...issue }) => ({ issue, projects: projectItems.nodes.map((p) => p.project) }));
  return { total: data.search.issueCount, items };
}

/** A repo's id and its "bug" label, for filing bugs from failed runs (EX-6). */
export async function fetchBugTarget(
  gh: GitHubClient,
  owner: string,
  name: string,
): Promise<{ id: string; bugLabelId: string | null }> {
  const data = await gh.graphql<{ repository: { id: string; labels: { nodes: { id: string; name: string }[] } } | null }>(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id labels(first: 10, query: "bug") { nodes { id name } } }
    }`,
    { owner, name },
  );
  if (!data.repository) throw new GitHubError('not_found', `Repository ${owner}/${name} was not found.`);
  const bug = data.repository.labels.nodes.find((l) => l.name.toLowerCase() === 'bug');
  return { id: data.repository.id, bugLabelId: bug?.id ?? null };
}

/**
 * The latest comments of every issue on a board, for the dashboard's burndown, "what
 * changed" and failure details. Fifty issues per page keeps each query small.
 */
export async function fetchProjectComments(
  gh: GitHubClient,
  projectId: string,
  nameWithOwner: string,
): Promise<Map<number, CommentNode[]>> {
  const out = new Map<number, CommentNode[]>();
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    type Item = {
      content: { __typename: string; number?: number; repository?: { nameWithOwner: string }; comments?: { nodes: CommentNode[] } } | null;
    };
    const data: { node: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Item[] } } | null } =
      await gh.graphql(
        `query($id: ID!, $after: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 50, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { content { __typename ... on Issue {
                  number repository { nameWithOwner }
                  comments(last: 60) { nodes { id body createdAt url author { login avatarUrl } } }
                } } }
              }
            }
          }
        }`,
        { id: projectId, after },
      );
    if (!data.node) break;
    for (const { content: c } of data.node.items.nodes) {
      if (c?.__typename === 'Issue' && c.number && c.repository?.nameWithOwner.toLowerCase() === nameWithOwner.toLowerCase()) {
        out.set(c.number, c.comments?.nodes ?? []);
      }
    }
    if (!data.node.items.pageInfo.hasNextPage) break;
    after = data.node.items.pageInfo.endCursor;
  }
  return out;
}

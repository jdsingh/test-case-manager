// Typed GitHub operations used by the app. Each function is one GraphQL call.

import { GitHubClient, GitHubError } from './client';

export const CONFIG_PATH = '.testcases/config.json';

export interface Viewer {
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
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export async function fetchViewer(gh: GitHubClient): Promise<Viewer> {
  const data = await gh.graphql<{ viewer: Viewer }>(`query { viewer { login name avatarUrl } }`);
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
    labels: { nodes: { name: string }[] };
  } | null;
}

export async function fetchRepo(gh: GitHubClient, owner: string, name: string): Promise<RepoInfo> {
  const data = await gh.graphql<RepoQuery>(
    `query($owner: String!, $name: String!, $configExpr: String!) {
      repository(owner: $owner, name: $name) {
        id name nameWithOwner owner { login } isEmpty viewerPermission
        defaultBranchRef { name target { oid } }
        config: object(expression: $configExpr) { ... on Blob { text } }
        labels(first: 100) { nodes { name } }
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
): Promise<void> {
  await gh.graphql(
    `mutation($input: CreateLabelInput!) { createLabel(input: $input) { label { id } } }`,
    { input: { repositoryId, ...label } },
  );
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

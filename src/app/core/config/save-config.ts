import { GitHubClient } from '../github/client';
import { CONFIG_PATH, RepoInfo, commitFile, commitFileViaPullRequest, isProtectedBranchError } from '../github/api';

export type SaveResult = { kind: 'committed'; url: string; oid: string } | { kind: 'pull-request'; url: string; number: number };

/**
 * Commits the config file to the default branch, guarded by the head commit the user
 * loaded (throws GitHubError 'conflict' if it moved). If branch protection refuses the
 * commit, opens a pull request instead (Team settings edge cases).
 */
export function saveConfigFile(
  gh: GitHubClient,
  repo: RepoInfo,
  contents: string,
  headline: string,
  body?: string,
): Promise<SaveResult> {
  return saveRepoFile(gh, repo, CONFIG_PATH, contents, headline, body);
}

/** Same as saveConfigFile, for any file (e.g. the Claude Code skill). */
export async function saveRepoFile(
  gh: GitHubClient,
  repo: RepoInfo,
  path: string,
  contents: string,
  headline: string,
  body?: string,
): Promise<SaveResult> {
  if (!repo.defaultBranch || !repo.headOid) {
    throw new Error('The repo has no commits yet. Add a README on GitHub first, then try again.');
  }
  try {
    const commit = await commitFile(gh, {
      nameWithOwner: repo.nameWithOwner,
      branch: repo.defaultBranch,
      expectedHeadOid: repo.headOid,
      path,
      contents,
      headline,
      body,
    });
    return { kind: 'committed', url: commit.url, oid: commit.oid };
  } catch (e) {
    if (!isProtectedBranchError(e)) throw e;
  }
  const pr = await commitFileViaPullRequest(gh, {
    repositoryId: repo.id,
    nameWithOwner: repo.nameWithOwner,
    base: repo.defaultBranch,
    baseOid: repo.headOid,
    branch: `tcm/${path === CONFIG_PATH ? 'team-config' : 'repo-file'}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
    path,
    contents,
    headline,
    body,
  });
  return { kind: 'pull-request', url: pr.url, number: pr.number };
}

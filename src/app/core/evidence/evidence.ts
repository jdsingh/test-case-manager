// Evidence files live on an orphan branch, `tcm-evidence`, so they never mix with code
// (PRD section 7). GitHub has no public API for native issue attachments.

import { GitHubClient, GitHubError } from '../github/client';
import { toBase64Bytes } from './bytes';

export const EVIDENCE_BRANCH = 'tcm-evidence';
export const MAX_BYTES = 100 * 1024 * 1024; // GitHub's hard per-file limit
export const WARN_BYTES = 25 * 1024 * 1024;

export interface EvidenceRef {
  path: string;
  name: string;
  type: string;
  size: number;
}

export type EvidenceKind = 'image' | 'video' | 'other';

export function kindOf(type: string, name = ''): EvidenceKind {
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic)$/i.test(name)) return 'image';
  if (type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(name)) return 'video';
  return 'other';
}

/** Where a file goes: evidence/<issue>/<UTC time>-<platform>-<n>.<ext> */
export function evidencePath(issue: number, platform: string, index: number, fileName: string, at: Date): string {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1] ?? 'bin').toLowerCase();
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `evidence/${issue}/${stamp}-${platform}-${index + 1}.${ext}`;
}

/** The link GitHub's issue view renders for repo members (images inline). */
export function evidenceUrl(nameWithOwner: string, path: string): string {
  return `https://github.com/${nameWithOwner}/blob/${EVIDENCE_BRANCH}/${path.split('/').map(encodeURIComponent).join('/')}?raw=true`;
}

export function evidenceMarkdown(nameWithOwner: string, e: EvidenceRef): string {
  const url = evidenceUrl(nameWithOwner, e.path);
  const label = e.name.replace(/[[\]]/g, '');
  const k = kindOf(e.type, e.name);
  return k === 'image' ? `![${label}](${url})` : `[${k === 'video' ? '▶ ' : ''}${label}](${url})`;
}

interface Ref {
  object: { sha: string };
}
interface Commit {
  sha: string;
  tree: { sha: string };
}

const repoPath = (nameWithOwner: string) => `/repos/${nameWithOwner}`;

/** Creates the orphan evidence branch if it doesn't exist yet. */
export async function ensureEvidenceBranch(gh: GitHubClient, nameWithOwner: string): Promise<void> {
  const base = repoPath(nameWithOwner);
  // GraphQL answers null for a missing branch, where REST would log a 404 in the console.
  const [owner, name] = nameWithOwner.split('/');
  const found = await gh.graphql<{ repository: { ref: { id: string } | null } }>(
    `query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { id } } }`,
    { owner, name, ref: `refs/heads/${EVIDENCE_BRANCH}` },
  );
  if (found.repository.ref) return;
  const readme =
    '# Test evidence\n\nScreenshots and videos attached to test runs by Test Case Manager.\n' +
    'This branch has no shared history with the code on purpose; do not merge it.\n';
  const blob = await gh.rest<{ sha: string }>('POST', `${base}/git/blobs`, { content: readme, encoding: 'utf-8' });
  const tree = await gh.rest<{ sha: string }>('POST', `${base}/git/trees`, {
    tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }],
  });
  const commit = await gh.rest<Commit>('POST', `${base}/git/commits`, {
    message: 'Start the test evidence branch',
    tree: tree.sha,
    parents: [],
  });
  try {
    await gh.rest('POST', `${base}/git/refs`, { ref: `refs/heads/${EVIDENCE_BRANCH}`, sha: commit.sha });
  } catch (e) {
    // Someone else created it at the same moment: fine.
    if (!(e instanceof GitHubError) || e.kind !== 'conflict') throw e;
  }
}

export interface UploadFile {
  path: string;
  name: string;
  type: string;
  bytes: Uint8Array;
}

/**
 * Uploads files as one commit on the evidence branch. Blobs are created first; if another
 * upload moved the branch meanwhile, the commit is rebuilt on the new head and retried.
 */
export async function uploadEvidence(
  gh: GitHubClient,
  nameWithOwner: string,
  files: UploadFile[],
  message: string,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<EvidenceRef[]> {
  if (!files.length) return [];
  const base = repoPath(nameWithOwner);
  await ensureEvidenceBranch(gh, nameWithOwner);
  const shas: string[] = [];
  for (const [i, f] of files.entries()) {
    const blob = await gh.rest<{ sha: string }>('POST', `${base}/git/blobs`, {
      content: toBase64Bytes(f.bytes),
      encoding: 'base64',
    });
    shas.push(blob.sha);
    onProgress(i + 1, files.length);
  }
  for (let attempt = 0; ; attempt++) {
    const ref = await gh.rest<Ref>('GET', `${base}/git/ref/heads/${EVIDENCE_BRANCH}`);
    const head = await gh.rest<Commit>('GET', `${base}/git/commits/${ref.object.sha}`);
    const tree = await gh.rest<{ sha: string }>('POST', `${base}/git/trees`, {
      base_tree: head.tree.sha,
      tree: files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: shas[i] })),
    });
    const commit = await gh.rest<Commit>('POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [head.sha] });
    try {
      await gh.rest('PATCH', `${base}/git/refs/heads/${EVIDENCE_BRANCH}`, { sha: commit.sha, force: false });
      break;
    } catch (e) {
      if (!(e instanceof GitHubError) || e.kind !== 'conflict' || attempt >= 4) throw e;
    }
  }
  return files.map((f) => ({ path: f.path, name: f.name, type: f.type, size: f.bytes.length }));
}

/** Loads an evidence file through the API (works for private repos) as an object URL. */
export async function evidenceObjectUrl(gh: GitHubClient, nameWithOwner: string, path: string): Promise<string> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const blob = await gh.restBlob(`${repoPath(nameWithOwner)}/contents/${encoded}?ref=${EVIDENCE_BRANCH}`);
  return URL.createObjectURL(blob);
}

/** Image and video links people attached in GitHub's own UI (EX-5), from ordinary comments. */
export function githubAttachments(body: string): { url: string; name: string }[] {
  const out: { url: string; name: string }[] = [];
  const seen = new Set<string>();
  const add = (url: string, name: string) => {
    if (seen.has(url) || url.includes(`/blob/${EVIDENCE_BRANCH}/`)) return;
    seen.add(url);
    out.push({ url, name: name || url.split('/').pop() || 'attachment' });
  };
  for (const m of body.matchAll(/!?\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/[^)\s]+)\)/g)) add(m[2], m[1]);
  for (const m of body.matchAll(/<img[^>]+src="(https:\/\/github\.com\/user-attachments\/[^"]+)"/g)) add(m[1], '');
  for (const m of body.matchAll(/(?:^|\s)(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)/g)) add(m[1], '');
  return out;
}

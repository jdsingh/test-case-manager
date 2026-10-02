// The labels the app relies on (PRD section 6). Bootstrap creates whichever are missing.

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

const STATUS: [string, string, string][] = [
  ['draft', 'd4d4d8', 'Test case is being written'],
  ['in-review', 'fbca04', 'Waiting for a mobile engineer to review'],
  ['changes-requested', 'e99695', 'A reviewer asked for changes'],
  ['approved', '0e8a16', 'Reviewed and ready to run'],
  ['passed', '2da44e', 'Passed on every target platform'],
  ['failed', 'd73a4a', 'Latest run failed on at least one platform'],
  ['blocked', 'bf8700', 'Latest run was blocked on at least one platform'],
];

const RUN_RESULTS: [string, string][] = [
  ['passed', '2da44e'],
  ['failed', 'd73a4a'],
  ['blocked', 'bf8700'],
];

export const LABELS: LabelSpec[] = [
  { name: 'testcase', color: '5319e7', description: 'Managed by Test Case Manager' },
  { name: 'regression', color: '1d76db', description: 'In the regression bank' },
  { name: 'priority:P0', color: 'b60205', description: 'Must pass to ship' },
  { name: 'priority:P1', color: 'd93f0b', description: 'High priority' },
  { name: 'priority:P2', color: 'fbca04', description: 'Medium priority' },
  { name: 'priority:P3', color: 'c5def5', description: 'Low priority' },
  { name: 'platform:android', color: '3ddc84', description: 'Applies to Android' },
  { name: 'platform:ios', color: '0a84ff', description: 'Applies to iOS' },
  ...STATUS.map(([s, color, description]) => ({ name: `status:${s}`, color, description })),
  ...(['android', 'ios'] as const).flatMap((p) =>
    RUN_RESULTS.map(([r, color]) => ({
      name: `run:${p}:${r}`,
      color,
      description: `Latest ${p === 'ios' ? 'iOS' : 'Android'} run on the target version ${r}`,
    })),
  ),
];

export function missingLabels(existing: string[]): LabelSpec[] {
  const have = new Set(existing.map((n) => n.toLowerCase()));
  return LABELS.filter((l) => !have.has(l.name.toLowerCase()));
}

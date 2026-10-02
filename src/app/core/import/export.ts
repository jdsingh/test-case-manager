// Export the current view to CSV (PRD IM-4).

import { Platform } from '../config/team-config';
import { PLATFORM_NAMES, STATUS_LABELS, TestCase } from '../testcase/model';
import { renderGherkin } from '../testcase/gherkin';
import { toCsv } from './csv';

const RESULTS = ['passed', 'failed', 'blocked'] as const;

/** Latest run result on a platform, from the run:<platform>:<result> label (blank if not run). */
export function latestRun(tc: TestCase, platform: Platform): string {
  if (!tc.platforms.includes(platform)) return 'n/a';
  const labels = tc.labels.map((l) => l.toLowerCase());
  const r = RESULTS.find((res) => labels.includes(`run:${platform}:${res}`));
  return r ? r[0].toUpperCase() + r.slice(1) : 'Not run';
}

export function casesToCsv(cases: TestCase[]): string {
  const header = [
    '#', 'Scenario', 'Priority', 'Platforms', 'Status', 'Regression', 'Preconditions', 'Steps',
    'Assignees', 'Latest Android run', 'Latest iOS run', 'Issue',
  ];
  const rows = cases.map((tc) => [
    tc.number,
    tc.title,
    tc.priority ?? '',
    tc.platforms.map((p) => PLATFORM_NAMES[p]).join(', '),
    tc.closed ? "Won't test" : tc.status ? STATUS_LABELS[tc.status] : '',
    tc.regression ? 'Yes' : '',
    tc.preconditions,
    tc.steps.length ? renderGherkin({ name: tc.title, steps: tc.steps }) : '',
    tc.assignees.map((a) => a.login).join(', '),
    latestRun(tc, 'android'),
    latestRun(tc, 'ios'),
    tc.url,
  ]);
  return toCsv([header, ...rows]);
}

/** Triggers a browser download of text content. */
export function download(filename: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The prefilled bug for a failed run (EX-6).

import { Platform } from '../config/team-config';
import { evidenceUrl } from '../evidence/evidence';
import { renderGherkin } from './gherkin';
import { PLATFORM_NAMES, TestCase } from './model';
import { RunMeta } from './runs';
import { EvidenceRef } from '../evidence/evidence';

export function bugTitle(tc: TestCase, platform: Platform): string {
  return `[${PLATFORM_NAMES[platform]}] ${tc.title} fails`;
}

export function bugBody(
  tc: TestCase,
  meta: RunMeta,
  notes: string,
  evidence: EvidenceRef[],
  testbank: string,
): string {
  const lines = [
    `Found while running test case [#${tc.number} ${tc.title}](${tc.url}) (${tc.priority ?? 'no priority'}).`,
    '',
    '**Environment**',
    `- App version: ${meta.appVersion}${meta.build ? ` (build ${meta.build})` : ''}`,
    `- Device: ${[meta.device, meta.os].filter(Boolean).join(', ') || 'not given'}`,
    `- Platform: ${PLATFORM_NAMES[meta.platform]} · ${meta.env}`,
    `- Run at: ${meta.executedAt}`,
    '',
  ];
  if (tc.preconditions) lines.push(`**Preconditions:** ${tc.preconditions}`, '');
  lines.push('**Steps**', '', '```gherkin', renderGherkin({ name: tc.title, steps: tc.steps }), '```', '');
  lines.push('**What happened**', '', notes.trim() || '_Describe what went wrong._', '');
  if (evidence.length) {
    lines.push('**Evidence**', '', ...evidence.map((e) => `- [${e.name}](${evidenceUrl(testbank, e.path)})`), '');
  }
  return lines.join('\n');
}

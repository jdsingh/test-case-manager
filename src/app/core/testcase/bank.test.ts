import { describe, expect, test } from 'bun:test';
import { IssueNode, fromIssue, parseBody, renderBody, draftOf } from './model';
import { bankCandidates, copyInfo, copyNote, copyStartsApproved, fingerprint, isOutOfDate, visibleExtra } from './bank';

let n = 0;
function tc(title: string, status: string, opts: { extra?: string; then?: string; closed?: boolean; priority?: string } = {}) {
  n++;
  const draft = {
    title, priority: (opts.priority ?? 'P1') as 'P1', platforms: ['android' as const], preconditions: '',
    steps: [{ keyword: 'Given' as const, text: 'a' }, { keyword: 'When' as const, text: 'b' }, { keyword: 'Then' as const, text: opts.then ?? 'c' }],
  };
  const node: IssueNode = {
    id: `I${n}`, number: n, url: '', title: `[TC] ${title}`, body: renderBody(draft, opts.extra ?? ''),
    state: opts.closed ? 'CLOSED' : 'OPEN', createdAt: '', updatedAt: '', author: null, assignees: { nodes: [] },
    labels: { nodes: ['testcase', `status:${status}`, 'platform:android', 'regression'].map((name) => ({ name })) },
  };
  return fromIssue(node);
}

describe('regression bank', () => {
  const source = tc('Guest checkout', 'approved');

  test('a copy remembers its source and survives a body round-trip', () => {
    const copy = tc('Guest checkout', 'approved', { extra: copyNote(source) });
    expect(copyInfo(copy)).toEqual({ source: source.number, fingerprint: fingerprint(source) });
    expect(visibleExtra(copy.extraBody)).toBe(`_Copied from the regression bank: #${source.number}._`);
    const reparsed = parseBody(renderBody(draftOf(copy), copy.extraBody));
    expect(reparsed.extraBody).toContain('tcm:copy');
  });

  test('flags a copy once the original changes, not for priority alone', () => {
    const copy = tc('Guest checkout', 'approved', { extra: copyNote(source) });
    expect(isOutOfDate(copy, [source])).toBeNull();
    const reprioritised = { ...source, priority: 'P0' as const };
    expect(isOutOfDate(copy, [reprioritised])).toBeNull();
    const edited = { ...source, steps: [...source.steps.slice(0, 2), { keyword: 'Then' as const, text: 'c, and an email arrives' }] };
    expect(isOutOfDate(copy, [edited])?.number).toBe(source.number);
  });

  test('candidates skip cases already in the feature or copied into it', () => {
    const other = tc('Promo code', 'draft');
    const closed = tc('Old flow', 'approved', { closed: true });
    const featureCases = [tc('Guest checkout', 'approved', { extra: copyNote(source) })];
    expect(bankCandidates([source, other, closed], featureCases).map((c) => c.title)).toEqual(['Promo code']);
    expect(bankCandidates([source, other], [source]).map((c) => c.title)).toEqual(['Promo code']);
  });

  test('copies of approved cases skip review', () => {
    expect(copyStartsApproved(tc('x', 'passed'))).toBe(true);
    expect(copyStartsApproved(tc('y', 'in-review'))).toBe(false);
  });
});

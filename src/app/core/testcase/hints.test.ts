import { describe, expect, test } from 'bun:test';
import { writingHints } from './hints';
import { TestCaseDraft } from './model';

const d = (then: string, over: Partial<TestCaseDraft> = {}): TestCaseDraft => ({
  title: 'Expired card shows an inline error',
  priority: 'P1',
  platforms: ['android'],
  preconditions: '',
  steps: [
    { keyword: 'Given', text: 'a user paying with a card' },
    { keyword: 'When', text: 'the user enters an expired card' },
    { keyword: 'Then', text: then },
  ],
  ...over,
});

describe('writing hints', () => {
  test('vague error outcome', () => {
    const h = writingHints(d('an error is shown'));
    expect(h).toHaveLength(1);
    expect(h[0].step).toBe(2);
    expect(h[0].text).toContain('exact message');
  });

  test('"works" without anything observable', () => {
    expect(writingHints(d('checkout works correctly'))[0].text).toContain('what the tester will see');
  });

  test('specific outcomes pass', () => {
    expect(writingHints(d('"Card expired" shows under the card field'))).toEqual([]);
    expect(writingHints(d('the total shows $45.00'))).toEqual([]);
    expect(writingHints(d('the order confirmation screen shows an order number'))).toEqual([]);
  });

  test('two actions in one When', () => {
    const draft = d('"Done" shows');
    draft.steps[1] = { keyword: 'When', text: 'the user taps Pay and then confirms with Face ID' };
    expect(writingHints(draft).some((h) => h.step === 1 && h.text.includes('two actions'))).toBe(true);
  });

  test('test data without preconditions', () => {
    const draft = d('the total shows $45.00');
    draft.steps[1] = { keyword: 'When', text: 'the user applies promo code "SAVE10"' };
    expect(writingHints(draft).some((h) => h.step === null && h.text.includes('Preconditions'))).toBe(true);
    expect(writingHints({ ...draft, preconditions: 'SAVE10 active' }).some((h) => h.text.includes('Preconditions'))).toBe(false);
  });

  test('short titles', () => {
    expect(writingHints(d('"x" shows', { title: 'Checkout' })).some((h) => h.text.includes('scenario name'))).toBe(true);
  });
});

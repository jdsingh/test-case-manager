// Gentle writing hints for the PM (UX 2): the patterns reviewers most often send back.
// Hints never block saving; they're suggestions, worded as what to do.

import { sectionsOf } from './gherkin';
import { TestCaseDraft } from './model';

export interface Hint {
  /** 0-based step, or null for the whole case. */
  step: number | null;
  text: string;
}

const VAGUE = /\b(works?|working|correct(ly)?|properly|as expected|success(ful(ly)?)?|fine|ok(ay)?|appropriate(ly)?|should|handled?|valid)\b/i;
const SHOWN_NO_DETAIL = /\b(an?|the)\s+(error|message|toast|alert|warning|notification)\s+(is\s+)?(shown|displayed|appears|visible)\b/i;
const HAS_SPECIFICS = /["“'][^"”']+["”']|\$\d|\d/;
const TWO_ACTIONS = /\b(and then|, then|then taps|then clicks|then selects)\b/i;
const DATA_CUE = /\$\d|\b(promo|coupon|gift card|code|card \d|account|password|email address)\b/i;

export function writingHints(d: TestCaseDraft): Hint[] {
  const hints: Hint[] = [];
  const sections = sectionsOf(d.steps);
  d.steps.forEach((s, i) => {
    const text = s.text.trim();
    if (!text) return;
    const sec = sections[i];
    if (sec === 'Then') {
      if (SHOWN_NO_DETAIL.test(text) && !HAS_SPECIFICS.test(text)) {
        hints.push({ step: i, text: 'Name the exact message in quotes and where it appears, e.g. "Card expired" under the card field.' });
      } else if (VAGUE.test(text) && !HAS_SPECIFICS.test(text)) {
        hints.push({ step: i, text: 'Say what the tester will see: a screen, exact text in quotes, or a value, not just that it works.' });
      }
    }
    if (sec === 'When' && TWO_ACTIONS.test(text)) {
      hints.push({ step: i, text: 'This looks like two actions. Split it into a When and an And step so a failure points at one.' });
    }
  });
  // Only setup steps count: an expected value in a Then step isn't test data to prepare.
  const setup = d.steps.filter((_, i) => sections[i] === 'Given' || sections[i] === 'When');
  if (!d.preconditions.trim() && setup.some((s) => DATA_CUE.test(s.text))) {
    hints.push({ step: null, text: 'The steps mention test data (codes, cards, accounts). Add it under Preconditions so testers can set it up.' });
  }
  const words = d.title.trim().split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length < 3) {
    hints.push({ step: null, text: 'Make the scenario name a short statement of the behaviour, e.g. "Expired card shows an inline error".' });
  }
  return hints;
}

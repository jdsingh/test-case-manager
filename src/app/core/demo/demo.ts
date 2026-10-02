// Sample-data mode (NV-3): a whole testbank in memory, so people can learn the app
// without touching a real repo. Nothing is sent to GitHub; it resets on reload.

import { FakeGitHub } from './fake-github';
import { LABELS } from '../config/labels';
import { Role } from '../config/team-config';
import { renderBody, TestCase, TestCaseDraft } from '../testcase/model';
import { lineComment, reviewComment, submitComment } from '../testcase/comments';
import { bugComment, runComment, RunMeta } from '../testcase/runs';
import { copyNote } from '../testcase/bank';

export const DEMO_PREFIX = 'demo:';
export const DEMO_REPO = { owner: 'acme', name: 'shop-app-testbank' };

export interface DemoPerson {
  login: string;
  name: string;
  role: Role;
  label: string;
}

export const DEMO_PEOPLE: DemoPerson[] = [
  { login: 'priya-pm', name: 'Priya', role: 'pm', label: 'Product manager' },
  { login: 'sam-android', name: 'Sam', role: 'android', label: 'Android engineer' },
  { login: 'jo-ios', name: 'Jo', role: 'ios', label: 'iOS engineer' },
  { login: 'alex-lead', name: 'Alex', role: 'techLead', label: 'Tech lead' },
];

class DemoGitHub extends FakeGitHub {
  /** Real time, so everything done in the demo reads "just now". */
  protected override now(): string {
    return new Date().toISOString();
  }
}

let instance: DemoGitHub | null = null;

/** The shared in-memory GitHub for this page load. */
export function demoGitHub(): FakeGitHub {
  instance ??= seed();
  return instance;
}

export function isDemoToken(token: string | null): boolean {
  return !!token && token.startsWith(DEMO_PREFIX);
}

const day = 864e5;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * day - hours * 36e5).toISOString();

function draft(title: string, priority: TestCaseDraft['priority'], platforms: TestCaseDraft['platforms'], preconditions: string, steps: [string, string][]): TestCaseDraft {
  return { title, priority, platforms, preconditions, steps: steps.map(([keyword, text]) => ({ keyword: keyword as 'Given', text })) };
}

/** A small phone-screenshot drawing, used as sample evidence. */
function screenshot(line1: string, line2: string, tone: string): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="720" viewBox="0 0 360 720"><rect width="360" height="720" rx="36" fill="#111"/><rect x="14" y="14" width="332" height="692" rx="26" fill="#f6f7f9"/><rect x="14" y="14" width="332" height="80" rx="26" fill="${tone}"/><text x="180" y="66" font-family="Arial" font-size="22" fill="#fff" text-anchor="middle">Shop</text><text x="180" y="330" font-family="Arial" font-size="26" font-weight="700" fill="#1b1f24" text-anchor="middle">${line1}</text><text x="180" y="372" font-family="Arial" font-size="18" fill="#5b6470" text-anchor="middle">${line2}</text><rect x="60" y="600" width="240" height="56" rx="12" fill="${tone}"/><text x="180" y="636" font-family="Arial" font-size="18" fill="#fff" text-anchor="middle">Continue</text></svg>`;
  return new TextEncoder().encode(svg);
}

function seed(): DemoGitHub {
  const gh = new DemoGitHub();
  gh.projects = [
    { id: 'PD2', number: 2, title: 'Checkout v2 (sample)', closed: false, url: 'https://github.com/orgs/acme/projects/2' },
    { id: 'PD1', number: 1, title: 'Login revamp (sample, shipped)', closed: true, url: 'https://github.com/orgs/acme/projects/1' },
  ];
  gh.labels = [...LABELS.map((l) => l.name), 'bug'];
  gh.hasSkill = true;
  const release = new Date(Date.now() + 12 * day).toISOString().slice(0, 10);
  gh.configText =
    JSON.stringify(
      {
        version: 1,
        team: { pm: ['priya-pm'], techLead: ['alex-lead'], android: ['sam-android', 'lee-android'], ios: ['jo-ios'] },
        project: { owner: 'acme', number: 2 },
        features: { '2': { targetVersion: '4.12.0', releaseDate: release } },
        readiness: { blockingPriorities: ['P0'] },
        assignment: { defaultReviewer: { android: 'sam-android' } },
      },
      null,
      2,
    ) + '\n';
  for (const p of DEMO_PEOPLE) gh.tokens.set(DEMO_PREFIX + p.login, { login: p.login, name: p.name });

  const repo = `${DEMO_REPO.owner}/${DEMO_REPO.name}`;
  let cid = 0;
  const comment = (body: string, at: string, author: string) => ({ id: `DC${++cid}`, body, createdAt: at, author });
  const labelsFor = (d: TestCaseDraft, status: string, extra: string[] = []) => [
    'testcase', `priority:${d.priority}`, ...d.platforms.map((p) => `platform:${p}`), `status:${status}`, ...extra,
  ];
  const reviewed = (d: TestCaseDraft, reviewer: string, at: number) => [
    comment(submitComment([reviewer], false), ago(at + 1), 'priya-pm'),
    comment(reviewComment(d.platforms.includes('android') ? 'android' : 'ios', 'approve', ''), ago(at), reviewer),
  ];
  const meta = (platform: 'android' | 'ios', result: RunMeta['result'], at: string): RunMeta => ({
    platform, result, appVersion: '4.12.0', build: '41207',
    device: platform === 'ios' ? 'iPhone 15' : 'Pixel 8', os: platform === 'ios' ? 'iOS 18.1' : 'Android 15',
    env: 'staging', executedAt: at,
  });
  const evidence = (issue: number, platform: string, name: string, line1: string, line2: string, tone: string) => {
    const path = `evidence/${issue}/sample-${platform}-1.svg`;
    gh.evidence.set(path, screenshot(line1, line2, tone));
    return { path, name, type: 'image/svg+xml', size: 1200 };
  };
  gh.evidenceHead = 'seed';

  // ---- the shipped feature: its regression cases form the bank ----
  const bankCases = [
    draft('Log in with email and password', 'P0', ['android', 'ios'], 'A registered account', [
      ['Given', 'a registered user on the login screen'], ['When', 'they enter their email and password and tap "Log in"'], ['Then', 'the home screen shows their name'],
    ]),
    draft('Reset password email arrives', 'P1', ['android', 'ios'], '', [
      ['Given', 'a registered user on the login screen'], ['When', 'they tap "Forgot password" and submit their email'], ['Then', 'a reset email arrives within 2 minutes'],
    ]),
    draft('Network loss during payment does not double charge', 'P0', ['android', 'ios'], 'Network link conditioner available', [
      ['Given', 'a user on the payment screen with a valid card'], ['When', 'the network drops right after tapping "Pay"'], ['And', 'the network returns and they tap "Retry"'],
      ['Then', 'exactly one charge appears on the card'], ['And', 'one order is created'],
    ]),
  ];
  const bank = bankCases.map((d) =>
    gh.addIssue({
      title: `[TC] ${d.title}`, body: renderBody(d), labels: labelsFor(d, 'passed', ['regression', 'run:android:passed', 'run:ios:passed']),
      projectIds: ['PD1'], createdAt: ago(60), updatedAt: ago(40), comments: reviewed(d, 'sam-android', 50),
    }),
  );

  // ---- Checkout v2 ----
  const add = (d: TestCaseDraft, status: string, extra: string[], assignees: string[], comments: ReturnType<typeof comment>[], extraBody = '', createdDaysAgo = 9) =>
    gh.addIssue({
      title: `[TC] ${d.title}`, body: renderBody(d, extraBody), labels: labelsFor(d, status, extra), assignees, comments,
      projectIds: ['PD2'], createdAt: ago(createdDaysAgo), updatedAt: comments.at(-1)?.createdAt ?? ago(createdDaysAgo),
    });

  const guest = draft('Guest checkout with saved card', 'P0', ['android', 'ios'], 'Logged-out user, one item in the cart, card 4242… saved on the device', [
    ['Given', 'a guest user with one item in the cart'], ['And', 'a saved card on the device'], ['When', 'the user taps "Pay" and confirms with biometrics'],
    ['Then', 'the order confirmation screen shows an order number'], ['And', 'a confirmation email arrives within 1 minute'],
  ]);
  const n1 = gh.issues.length + 1;
  add(guest, 'passed', ['run:android:passed', 'run:ios:passed'], [], [
    ...reviewed(guest, 'sam-android', 7),
    comment(runComment(repo, meta('android', 'pass', ago(4)), 'Email arrived after ~20 s.', [evidence(n1, 'android', 'order-confirmed.svg', 'Order confirmed', 'Order #1042', '#2563eb')]), ago(4), 'sam-android'),
    comment(runComment(repo, meta('ios', 'pass', ago(3)), '', [evidence(n1, 'ios', 'order-confirmed.svg', 'Order confirmed', 'Order #1043', '#2563eb')]), ago(3), 'jo-ios'),
  ]);

  const gpay = draft('Pay with Google Pay', 'P0', ['android'], 'Google Pay set up on the test device', [
    ['Given', 'a logged-in user with items in the cart'], ['When', 'the user picks Google Pay and confirms'], ['Then', 'the order confirmation screen shows'],
  ]);
  add(gpay, 'passed', ['run:android:passed'], [], [...reviewed(gpay, 'lee-android', 6), comment(runComment(repo, meta('android', 'pass', ago(2)), '', []), ago(2), 'sam-android')]);

  const apple = draft('Pay with Apple Pay', 'P0', ['ios'], 'Apple Pay set up with a sandbox card', [
    ['Given', 'a logged-in user with items in the cart'], ['When', 'the user picks Apple Pay and confirms with Face ID'], ['Then', 'the order confirmation screen shows'],
  ]);
  const n3 = gh.issues.length + 1;
  add(apple, 'failed', ['run:ios:failed'], ['jo-ios'], [
    ...reviewed(apple, 'jo-ios', 6),
    comment(runComment(repo, meta('ios', 'fail', ago(1, 3)), 'The Apple Pay sheet closes and nothing happens; no order is created.', [evidence(n3, 'ios', 'apple-pay-stuck.svg', 'Payment failed', 'Please try again', '#d03b3b')]), ago(1, 3), 'jo-ios'),
    comment(bugComment({ platform: 'ios', issue: 'acme/shop-app#212', url: 'https://github.com/acme/shop-app/issues/212' }), ago(1, 2), 'jo-ios'),
  ]);

  const network = { ...bankCases[2] };
  add(network, 'approved', [], ['sam-android', 'jo-ios'], [comment('<!-- tcm:edit {"changes":[]} -->\n📋 **Copied from the regression bank.**', ago(5), 'priya-pm')], copyNote({ ...bankCases[2], number: bank[2].number } as unknown as TestCase));

  const promo = draft('Promo code updates the order total', 'P1', ['android', 'ios'], 'Promo code SAVE10 active for 10% off', [
    ['Given', 'a cart totalling $50.00'], ['When', 'the user applies promo code "SAVE10"'], ['Then', 'the total is updated'],
  ]);
  add(promo, 'in-review', [], ['sam-android'], [
    comment(submitComment(['sam-android'], false), ago(1), 'priya-pm'),
    comment(lineComment(2, 'the total is updated', 'Say what the total becomes, so testers know what to check.', 'the total shows $45.00 and a "-$5.00" discount line'), ago(0, 20), 'lee-android'),
  ], '', 2);

  const expired = draft('Expired card shows an inline error', 'P1', ['android', 'ios'], '', [
    ['Given', 'a user paying with a card'], ['When', 'the user enters an expired card'], ['Then', 'an error is shown'],
  ]);
  add(expired, 'changes-requested', [], ['priya-pm'], [
    comment(submitComment(['jo-ios'], false), ago(3), 'priya-pm'),
    comment(reviewComment('ios', 'request_changes', '"An error is shown" is too vague. Which message, and where? Should the Pay button stay disabled?'), ago(2, 4), 'jo-ios'),
  ]);

  const cart = draft('Cart persists after the app restarts', 'P2', ['android', 'ios'], '', [
    ['Given', 'a logged-in user with three items in the cart'], ['When', 'the user force-quits and reopens the app'], ['Then', 'the cart still has the same three items'],
  ]);
  add(cart, 'draft', [], ['priya-pm'], [], '', 1);

  const back = draft('Back from the payment sheet keeps the cart', 'P2', ['android'], '', [
    ['Given', 'a user on the payment sheet'], ['When', 'the user presses the system Back button'], ['Then', 'the cart screen shows with all items intact'],
  ]);
  add(back, 'blocked', ['run:android:blocked'], ['sam-android'], [
    ...reviewed(back, 'lee-android', 5),
    comment(runComment(repo, meta('android', 'blocked', ago(1)), 'Staging build 41207 crashes when opening the payment sheet on Android 15.', []), ago(1), 'sam-android'),
  ]);

  const dynType = draft('Largest Dynamic Type keeps the Pay button visible', 'P3', ['ios'], 'Settings › Accessibility › Larger Text at maximum', [
    ['Given', 'the largest accessibility text size'], ['When', 'the user opens the payment screen'], ['Then', 'the "Pay" button is fully visible without horizontal scrolling'],
  ]);
  add(dynType, 'approved', [], ['jo-ios'], reviewed(dynType, 'jo-ios', 4));

  return gh;
}

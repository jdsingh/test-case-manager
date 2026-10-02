// End-to-end check of M1 flows against the production build (with its CSP) and a mocked
// GitHub. Run: bun run build && bun e2e/run.ts   (screenshots go to e2e/screenshots/)

import { chromium, type Locator, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MockGitHub } from './mock-github';

const DIST = join(import.meta.dir, '../dist/test-case-manager/browser');
const SHOTS = join(import.meta.dir, 'screenshots');
const PORT = 4310;
const BASE = `http://localhost:${PORT}`;
mkdirSync(SHOTS, { recursive: true });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(DIST, path === '/' ? 'index.html' : path));
    return (await file.exists()) ? new Response(file) : new Response(Bun.file(join(DIST, 'index.html')));
  },
});

let failures = 0;
function check(cond: unknown, what: string): void {
  if (cond) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.log(`  ✗ ${what}`);
  }
}

/** Waits up to 5 s for a locator to match exactly n elements. */
async function countIs(l: Locator, n: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if ((await l.count()) === n) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Waits up to 5 s for a locator to show; isVisible() alone doesn't wait for async content. */
async function shows(l: Locator): Promise<boolean> {
  return l.first().waitFor({ timeout: 5000 }).then(() => true, () => false);
}

const browser = await chromium.launch();
let current: Page | null = null;
let expect422 = false;

async function newPage(gh: MockGitHub): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    // The bad-token step makes one expected 401.
    if (/status of 401/.test(m.text())) return;
    // The M4 section simulates a concurrent evidence push once (an expected 422).
    if (/status of 422/.test(m.text()) && expect422) return;
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) {
      failures++;
      console.log(`  ✗ console ${m.type()}: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => {
    failures++;
    console.log(`  ✗ page error: ${e.message}`);
  });
  await gh.install(page);
  current = page;
  return page;
}

async function connect(page: Page, token: string): Promise<void> {
  await page.getByLabel('Personal access token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
}

try {
  // 1. Deep link before onboarding → connect → setup → team settings.
  console.log('First-time setup via a deep link');
  {
    const gh = new MockGitHub();
    const page = await newPage(gh);
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases?feature=7`);
    await page.waitForURL(/\/connect\?returnUrl=/);
    check(true, 'signed-out deep link goes to /connect with returnUrl');
    await page.screenshot({ path: join(SHOTS, '1-connect.png'), fullPage: true });

    await connect(page, 'nope');
    await page.getByRole('alert').waitFor();
    check((await page.getByRole('alert').textContent())?.includes('rejected'), 'a bad token shows a clear error');

    await connect(page, 'tok-priya-pm');
    await page.waitForURL(/\/setup/);
    check(true, 'unconfigured repo routes a writer to setup');
    check(await shows(page.getByText('labels will be created')), 'setup lists missing labels');
    await page.screenshot({ path: join(SHOTS, '2-setup.png'), fullPage: true });

    await page.getByRole('button', { name: 'Set up repo' }).click();
    await page.waitForURL(/\/settings\/team/);
    const { LABELS } = await import('../src/app/core/config/labels');
    check(gh.labels.length === LABELS.length + 1, `all ${LABELS.length} labels created`);
    check(gh.commits[0]?.headline === 'Set up Test Case Manager', 'config committed');
    const created = JSON.parse(gh.configText ?? '{}');
    check(created.team?.pm?.[0] === 'priya-pm', 'creator is PM in the new config');
    check(String(created.$schema).endsWith('/config.schema.json'), 'config links the JSON Schema');

    // 2. Team settings: add people, save.
    console.log('Team settings');
    const androidCard = page.locator('section.role', { has: page.getByRole('heading', { name: 'Android engineers' }) });
    await androidCard.getByRole('button', { name: '+ Add person' }).click();
    await androidCard.getByRole('combobox').fill('lee');
    await androidCard.getByRole('option', { name: /lee-android/ }).click();
    await androidCard.getByRole('button', { name: '+ Add person' }).click();
    await androidCard.getByRole('combobox').fill('sam');
    await androidCard.getByRole('combobox').press('Enter');
    const iosCard = page.locator('section.role', { has: page.getByRole('heading', { name: 'iOS engineers' }) });
    await iosCard.getByRole('button', { name: '+ Add person' }).click();
    await iosCard.getByRole('combobox').fill('jo');
    await iosCard.getByRole('option', { name: /jo-ios/ }).click();
    await page.getByLabel('Default Android reviewer').selectOption('sam-android');
    await page.locator('footer', { hasText: '4 unsaved changes' }).waitFor({ timeout: 5000 });
    check(true, 'footer counts unsaved changes');
    const summary = (await page.locator('footer').innerText()).replace(/\s+/g, ' ');
    check(!summary?.includes('priya-pm'), 'Enter right after typing picks the typed person');
    check(summary?.includes('Add lee-android to Android engineers'), 'footer summarises changes');
    await page.screenshot({ path: join(SHOTS, '3-team-unsaved.png'), fullPage: true });

    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('Saved.').waitFor();
    const saved = JSON.parse(gh.configText ?? '{}');
    check(saved.team.android.join() === 'lee-android,sam-android', 'Android engineers saved');
    check(saved.assignment?.defaultReviewer?.android === 'sam-android', 'default reviewer saved');
    check(gh.commits.at(-1)?.headline === 'Update team config: 4 changes', 'commit headline');
    check(gh.commits.at(-1)?.body?.startsWith('Add lee-android to Android engineers'), 'commit body lists changes');
    check((await page.getByLabel('Default Android reviewer').inputValue()) === 'sam-android', 'default reviewer shown after save');
    await page.screenshot({ path: join(SHOTS, '4-team-saved.png'), fullPage: true });

    // 3. Conflict: someone else saves while this user edits.
    console.log('Concurrent edit');
    const theirs = JSON.parse(gh.configText ?? '{}');
    theirs.team.techLead = ['alex-lead'];
    gh.externalSave(JSON.stringify(theirs, null, 2));
    await iosCard.getByRole('button', { name: '+ Add person' }).click();
    await iosCard.getByRole('combobox').fill('max');
    await iosCard.getByRole('option', { name: /max-ios/ }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('Someone else saved the team').waitFor();
    check(await shows(page.locator('li.chip', { hasText: 'alex-lead' })), "the other person's change is loaded");
    check(await shows(page.locator('li.chip.added', { hasText: 'max-ios' })), "this user's change is re-applied");
    await page.screenshot({ path: join(SHOTS, '5-team-conflict.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('Saved.').waitFor();
    const merged = JSON.parse(gh.configText ?? '{}');
    check(merged.team.techLead[0] === 'alex-lead' && merged.team.ios.includes('max-ios'), 'both edits end up saved');

    // 4. Protected branch → pull request.
    console.log('Protected branch');
    gh.protectedBranch = true;
    await page.locator('section.role', { has: page.getByRole('heading', { name: 'Tech lead' }) })
      .getByRole('button', { name: 'Remove alex-lead from Tech lead' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByText('proposed in pull request #1').waitFor();
    check(gh.pullRequests[0]?.branch.startsWith('tcm/team-config-'), 'falls back to a pull request');

    // 5. Role home: PM lands on test cases, with the feature picker.
    await page.goto(`${BASE}/r/acme/shop-app-testbank`);
    await page.waitForURL(/\/cases/);
    check(true, 'PM lands on test cases');
    check(await shows(page.locator('main').getByText('Checkout v2')), 'open feature board shown');
    check((await page.locator('option', { hasText: 'Old release' }).count()) === 0, 'closed board hidden');
    await page.screenshot({ path: join(SHOTS, '6-pm-home.png'), fullPage: true });
    await page.context().close();
  }

  // 6. Engineers land on the inbox; strangers get read-only; invalid config is reported.
  console.log('Roles and bad config');
  {
    const gh = new MockGitHub();
    gh.labels = [];
    gh.configText = JSON.stringify({ version: 1, team: { pm: ['priya-pm'], android: ['sam-android'] } });
    gh.labels = (await import('../src/app/core/config/labels')).LABELS.map((l) => l.name);

    let page = await newPage(gh);
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-sam-android');
    await page.waitForURL(/\/repos/);
    await page.getByRole('button', { name: /shop-app-testbank/ }).click();
    await page.waitForURL(/\/inbox/);
    check(true, 'Android engineer lands on inbox');
    await page.getByRole('link', { name: 'Team' }).click();
    check(await shows(page.getByText('Only the PM and tech lead can change the team')), 'engineers see the team read-only');
    check((await page.getByRole('button', { name: 'Save changes' }).count()) === 0, 'no save button for engineers');
    await page.context().close();

    page = await newPage(gh);
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-stranger');
    await page.waitForURL(/\/repos/);
    await page.goto(`${BASE}/r/acme/shop-app-testbank`);
    await page.waitForURL(/\/dashboard/);
    check(await shows(page.getByText("isn't on this team yet")), 'unknown user gets the viewer banner');
    await page.screenshot({ path: join(SHOTS, '7-viewer.png'), fullPage: true });

    gh.externalSave('{ "version": 1, "team": { "pm": ["priya pm"] } ');
    await page.reload();
    await page.getByText("The team config can't be read").waitFor();
    check(true, 'invalid config shows the parse error');
    await page.screenshot({ path: join(SHOTS, '8-invalid-config.png'), fullPage: true });
    await page.context().close();
  }

  // 7. M2: test cases.
  console.log('Test cases (M2)');
  {
    const { renderBody } = await import('../src/app/core/testcase/model');
    const { reviewComment } = await import('../src/app/core/testcase/comments');
    const gh = new MockGitHub();
    gh.labels = (await import('../src/app/core/config/labels')).LABELS.map((l) => l.name);
    gh.configText = JSON.stringify({
      version: 1,
      team: { pm: ['priya-pm'], techLead: ['alex-lead'], android: ['sam-android'], ios: ['jo-ios'] },
      features: { '7': { targetVersion: '4.12.0' } },
      assignment: { defaultReviewer: { android: 'sam-android' } },
    });
    const both = ['android', 'ios'] as ('android' | 'ios')[];
    gh.addIssue({
      title: '[TC] Guest checkout with saved card',
      body: renderBody({
        title: 'Guest checkout with saved card', priority: 'P0', platforms: both, preconditions: 'Card 4242 saved',
        steps: [
          { keyword: 'Given', text: 'a guest user with one item in the cart' },
          { keyword: 'When', text: 'the user taps Pay' },
          { keyword: 'Then', text: 'the order confirmation shows an order number' },
        ],
      }),
      labels: ['testcase', 'priority:P0', 'platform:android', 'platform:ios', 'status:approved', 'regression'],
      assignees: ['sam-android', 'jo-ios'],
      comments: [{ id: 'c1', body: reviewComment('android', 'approve', ''), createdAt: '2026-10-01T09:00:00Z', author: 'sam-android' }],
    });
    gh.addIssue({
      title: '[TC] Expired card shows an inline error',
      body: renderBody({
        title: 'Expired card shows an inline error', priority: 'P1', platforms: both, preconditions: '',
        steps: [
          { keyword: 'Given', text: 'a user paying with a card' },
          { keyword: 'When', text: 'the user enters an expired card' },
          { keyword: 'Then', text: 'an error is shown' },
        ],
      }),
      labels: ['testcase', 'priority:P1', 'platform:android', 'platform:ios', 'status:changes-requested'],
      assignees: ['priya-pm'],
      comments: [{ id: 'c2', body: reviewComment('android', 'request_changes', 'Too vague: which message?'), createdAt: '2026-10-01T09:30:00Z', author: 'sam-android' }],
    });
    gh.addIssue({
      title: '[TC] Cart persists after restart',
      body: renderBody({
        title: 'Cart persists after restart', priority: 'P2', platforms: ['android'], preconditions: '',
        steps: [
          { keyword: 'Given', text: 'three items in the cart' },
          { keyword: 'When', text: 'the app restarts' },
          { keyword: 'Then', text: 'the cart still has three items' },
        ],
      }),
      labels: ['testcase', 'priority:P2', 'platform:android', 'status:draft'],
      assignees: ['priya-pm'],
    });

    const page = await newPage(gh);
    page.on('dialog', (d) => void d.accept());
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-priya-pm');
    await page.waitForURL(/\/repos/);
    await page.goto(`${BASE}/r/acme/shop-app-testbank`);
    await page.waitForURL(/\/cases/);
    const rows = page.locator('table.cases tbody tr');
    await rows.first().waitFor();
    check(await countIs(rows, 3), 'list shows the 3 cases on the board');
    check(await shows(page.getByRole('button', { name: '1 Approved' })), 'status counts');
    await page.getByRole('button', { name: 'P0', exact: true }).click();
    await page.waitForURL(/priority=P0/);
    check(await countIs(rows, 1), 'priority filter, kept in the URL');
    await page.getByRole('button', { name: 'P0', exact: true }).click();
    await page.getByLabel('Search test cases').fill('expired');
    await page.waitForURL(/q=expired/);
    check(await countIs(rows, 1), 'search');
    await page.getByLabel('Search test cases').fill('');
    check(await countIs(rows, 3), 'clearing the search shows all again');
    await page.screenshot({ path: join(SHOTS, '9-cases-list.png'), fullPage: true });

    // New case: similar warning, validation, save and submit.
    await page.locator('h1').click(); // move focus out of the search box
    await page.keyboard.press('n');
    await page.waitForURL(/\/cases\/new/);
    await page.getByLabel('Scenario name').fill('Guest checkout with a saved card');
    await page.getByLabel('Step 1 text').fill('a guest user with one item in the cart');
    check(await shows(page.getByText('This looks like an existing test case')), 'duplicate warning (SL-2)');
    await page.getByLabel('Scenario name').fill('Promo code updates the order total');
    await page.getByLabel('Step 1 text').fill('a cart totalling $50');
    await page.getByLabel('Step 1 text').press('Enter');
    check(await shows(page.locator('li.step.and')), 'Enter adds an And step');
    check(await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Step 2 text').then(() => true, () => false), 'focus moves to the new step');
    await page.keyboard.type('promo code SAVE10 is active');
    await page.getByRole('button', { name: 'Save draft' }).click();
    check(await shows(page.getByText('Step 3 is empty.')), 'validation blocks empty steps');
    await page.getByLabel('Step 3 text').fill('the user applies SAVE10');
    await page.getByLabel('Step 4 text').fill('the total shows $45.00');
    check(await shows(page.locator('aside .gherkin', { hasText: 'And promo code SAVE10 is active' })), 'live preview');
    await page.screenshot({ path: join(SHOTS, '10-editor.png'), fullPage: true });
    await page.getByRole('button', { name: 'Save and submit for review' }).click();
    await page.waitForURL(/\/cases\/4/);
    const created = gh.issue(4);
    check(created.title === '[TC] Promo code updates the order total', 'issue created with [TC] title');
    check(created.labels.includes('status:in-review') && created.labels.includes('priority:P1'), 'labels set');
    check(created.projectIds.includes('P7'), 'added to the feature board');
    check(created.assignees.join() === 'sam-android', 'assigned to the default reviewer');
    check(created.comments[0]?.body.includes('@sam-android please review'), 'reviewer mentioned');
    check(created.body.includes('    And promo code SAVE10 is active'), 'body in the PRD format');

    // Edit an approved case: back to review (AU-8).
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/1/edit`);
    await page.getByLabel('Step 3 text').fill('the order confirmation shows an order number and ETA');
    check(await shows(page.getByText('Saving a change to its scenario sends it back to review')), 'warns before re-review');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForURL(/\/cases\/1(\?|$)/);
    const edited = gh.issue(1);
    check(edited.labels.includes('status:in-review') && edited.labels.includes('regression'), 'approved case back in review, regression kept');
    check(edited.comments.at(-1)?.body.includes('needs review again'), 'edit comment explains why');
    check(await shows(page.getByText('In review').first()), 'detail page shows the new status');

    // Changes requested → edit → resubmit.
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/2`);
    check(await shows(page.getByText('sam-android requested changes')), 'change request highlighted');
    await page.screenshot({ path: join(SHOTS, '11-detail-changes.png'), fullPage: true });
    await page.getByRole('link', { name: 'Edit' }).click();
    await page.getByLabel('Step 3 text').fill('"Card expired" shows under the card field');
    await page.getByLabel('Step 3 text').press('Enter');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Step 4 text');
    await page.keyboard.type('the Pay button stays disabled');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForURL(/\/cases\/2(\?|$)/);
    check(gh.issue(2).labels.includes('status:changes-requested'), 'edit alone keeps it waiting for resubmit');
    await page.getByRole('button', { name: 'Resubmit for review' }).click();
    check(await shows(page.getByRole('dialog').getByRole('checkbox', { name: /sam-android/, checked: true })), 'suggested reviewer pre-selected');
    await page.screenshot({ path: join(SHOTS, '12-resubmit-dialog.png') });
    await page.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForTimeout(300);
    check(gh.issue(2).labels.includes('status:in-review'), 'resubmitted');
    check(gh.issue(2).comments.at(-1)?.body.includes('Resubmitted'), 'resubmit comment');

    // Close as won't test, then reopen.
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/3`);
    await page.getByRole('button', { name: "Close as won't test" }).click();
    await page.getByLabel('Reason (optional)').fill('Moved to the next release');
    await page.getByRole('button', { name: 'Close case' }).click();
    await page.getByRole('button', { name: 'Reopen' }).waitFor();
    check(gh.issue(3).state === 'CLOSED', 'closed');
    await page.getByRole('button', { name: 'Reopen' }).click();
    await page.getByRole('button', { name: 'Submit for review' }).waitFor();
    check(gh.issue(3).state === 'OPEN' && gh.issue(3).labels.includes('status:draft'), 'reopened as Draft');

    // Duplicate prefills the editor; leaving asks to discard.
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await page.waitForURL(/\/cases\/new/);
    check((await page.getByLabel('Scenario name').inputValue()) === 'Cart persists after restart (copy)', 'duplicate prefills');
    await page.getByRole('link', { name: 'Cancel' }).click();
    await page.waitForURL(/\/cases(\?|$)/);
    check(gh.issues.length === 4, 'cancelled duplicate creates nothing');

    // Import from a Google Sheets paste (IM-1 to IM-3).
    console.log('Import and export');
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/import`);
    const sheet = [
      'Test case\tPriority\tPlatform\tGiven\tWhen\tExpected result',
      'Login with email\tHigh\tBoth\ta registered user\t"enters email\nand taps Log in"\tthe home screen shows',
      'Guest checkout with saved card\tP0\tBoth\ta guest\tpays\tit works',
      'Broken row\tP1\tAndroid\t\tdoes something\t',
    ].join('\n');
    await page.getByLabel(/Paste the cells from Google Sheets/).fill(sheet);
    check(await shows(page.getByText('1 ready · 1 already exist · 1 need fixing')), 'preview sorts rows into ready / exists / invalid');
    check((await page.getByLabel('Then / expected result').inputValue()) === '5', 'columns auto-mapped from headers');
    await page.screenshot({ path: join(SHOTS, '13-import-preview.png'), fullPage: true });
    await page.getByRole('button', { name: 'Import 1 as draft' }).click();
    await page.getByText('Created 1 test case as drafts.').waitFor({ timeout: 15000 });
    const imported = gh.issues.at(-1)!;
    check(imported.title === '[TC] Login with email' && imported.labels.includes('status:draft') && imported.labels.includes('priority:P1'), 'imported as a P1 draft');
    check(imported.projectIds.includes('P7') && imported.body.includes('    And taps Log in'), 'on the board, multi-line cell became And');
    await page.getByLabel(/Paste the cells from Google Sheets/).fill(sheet + '\n');
    check(await shows(page.getByText('0 ready · 2 already exist · 1 need fixing')), 're-running skips cases already imported');

    // Bulk Gherkin paste with tags (AU-6).
    await page.getByRole('tab', { name: 'Gherkin' }).click();
    await page.getByLabel(/Paste one or more scenarios/).fill(`@P0 @ios
Scenario: Apple Pay checkout
  Given a cart with one item
  When the user pays with Apple Pay
  Then the order is placed

@P3
Scenario: Order history shows the new order
  Given a completed order
  When the user opens order history
  Then the order is listed first`);
    check(await shows(page.getByText('2 ready · 0 already exist · 0 need fixing')), 'two scenarios parsed');
    const before = gh.issues.length;
    await page.getByRole('button', { name: 'Import 2 as drafts' }).click();
    await page.getByText('Created 2 test cases as drafts.').waitFor({ timeout: 15000 });
    const applePay = gh.issues.find((i) => i.title === '[TC] Apple Pay checkout')!;
    check(gh.issues.length === before + 2, 'both created');
    check(applePay.labels.includes('priority:P0') && applePay.labels.includes('platform:ios') && !applePay.labels.includes('platform:android'), 'tags set priority and platform');

    // Export the list to CSV (IM-4).
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases`);
    await rows.first().waitFor();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    const csv = await Bun.file((await dl.path())!).text();
    const { parseDelimited } = await import('../src/app/core/import/csv');
    const table = parseDelimited(csv);
    check(dl.suggestedFilename().endsWith('.csv') && table.length === 1 + (await rows.count()), 'CSV has a row per listed case');
    check(table[0].includes('Latest Android run') && table.some((r) => r[1] === 'Apple Pay checkout'), 'CSV columns and content');
    await page.context().close();
  }

  // 8. M3: review.
  console.log('Review (M3)');
  {
    const { renderBody } = await import('../src/app/core/testcase/model');
    const { submitComment, editComment, parseMarker } = await import('../src/app/core/testcase/comments');
    const gh = new MockGitHub();
    gh.labels = (await import('../src/app/core/config/labels')).LABELS.map((l) => l.name);
    gh.configText = JSON.stringify({
      version: 1,
      team: { pm: ['priya-pm'], techLead: ['alex-lead'], android: ['sam-android', 'lee-android'], ios: ['jo-ios'] },
    });
    const body = (title: string, platforms: ('android' | 'ios')[]) =>
      renderBody({
        title, priority: 'P1', platforms, preconditions: '',
        steps: [
          { keyword: 'Given', text: 'a cart totalling $50' },
          { keyword: 'When', text: 'the user applies SAVE10' },
          { keyword: 'Then', text: 'the total is updated' },
        ],
      });
    const labels = (status: string, platforms: string[]) => ['testcase', 'priority:P1', `status:${status}`, ...platforms.map((p) => `platform:${p}`)];
    const at = (m: number) => `2026-10-01T09:${String(m).padStart(2, '0')}:00Z`;
    gh.addIssue({ title: '[TC] Promo code updates the total', body: body('Promo code updates the total', ['android', 'ios']), labels: labels('in-review', ['android', 'ios']), assignees: ['sam-android'],
      comments: [{ id: 'k1', body: submitComment(['sam-android'], false), createdAt: at(1), author: 'priya-pm' }] });
    gh.addIssue({ title: '[TC] Apple Pay checkout', body: body('Apple Pay checkout', ['ios']), labels: labels('in-review', ['ios']), assignees: ['jo-ios'],
      comments: [{ id: 'k2', body: submitComment(['jo-ios'], false), createdAt: at(2), author: 'priya-pm' }] });
    gh.addIssue({ title: '[TC] Back keeps the cart', body: body('Back keeps the cart', ['android']), labels: labels('in-review', ['android']), assignees: ['sam-android'],
      comments: [
        { id: 'k3', body: submitComment(['lee-android'], false), createdAt: at(3), author: 'priya-pm' },
        { id: 'k4', body: editComment(['steps'], true, ['sam-android']), createdAt: at(4), author: 'sam-android' },
      ] });
    gh.addIssue({ title: '[TC] Already approved', body: body('Already approved', ['android', 'ios']), labels: labels('approved', ['android', 'ios']), assignees: ['sam-android', 'jo-ios'] });

    // Sam, an Android engineer.
    let page = await newPage(gh);
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-sam-android');
    await page.waitForURL(/\/repos/);
    await page.goto(`${BASE}/r/acme/shop-app-testbank`);
    await page.waitForURL(/\/inbox/);
    check(await shows(page.locator('section.group', { hasText: 'To review' }).getByText('Promo code updates the total')), 'inbox lists cases to review');
    check(await shows(page.locator('.nav-count', { hasText: '3' })), 'nav shows the inbox count');
    check(await page.waitForFunction(() => document.title.startsWith('(3) Inbox')).then(() => true, () => false), 'tab title carries the count (IN-2)');
    await page.screenshot({ path: join(SHOTS, '14-inbox.png'), fullPage: true });

    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await page.waitForURL(/\/review/);
    const queue = page.getByRole('navigation', { name: 'Review queue' }).getByRole('button');
    check(await countIs(queue, 2), 'queue has the Android-eligible cases only (RV-2)');
    check(await shows(page.getByRole('heading', { name: /Promo code updates the total/ })), 'first case opened');

    // Comment on a step with a suggestion (LR-1, LR-2).
    await page.locator('.step').nth(2).hover();
    await page.getByRole('button', { name: 'Comment on step 3' }).click();
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Say what the total becomes.');
    await page.getByLabel('Suggest new wording').check();
    await page.getByRole('textbox', { name: 'Suggested wording' }).fill('the total shows $45.00');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.locator('.note', { hasText: 'Say what the total becomes.' }).waitFor();
    const line = parseMarker(gh.issue(1).comments.at(-1)!.body);
    check(line?.kind === 'line' && line.data['step'] === 2 && line.data['suggestion'] === 'the total shows $45.00', 'step comment stored with its suggestion');
    await page.screenshot({ path: join(SHOTS, '15-review-mode.png'), fullPage: true });

    // A approves; the case moves to its runners (5.3a).
    await page.locator('h1').click();
    await page.keyboard.press('a');
    await page.getByText('Approved #1 Promo code updates the total.').waitFor();
    const approved = gh.issue(1);
    check(approved.labels.includes('status:approved'), 'one approval approves the case (RV-3)');
    check(approved.assignees.join() === 'lee-android,jo-ios', 'assigned to the least-busy Android engineer and the iOS engineer');
    check(parseMarker(approved.comments.at(-1)!.body)?.data['platform'] === 'android', 'review recorded for Android');

    // AU-9: Sam edited #3, so Sam can't approve it.
    check(await shows(page.getByRole('heading', { name: /Back keeps the cart/ })), 'moves on to the next case');
    check(await shows(page.getByText('You edited this version')), "can't approve own edit (AU-9)");
    await page.keyboard.press('a');
    await page.waitForTimeout(300);
    check(gh.issue(3).labels.includes('status:in-review'), 'shortcut does nothing when not allowed');
    await page.context().close();

    // Jo (iOS) requests changes on the iOS-only case.
    page = await newPage(gh);
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-jo-ios');
    await page.waitForURL(/\/repos/);
    await page.goto(`${BASE}/r/acme/shop-app-testbank/review`);
    await page.getByRole('heading', { name: /Apple Pay checkout/ }).waitFor();
    await page.locator('.step').nth(2).hover();
    await page.getByRole('button', { name: 'Comment on step 3' }).click();
    await page.getByLabel('Suggest new wording').check();
    await page.getByRole('textbox', { name: 'Suggested wording' }).fill('the order confirmation shows');
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.locator('.note', { hasText: 'the order confirmation shows' }).waitFor();
    await page.getByRole('button', { name: /Request changes/ }).click();
    check(await shows(page.getByText('Say what needs to change')), 'a change request needs a comment');
    await page.getByRole('textbox', { name: 'Review comment' }).fill('Then step is vague; see my suggestion.');
    await page.getByRole('button', { name: /Request changes/ }).click();
    await page.getByText('Requested changes on #2').waitFor();
    check(gh.issue(2).labels.includes('status:changes-requested') && gh.issue(2).assignees.join() === 'priya-pm', 'back to the author (5.3a)');
    await page.context().close();

    // Priya accepts the suggestion and reassigns runners.
    page = await newPage(gh);
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-priya-pm');
    await page.waitForURL(/\/repos/);
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/2`);
    await page.getByText('jo-ios requested changes').waitFor();
    await page.getByRole('button', { name: 'Accept suggestion' }).click();
    await page.locator('.tag', { hasText: 'applied' }).waitFor();
    check(gh.issue(2).body.includes('Then the order confirmation shows'), 'suggestion applied to the step');
    check(gh.issue(2).labels.includes('status:changes-requested'), 'still waiting for a resubmit');
    await page.screenshot({ path: join(SHOTS, '16-suggestion-applied.png'), fullPage: true });

    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/1`);
    await page.getByRole('button', { name: 'change' }).click();
    await page.getByLabel('Runs on Android').selectOption('sam-android');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForTimeout(300);
    check(gh.issue(1).assignees.join() === 'sam-android,jo-ios', 'runner reassigned per platform (AS-2)');
    check(await shows(page.getByText('earlier version').or(page.getByText('Approved for Android'))), 'review history shown');
    await page.context().close();
  }

  // 9. M4: runs, evidence, test session, bugs, bulk assign.
  console.log('Runs and evidence (M4)');
  {
    const { renderBody } = await import('../src/app/core/testcase/model');
    const { submitComment, reviewComment, parseMarker } = await import('../src/app/core/testcase/comments');
    const gh = new MockGitHub();
    gh.labels = [...(await import('../src/app/core/config/labels')).LABELS.map((l) => l.name), 'bug'];
    gh.configText = JSON.stringify({
      version: 1,
      team: { pm: ['priya-pm'], techLead: ['alex-lead'], android: ['lee-android', 'sam-android'], ios: ['jo-ios'] },
      features: { '7': { targetVersion: '4.12.0' } },
    });
    const body = (title: string, platforms: ('android' | 'ios')[]) =>
      renderBody({
        title, priority: 'P0', platforms, preconditions: 'Card 4242 saved',
        steps: [
          { keyword: 'Given', text: 'a guest with one item in the cart' },
          { keyword: 'When', text: 'they pay with the saved card' },
          { keyword: 'Then', text: 'the confirmation shows an order number' },
        ],
      });
    const labels = (status: string, platforms: string[]) => ['testcase', 'priority:P0', `status:${status}`, ...platforms.map((p) => `platform:${p}`)];
    const reviewed = (who: string) => [
      { id: `s-${who}`, body: submitComment([who], false), createdAt: '2026-10-01T08:00:00Z', author: 'priya-pm' },
      { id: `a-${who}`, body: reviewComment('android', 'approve', ''), createdAt: '2026-10-01T08:30:00Z', author: who },
    ];
    gh.addIssue({ title: '[TC] Guest checkout', body: body('Guest checkout', ['android', 'ios']), labels: labels('approved', ['android', 'ios']), assignees: ['lee-android', 'jo-ios'], comments: reviewed('sam-android') });
    gh.addIssue({ title: '[TC] Google Pay', body: body('Google Pay', ['android']), labels: labels('approved', ['android']), assignees: ['lee-android'], comments: reviewed('sam-android') });
    gh.addIssue({ title: '[TC] Back keeps the cart', body: body('Back keeps the cart', ['android']), labels: labels('approved', ['android']), assignees: ['sam-android'], comments: reviewed('lee-android') });
    gh.addIssue({ title: '[TC] Still in review', body: body('Still in review', ['android']), labels: labels('in-review', ['android']), assignees: ['sam-android'] });

    const png = Buffer.from(await Bun.file(join(SHOTS, '1-connect.png')).arrayBuffer());
    let page = await newPage(gh);
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-lee-android');
    await page.waitForURL(/\/repos/);

    // Run form on the case page (EX-1 to EX-5).
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/4`);
    await page.getByText('Runs can be recorded once the case is approved.').waitFor();
    check(true, 'no runs before approval (EX-7)');
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases/1`);
    await page.getByRole('button', { name: 'Record a run' }).click();
    check((await page.getByLabel('App version').inputValue()) === '4.12.0', 'version prefilled with the target');
    await page.getByLabel('Build number').fill('41207');
    await page.getByLabel('Device').fill('Pixel 8');
    await page.getByLabel('OS version').fill('Android 15');
    await page.locator('app-run-form input[type=file]').setInputFiles({ name: 'confirmation.png', mimeType: 'image/png', buffer: png });
    check(await shows(page.locator('.chosen li', { hasText: 'confirmation.png' })), 'evidence attached with a preview');
    gh.raceOnce = true; // someone else pushes evidence at the same moment
    expect422 = true;
    await page.getByRole('button', { name: 'Record passed run' }).click();
    await page.locator('.result.res-pass').waitFor({ timeout: 15000 });
    const i1 = gh.issue(1);
    const run = parseMarker(i1.comments.at(-1)!.body);
    const path = (run?.data['evidence'] as { path: string }[])[0]?.path ?? '';
    check(run?.kind === 'run' && run.data['device'] === 'Pixel 8' && run.data['build'] === '41207', 'run comment with metadata');
    check(/^evidence\/1\/\d{8}T\d{6}Z-android-1\.png$/.test(path) && gh.evidence.get(path)?.length === png.length, 'evidence on the tcm-evidence branch, after a retry');
    check(gh.evidenceCommits[0].parents.length === 0, 'evidence branch starts as an orphan');
    check(i1.comments.at(-1)!.body.includes('blob/tcm-evidence/evidence/1/'), 'evidence embedded in the comment for GitHub');
    check(i1.labels.includes('run:android:passed') && i1.labels.includes('status:approved'), 'Android passed; still approved until iOS runs');
    check(i1.assignees.join() === 'jo-ios', 'the Android runner is unassigned after passing (5.3a)');
    check(await shows(page.locator('app-evidence-thumb img[src^="blob:"]')), 'evidence thumbnail loads through the API');
    await page.screenshot({ path: join(SHOTS, '17-case-runs.png'), fullPage: true });

    // Test session (TS-1 to TS-7).
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases`);
    await page.getByRole('link', { name: 'Start test session' }).click();
    await page.waitForURL(/\/session/);
    check((await page.getByLabel('Device').inputValue()) === 'Pixel 8', 'session remembers the device (TS-4)');
    check(await shows(page.getByText('1 case to run on Android')), 'only my runnable cases; passed ones left out');
    await page.getByLabel('Also include cases assigned to other engineers').check();
    check(await shows(page.getByText('2 cases to run on Android')), 'can widen to others');
    await page.getByRole('button', { name: 'Start session' }).click();
    await page.getByRole('heading', { name: 'Google Pay' }).waitFor();
    await page.locator('h1').click();
    await page.keyboard.press(' ');
    check(await shows(page.locator('.steps li.done')), 'Space ticks the next step');
    await page.screenshot({ path: join(SHOTS, '18-session.png'), fullPage: true });
    await page.keyboard.press('p');
    await page.getByRole('heading', { name: 'Back keeps the cart' }).waitFor();
    check(true, 'P records a pass and moves on');
    await page.keyboard.press('f');
    check(await shows(page.getByText('Add a note saying why it failed')), 'Fail needs a note');
    await page.getByPlaceholder(/Anything worth knowing/).fill('Back returns to the home screen; cart is empty.');
    await page.locator('h1').click();
    await page.keyboard.press('f');
    await page.getByText('File a bug for this failure?').waitFor();
    check((await page.getByLabel('Bug title').inputValue()) === '[Android] Back keeps the cart fails', 'bug prefilled (TS-6)');
    check((await page.getByLabel('Bug description').inputValue()).includes('cart is empty'), 'bug includes the notes');
    await page.getByRole('button', { name: 'File bug' }).click();
    await page.getByRole('heading', { name: 'All done' }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.bar .spinner'), undefined, { timeout: 20000 });
    const bug = gh.issues.find((i) => i.title === '[Android] Back keeps the cart fails');
    check(!!bug && bug.labels.includes('bug'), 'bug filed with the bug label');
    check(gh.issue(3).comments.some((c) => c.body.startsWith('<!-- tcm:bug')), 'bug linked from the test case');
    check(gh.issue(2).labels.includes('status:passed') && gh.issue(2).assignees.length === 0, 'single-platform pass → Passed, nobody left assigned');
    check(gh.issue(3).labels.includes('status:failed') && gh.issue(3).labels.includes('run:android:failed'), 'fail → Failed');
    check(gh.issue(3).assignees.join() === 'lee-android', 'whoever ran the failing case takes the slot (AS-3)');
    await page.context().close();

    // Bulk-assign runners as the PM (AS-5).
    page = await newPage(gh);
    page.on('dialog', (d) => void d.accept());
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-priya-pm');
    await page.waitForURL(/\/repos/);
    await page.goto(`${BASE}/r/acme/shop-app-testbank/cases`);
    await page.locator('table.cases tbody tr').first().waitFor();
    await page.getByLabel('Select all runnable cases').check();
    check(await shows(page.getByText('3 selected')), 'only runnable cases selectable');
    await page.getByLabel('Android runner').selectOption('sam-android');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('region', { name: 'Bulk actions' }).waitFor({ state: 'hidden' });
    check(gh.issue(1).assignees.join() === 'sam-android,jo-ios' && gh.issue(3).assignees.join() === 'sam-android', 'runners assigned per platform in bulk');
    check(gh.issue(4).assignees.join() === 'sam-android', 'in-review case untouched');
    await page.context().close();
  }

  // 10. M5: dashboard.
  console.log('Dashboard (M5)');
  {
    const { renderBody } = await import('../src/app/core/testcase/model');
    const { runComment, bugComment } = await import('../src/app/core/testcase/runs');
    const gh = new MockGitHub();
    gh.labels = (await import('../src/app/core/config/labels')).LABELS.map((l) => l.name);
    const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
    const release = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    gh.configText = JSON.stringify({
      version: 1,
      team: { pm: ['priya-pm'], techLead: ['alex-lead'], android: ['sam-android'], ios: ['jo-ios'] },
      features: { '7': { targetVersion: '4.12.0', releaseDate: release } },
    });
    const mk = (title: string, priority: string, status: string, platforms: ('android' | 'ios')[], runs: string[], comments: { body: string; at: string; who: string }[] = []) =>
      gh.addIssue({
        title: `[TC] ${title}`,
        body: renderBody({ title, priority: priority as 'P0', platforms, preconditions: '', steps: [{ keyword: 'Given', text: 'a' }, { keyword: 'When', text: 'b' }, { keyword: 'Then', text: 'c' }] }),
        labels: ['testcase', `priority:${priority}`, `status:${status}`, ...platforms.map((p) => `platform:${p}`), ...runs],
        comments: comments.map((c, i) => ({ id: `d${title}${i}`, body: c.body, createdAt: c.at, author: c.who })),
      });
    const run = (platform: 'android' | 'ios', result: 'pass' | 'fail' | 'blocked', at: string, notes = '') =>
      runComment('acme/shop-app-testbank', { platform, result, appVersion: '4.12.0', build: '41207', device: platform === 'ios' ? 'iPhone 15' : 'Pixel 8', os: '', env: 'staging', executedAt: at }, notes, []);
    mk('Guest checkout', 'P0', 'passed', ['android', 'ios'], ['run:android:passed', 'run:ios:passed'], [
      { body: run('android', 'pass', daysAgo(3)), at: daysAgo(3), who: 'sam-android' },
      { body: run('ios', 'pass', daysAgo(2)), at: daysAgo(2), who: 'jo-ios' },
    ]);
    mk('Saved card', 'P0', 'failed', ['android', 'ios'], ['run:android:passed', 'run:ios:failed'], [
      { body: run('android', 'pass', daysAgo(2)), at: daysAgo(2), who: 'sam-android' },
      { body: run('ios', 'fail', daysAgo(1), 'Pay button does nothing'), at: daysAgo(1), who: 'jo-ios' },
      { body: bugComment({ platform: 'ios', issue: 'acme/shop-app#88', url: 'https://github.com/acme/shop-app/issues/88' }), at: daysAgo(1), who: 'jo-ios' },
    ]);
    mk('Google Pay', 'P0', 'approved', ['android'], []);
    mk('Dynamic Type', 'P1', 'blocked', ['ios'], ['run:ios:blocked'], [{ body: run('ios', 'blocked', daysAgo(1), 'Build crashes on launch'), at: daysAgo(1), who: 'jo-ios' }]);
    mk('Order history', 'P2', 'draft', ['android'], []);

    const page = await newPage(gh);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${BASE}/connect`);
    await connect(page, 'tok-alex-lead');
    await page.waitForURL(/\/repos/);
    await page.goto(`${BASE}/r/acme/shop-app-testbank`);
    await page.waitForURL(/\/dashboard/);
    check(await shows(page.getByRole('heading', { name: 'Not ready: 1 P0 failing on iOS, 1 P0 not run.' })), 'one-line verdict (RR-1, DB-3)');
    check(await shows(page.locator('app-platform-bar', { hasText: 'Android' }).getByText('2 of 3 passed')), 'Android progress (DB-2)');
    check(await shows(page.locator('app-platform-bar', { hasText: 'iOS' }).getByText('1 of 3 passed')), 'iOS progress');
    check(await shows(page.locator('app-burndown-chart path.actual')), 'burndown drawn (RR-2)');
    const svg = page.locator('app-burndown-chart svg');
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    check(await shows(page.locator('app-burndown-chart .tip')), 'crosshair readout on hover');
    check(await shows(page.locator('.problems li', { hasText: 'Saved card' }).getByRole('link', { name: 'acme/shop-app#88' })), 'failing case with its bug (DB-4)');
    check(await shows(page.locator('.problems li', { hasText: 'Dynamic Type' }).getByText('Build crashes on launch')), 'blocked case with the run note');
    check(await shows(page.locator('.changes li', { hasText: 'failed on iOS v4.12.0' })), 'what changed (RR-3)');
    await page.screenshot({ path: join(SHOTS, '19-dashboard.png'), fullPage: true });

    await page.getByRole('button', { name: 'Copy readiness report' }).click();
    const md = await page.evaluate(() => navigator.clipboard.readText());
    check(md.includes('**⛔ Not ready: 1 P0 failing on iOS, 1 P0 not run.**') && md.includes('| iOS | 1 | 1 | 1 | 0 |'), 'readiness report copied (RR-4)');

    // Feature settings (DB-5).
    await page.getByRole('button', { name: 'edit' }).click();
    await page.getByLabel('Release date').fill('2026-12-01');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('release 2026-12-01').waitFor();
    check(JSON.parse(gh.configText!).features['7'].releaseDate === '2026-12-01', 'release date saved to the config');

    // A grid cell opens the filtered list (DB-1).
    await page.locator('.grid-table a.c-failed').first().click();
    await page.waitForURL(/\/cases\?.*priority=P0.*status=failed|\/cases\?.*status=failed.*priority=P0/);
    check(await countIs(page.locator('table.cases tbody tr'), 1), 'grid cell opens the filtered list');
    await page.context().close();
  }
} catch (e) {
  failures++;
  console.log(`  ✗ ${(e as Error).message.split('\n')[0]}`);
  if (current) {
    await current.screenshot({ path: join(SHOTS, 'failure.png'), fullPage: true });
    console.log(`    url: ${current.url()}\n    banners: ${(await current.locator('.banner').allInnerTexts()).join(' | ')}`);
  }
} finally {
  await browser.close();
  server.stop();
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);

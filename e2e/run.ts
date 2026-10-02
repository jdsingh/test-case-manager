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

async function newPage(gh: MockGitHub): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    // The bad-token step makes one expected 401.
    if (/status of 401/.test(m.text())) return;
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

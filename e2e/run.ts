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
    check(await shows(page.getByRole('link', { name: 'Checkout v2' })), 'open feature board shown');
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

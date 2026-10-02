// The app's in-memory GitHub (src/app/core/demo/fake-github.ts), wired into Playwright:
// every request the page makes to api.github.com is answered by it.

import type { Page } from 'playwright';
import { FakeGitHub, FakeIssue, fakeAvatar } from '../src/app/core/demo/fake-github';

export type MockIssue = FakeIssue;

export class MockGitHub extends FakeGitHub {
  async install(page: Page): Promise<void> {
    await page.route('https://api.github.com/**', async (route) => {
      const req = route.request();
      const res = this.handle({
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
        body: req.method() === 'GET' || req.method() === 'OPTIONS' ? null : req.postDataJSON(),
      });
      await route.fulfill({
        status: res.status,
        headers: res.headers,
        contentType: res.contentType,
        body: typeof res.body === 'string' ? res.body : Buffer.from(res.body),
      });
    });
    // Chip avatars load from github.com/<login>.png.
    await page.route(/^https:\/\/github\.com\/[^/]+\.png/, (route) =>
      route.fulfill({ contentType: 'image/svg+xml', body: decodeURIComponent(fakeAvatar('x').split(',')[1]) }),
    );
  }
}

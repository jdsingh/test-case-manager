import { inject } from '@angular/core';
import { CanActivateChildFn, CanActivateFn, Router } from '@angular/router';
import { Session } from './session';
import { Workspace } from './workspace';
import { homeFor } from './config/team-config';
import { lastRepoUrl, rememberRepo } from './last-repo';

export const DEMO_URL = '/r/acme/shop-app-testbank';

/** Signed-in only. Remembers where the user was going so deep links survive onboarding (NV-2). */
export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  await session.restore();
  if (session.state().status === 'signed-in') return true;
  return router.createUrlTree(['/connect'], { queryParams: { returnUrl: state.url } });
};

/** Loads the repo named in the URL before its pages render. Errors are shown by the shell. */
export const repoGuard: CanActivateFn = async (route) => {
  const ws = inject(Workspace);
  const session = inject(Session); // inject() only works before the first await
  const owner = route.paramMap.get('owner') ?? '';
  const name = route.paramMap.get('repo') ?? '';
  // Guards run in parallel: make sure the session (and its client) is ready first.
  await session.restore();
  if (session.state().status !== 'signed-in') return true; // authGuard redirects
  await ws.open(owner, name);
  // The sample repo isn't real, so it's never offered as "your last repo".
  if (ws.load().status === 'ready' && !session.isDemo()) rememberRepo(owner, name);
  return true;
};

/** /r/:owner/:repo → setup if the repo isn't ready, else the role's home screen (TC-2). */
export const roleHomeGuard: CanActivateFn = (route) => {
  const ws = inject(Workspace);
  const router = inject(Router);
  const repo = ws.repo();
  if (!repo) return true; // the shell shows the load error
  const base = ['/r', repo.owner, repo.name];
  if (ws.needsSetup() && ws.canWriteRepo()) {
    return router.createUrlTree([...base, 'setup'], { queryParams: route.queryParams });
  }
  return router.createUrlTree([...base, homeFor(ws.roles())], { queryParams: route.queryParams });
};

/** Writers are sent to setup until the repo has its labels and config (ON-4). */
export const setupGuard: CanActivateChildFn = (route) => {
  const ws = inject(Workspace);
  const router = inject(Router);
  const repo = ws.repo();
  if (!repo || route.routeConfig?.path === 'setup' || !ws.needsSetup() || !ws.canWriteRepo()) return true;
  return router.createUrlTree(['/r', repo.owner, repo.name, 'setup'], { queryParams: route.queryParams });
};

/** / → the last repo, the repo picker, or onboarding. */
export const startGuard: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  await session.restore();
  if (session.state().status !== 'signed-in') return router.createUrlTree(['/connect']);
  if (session.isDemo()) return router.parseUrl(DEMO_URL);
  return router.parseUrl(lastRepoUrl() ?? '/repos');
};

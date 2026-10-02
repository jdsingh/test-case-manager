import { Routes } from '@angular/router';
import { authGuard, repoGuard, roleHomeGuard, setupGuard, startGuard } from './core/guards';
import { ConnectPage } from './features/onboarding/connect.page';
import { ReposPage } from './features/onboarding/repos.page';
import { RepoShell } from './features/shell/repo-shell';
import { SetupPage } from './features/onboarding/setup.page';
import { TeamSettingsPage } from './features/team/team-settings.page';
import { ComingSoonPage } from './features/shell/coming-soon.page';

export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [startGuard], children: [] },
  { path: 'connect', component: ConnectPage, title: 'Connect · Test Case Manager' },
  { path: 'repos', component: ReposPage, canActivate: [authGuard], title: 'Choose repo · Test Case Manager' },
  {
    path: 'r/:owner/:repo',
    component: RepoShell,
    canActivate: [authGuard, repoGuard],
    canActivateChild: [setupGuard],
    runGuardsAndResolvers: 'paramsChange',
    children: [
      { path: '', pathMatch: 'full', canActivate: [roleHomeGuard], children: [] },
      { path: 'setup', component: SetupPage, title: 'Set up · Test Case Manager' },
      { path: 'settings/team', component: TeamSettingsPage, title: 'Team settings · Test Case Manager' },
      {
        path: 'cases',
        component: ComingSoonPage,
        title: 'Test cases · Test Case Manager',
        data: {
          heading: 'Test cases',
          milestone: 'M2',
          blurb: 'Write Given/When/Then test cases, import a Google Sheet and submit cases for review.',
        },
      },
      {
        path: 'inbox',
        component: ComingSoonPage,
        title: 'Inbox · Test Case Manager',
        data: {
          heading: 'Inbox',
          milestone: 'M3',
          blurb: 'Everything assigned to you: cases to review, cases to run and change requests.',
        },
      },
      {
        path: 'dashboard',
        component: ComingSoonPage,
        title: 'Dashboard · Test Case Manager',
        data: {
          heading: 'Dashboard',
          milestone: 'M5',
          blurb: 'Counts by priority and status, platform progress and the ship-readiness verdict.',
        },
      },
    ],
  },
  { path: '**', redirectTo: '' },
];

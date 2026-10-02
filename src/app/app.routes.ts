import { Routes } from '@angular/router';
import { authGuard, repoGuard, roleHomeGuard, setupGuard, startGuard } from './core/guards';
import { ConnectPage } from './features/onboarding/connect.page';
import { ReposPage } from './features/onboarding/repos.page';
import { RepoShell } from './features/shell/repo-shell';
import { SetupPage } from './features/onboarding/setup.page';
import { TeamSettingsPage } from './features/team/team-settings.page';
import { ComingSoonPage } from './features/shell/coming-soon.page';
import { CasesListPage } from './features/cases/cases-list.page';
import { CaseDetailPage } from './features/cases/case-detail.page';
import { CaseEditorPage } from './features/cases/case-editor.page';
import { ImportPage } from './features/cases/import.page';
import { InboxPage } from './features/inbox/inbox.page';
import { ReviewPage } from './features/review/review.page';
import { SessionPage } from './features/runs/session.page';

const leaveEditorGuard = (c: CaseEditorPage) => c.canLeave();

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
      { path: 'cases', component: CasesListPage, title: 'Test cases · Test Case Manager' },
      {
        path: 'cases/new',
        component: CaseEditorPage,
        canDeactivate: [leaveEditorGuard],
        title: 'New test case · Test Case Manager',
      },
      {
        path: 'cases/import',
        component: ImportPage,
        canDeactivate: [(c: ImportPage) => c.canLeave()],
        title: 'Import · Test Case Manager',
      },
      { path: 'cases/:number', component: CaseDetailPage, title: 'Test case · Test Case Manager' },
      {
        path: 'cases/:number/edit',
        component: CaseEditorPage,
        canDeactivate: [leaveEditorGuard],
        title: 'Edit test case · Test Case Manager',
      },
      { path: 'inbox', component: InboxPage, title: 'Inbox · Test Case Manager' },
      { path: 'review', component: ReviewPage, title: 'Review · Test Case Manager' },
      { path: 'session', component: SessionPage, title: 'Test session · Test Case Manager' },
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

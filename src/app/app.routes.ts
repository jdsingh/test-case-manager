import { Routes } from '@angular/router';
import { authGuard, repoGuard, roleHomeGuard, setupGuard, startGuard } from './core/guards';
import { ConnectPage } from './features/onboarding/connect.page';
import { RepoShell } from './features/shell/repo-shell';

/** Pages that can hold unsaved work implement canLeave(). */
interface Leavable {
  canLeave(): boolean;
}
const confirmLeave = (c: Leavable) => c.canLeave();

const title = (page: string) => `${page} · Test Case Manager`;

// Pages load on first visit, so the first screen only downloads the shell.
export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [startGuard], children: [] },
  { path: 'connect', component: ConnectPage, title: title('Connect') },
  {
    path: 'repos',
    loadComponent: () => import('./features/onboarding/repos.page').then((m) => m.ReposPage),
    canActivate: [authGuard],
    title: title('Choose repo'),
  },
  {
    path: 'r/:owner/:repo',
    component: RepoShell,
    canActivate: [authGuard, repoGuard],
    canActivateChild: [setupGuard],
    runGuardsAndResolvers: 'paramsChange',
    children: [
      { path: '', pathMatch: 'full', canActivate: [roleHomeGuard], children: [] },
      {
        path: 'setup',
        loadComponent: () => import('./features/onboarding/setup.page').then((m) => m.SetupPage),
        title: title('Set up'),
      },
      {
        path: 'settings/team',
        loadComponent: () => import('./features/team/team-settings.page').then((m) => m.TeamSettingsPage),
        title: title('Team settings'),
      },
      {
        path: 'cases',
        loadComponent: () => import('./features/cases/cases-list.page').then((m) => m.CasesListPage),
        title: title('Test cases'),
      },
      {
        path: 'cases/new',
        loadComponent: () => import('./features/cases/case-editor.page').then((m) => m.CaseEditorPage),
        canDeactivate: [confirmLeave],
        title: title('New test case'),
      },
      {
        path: 'cases/import',
        loadComponent: () => import('./features/cases/import.page').then((m) => m.ImportPage),
        canDeactivate: [confirmLeave],
        title: title('Import'),
      },
      {
        path: 'cases/:number',
        loadComponent: () => import('./features/cases/case-detail.page').then((m) => m.CaseDetailPage),
        title: title('Test case'),
      },
      {
        path: 'cases/:number/edit',
        loadComponent: () => import('./features/cases/case-editor.page').then((m) => m.CaseEditorPage),
        canDeactivate: [confirmLeave],
        title: title('Edit test case'),
      },
      {
        path: 'inbox',
        loadComponent: () => import('./features/inbox/inbox.page').then((m) => m.InboxPage),
        title: title('Inbox'),
      },
      {
        path: 'review',
        loadComponent: () => import('./features/review/review.page').then((m) => m.ReviewPage),
        title: title('Review'),
      },
      {
        path: 'session',
        loadComponent: () => import('./features/runs/session.page').then((m) => m.SessionPage),
        title: title('Test session'),
      },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard.page').then((m) => m.DashboardPage),
        title: title('Dashboard'),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];

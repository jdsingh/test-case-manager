# AGENTS.md

Guidance for coding agents working on Test Case Manager.

## What it is

A static Angular single-page app that manages release test cases stored as GitHub Issues in a `<app>-testbank` repo. There is no backend: the browser calls `api.github.com` directly with the user's personal access token. The PRD (linked from README.md) is the source of truth for behaviour; requirement IDs like `TC-4` or `RV-2` in code comments refer to it.

## Stack and commands

- Angular 22 (standalone components, signals, zoneless), strict TypeScript, plain CSS (global design tokens in `src/styles.css`).
- Bun is the package manager, script runner and unit-test runner. The build itself is the Angular CLI (`@angular/build`), run under Bun.
- `bun run dev`, `bun run build`, `bun test`, `bun run typecheck`, `bun run e2e`.
- Run `bun run typecheck && bun test && bun run e2e` before calling a change done.

## Layout

- `src/app/core/` holds the framework-free logic plus the root services.
  - `github/client.ts`: the fetch wrapper. It maps HTTP and GraphQL failures to `GitHubError.kind` (`auth`, `forbidden`, `conflict` and others).
  - `github/api.ts`: one typed function per GraphQL operation. New GitHub calls go here.
  - `config/team-config.ts`: parses and validates `.testcases/config.json`, works out roles, and holds team edits (diff, apply, describe, serialize).
  - `config/labels.ts`: the label set the app relies on.
  - `config/save-config.ts`: commits the config, falling back to a pull request.
  - `session.ts` holds the token and viewer. `workspace.ts` holds the repo, config and roles. `feature-selection.ts` tracks the `?feature=` board.
  - `guards.ts`: auth, repo loading, the setup redirect and the role-based home.
- `src/app/features/` holds the pages: onboarding (connect, repos, setup), shell (header and banners), team (Team settings).
- `*.test.ts` files sit next to the code and run under `bun test`. Keep core logic free of Angular so it stays testable this way.
- `e2e/` has Playwright checks against the production build (with its CSP) and an in-memory GitHub mock (`mock-github.ts`). The mock matches operations by query text, so when you add a GraphQL operation, add a handler for it there too.

## Rules

- **Tokens.**
  - Never log, print or persist tokens anywhere except `TokenStore`.
  - The production CSP (`src/index.prod.html`) only allows connections to `api.github.com` and `uploads.github.com`. Don't add third-party scripts or hosts.
- **The config file.**
  - The app must keep keys it doesn't know about when it saves (`serializeConfig`).
  - Every write must be guarded by `expectedHeadOid`.
- **Roles.** Roles only shape the UI. GitHub's own permissions are the real gate, so never treat a role check as security.
- **The repo shell.** It keeps one `<router-outlet>` that is always mounted. Don't put the outlet inside `@if`/`@switch` branches that change during a background reload, because that recreates the page and loses its state.

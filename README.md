# Test Case Manager

A browser-only web app for managing a feature's release test plan in GitHub Issues. The PM writes Given/When/Then test cases, Android and iOS engineers review and run them with evidence, and the tech lead gets a ship-readiness dashboard. GitHub is the only backend: the app talks to GitHub's GraphQL API from the browser using each person's personal access token.

PRD: https://claude.ai/code/artifact/373ba379-81c7-4ac8-91b1-d1bbc013eb90

## Status

Milestone **M1 (foundations)** is built:

- Token onboarding with scope checks, sign out, and deep links that survive onboarding
- Repo picker (`*-testbank` repos first) and feature (Projects v2 board) picker
- One-click repo setup: creates the labels and `.testcases/config.json`
- Team configuration: roles from the config drive the home screen and permissions; unknown users get read-only mode; invalid config is reported
- Team settings screen: add/remove people per role with autocomplete, default reviewers, a change summary, conflict-safe saves, and a pull-request fallback for protected branches
- GitHub Pages deploy workflow

Milestone **M2 (test cases)** is built:

- Test case list for the selected feature board, with priority/status/platform/regression filters and search (kept in the URL), status counts, and keyboard shortcuts (`/` search, `N` new)
- Case detail: scenario, state, assignees, the latest change request, and the review history
- Given/When/Then editor with enforced step order, live preview, step autocomplete from existing cases, a "paste Gherkin" mode and a near-duplicate warning
- Create (optionally straight into review), edit (a scenario change on a reviewed case sends it back to review), submit/resubmit to a suggested reviewer, duplicate, close as won't test, reopen
- Import from a Google Sheets paste or a CSV file (auto-mapped columns, preview, duplicate and re-run detection, throttled creation with progress), or from pasted Gherkin with `@P0 @ios` tags
- Export the current list view to CSV

Milestone **M3 (review)** is built:

- Review mode: a queue of the in-review cases you can review, with `A` approve, `R` request changes, `J`/`K` next/previous
- Eligibility rules: Android or iOS engineers per the case's platforms; nobody approves a version they edited; one approval approves; reviews before a resubmit show as earlier versions
- Comments on a single step, with suggested wording the author accepts in one click
- Assignees follow the stage: reviewers while in review, one runner per platform once approved (fewest open cases first), the author on a change request; editable per platform
- Inbox of everything assigned to you across features, with the count in the nav, the tab title and the favicon

Still to come: execution and evidence (M4), the dashboard (M5), the regression bank and Claude Code skill (M6).

## Develop

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev        # http://localhost:4200
bun test           # unit tests (core logic)
bun run typecheck
bun run e2e        # production build + Playwright against a mocked GitHub
```

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, builds with the repo name as base href, and publishes to GitHub Pages. In the repo's settings, set **Pages → Source** to **GitHub Actions** once. Pages on a private repo needs a paid GitHub plan.

## Using it

1. Create a repo named `<app>-testbank` with at least one commit (e.g. a README).
2. Open the app, create a classic token with `repo` and `project` scopes (the app links to a pre-filled form), and paste it.
3. Pick the testbank repo and click **Set up repo**.
4. Add your team in **Team settings**.
5. Create a GitHub Project per feature and link it to the testbank repo.

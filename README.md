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

Milestone **M4 (execution and evidence)** is built:

- Record a run on the case page: result, app version, build, device, OS, environment, time, notes and evidence; details are remembered per platform
- Evidence (images, videos; HEIC converted where the browser can) is committed to the orphan `tcm-evidence` branch and embedded in the run comment; the app shows it through the API, so private repos work
- The latest run per platform on the feature's target version decides the result; status, `run:*` labels and runners follow (whoever passes a platform is unassigned)
- A failed run offers a prefilled bug, filed in `bugs.repo` (or the testbank repo) and linked from the case
- Test session mode for laptops: large tickable steps, `P`/`F`/`B` to record, `J`/`K` to move, `Space` to tick, drag/paste/watched-folder evidence, background uploads
- Bulk-assign Android and iOS runners from the list

Milestone **M5 (dashboard)** is built:

- One-line ship verdict with its reasons, from the configured blocking priorities (default P0) on the feature's target version; other failures shown as warnings
- Runs per platform (passed / failed / blocked / not run) and a burndown of runs still to do against an even pace to the release date
- Counts by priority and status; every cell opens the filtered list
- Failing and blocked cases with the latest run, its evidence and any linked bug
- What changed since your last visit, and a one-click Markdown readiness report for Slack or a release PR
- Target version and release date editable on the dashboard (saved to the config)

Milestone **M6 (regression bank, Claude Code skill, polish)** is built:

- Regression bank: mark cases as regression; **Add from bank** copies them into another feature (copies of approved cases start Approved and get runners); copies show **out of date** when the original changes, with one-click update
- `draft-test-cases` Claude Code skill, added to the testbank repo by setup (or from Team settings): clone the repo, run `claude`, and ask it to draft test cases from a spec; it creates them as Drafts in the app's format
- Cmd/Ctrl-K command palette to jump to any case, feature or action
- **Try with sample data** on the Connect screen: the whole app runs on an in-memory GitHub in the browser (nothing is sent anywhere), switchable between the four roles

All six PRD milestones are built.

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

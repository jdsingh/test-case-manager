// The Claude Code skill committed to the testbank repo (PRD 5.7, AI-1 to AI-5). It
// drafts test cases in the exact issue format the app reads, then creates them as Drafts.

export const SKILL_PATH = '.claude/skills/draft-test-cases/SKILL.md';

export const SKILL_MARKDOWN = `---
name: draft-test-cases
description: Draft Given/When/Then test cases for a feature in this testbank repo and create them as Draft GitHub issues that Test Case Manager can read. Use when someone asks to write, draft, generate or brainstorm test cases or test scenarios for a feature, a spec, a PRD, a ticket or a screen.
---

# Draft test cases

This repo is a **testbank**: every test case is a GitHub issue that Test Case Manager
(the web app) reads and writes. Your job is to draft good test cases with the person,
confirm them, and create them as **Drafts** so they go through the team's normal review.

Never approve, run, close or edit existing cases, and never edit \`.testcases/config.json\`.
Everything you create starts as a Draft.

## 1. Get set up

1. Read \`.testcases/config.json\`. It holds the team (\`team.pm\`, \`team.android\`,
   \`team.ios\`), the default feature board (\`project\`) and per-feature settings
   (\`features\`, keyed by project number).
2. Check the GitHub CLI works and can reach project boards:
   \`gh auth status\`. If the \`project\` scope is missing, ask the person to run
   \`gh auth refresh -h github.com -s project\` and wait.
3. Find the repo name: \`gh repo view --json nameWithOwner -q .nameWithOwner\`.
4. Ask which feature the cases are for, unless it's obvious. List the boards linked to
   this repo with:

   \`\`\`sh
   gh api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){projectsV2(first:20){nodes{number title closed}}}}' -F o=OWNER -F n=REPO
   \`\`\`

## 2. Understand the feature

Ask for, or read, whatever describes the feature: a spec or PRD (a file path or URL),
designs, a ticket, or just the person's description. Ask short follow-up questions when
the expected behaviour is unclear; don't guess at business rules.

## 3. Check what already exists

Before drafting, load the existing cases so you don't write duplicates:

\`\`\`sh
gh issue list --label testcase --state open --limit 500 --json number,title,labels
gh issue list --label testcase --label regression --state open --limit 200 --json number,title
\`\`\`

If a draft would duplicate an open case, say so instead of creating it. If a case in the
regression bank (label \`regression\`) already covers it, suggest reusing it: in the app,
**Test cases → Add from bank**.

## 4. Draft the scenarios

Write one behaviour per scenario. Cover, as the feature warrants:

- the main happy path(s);
- validation and error handling (bad input, server errors, empty states);
- edge cases (limits, zero/many items, long text, special characters);
- interruptions: network loss and recovery, app backgrounded or killed, low battery,
  incoming call;
- permissions (denied, later granted), first launch vs returning user, logged in vs out;
- platform specifics: Android back button and process death; iOS gestures, Face ID;
- accessibility (screen reader, largest text size), dark mode, localisation;
- deep links and notifications, if the feature has entry points.

Rules for every scenario:

- **Name**: a short, specific statement of the behaviour ("Expired card shows an inline
  error"), not a ticket title.
- **Steps** go strictly Given → When → Then. Use \`And\` for more steps of the same kind.
  At least one Given, one When and one Then.
- **Then** must be observable on the device: exact text, a screen, a state. Avoid
  vague outcomes like "it works" or "an error is shown"; say which error and where.
- Use concrete test data (amounts, names, cards) and put setup the tester needs in
  **Preconditions**.
- **Priority**: P0 = the feature can't ship if this fails (core flow, money, data loss,
  security); P1 = important, should block if broken for many users; P2 = normal;
  P3 = minor or cosmetic.
- **Platforms**: Android, iOS, or both. Use both unless the behaviour is platform-specific.

## 5. Confirm with the person

Show a numbered summary table (name, priority, platforms) and the full Gherkin for each
case. Ask which to create and what to change. Only create what they confirm.

## 6. Create the issues

For each confirmed case, write the body to a temporary file in **exactly** this format
(the app parses it; keep the marker line and the \`gherkin\` fence):

\`\`\`\`markdown
<!-- tcm:testcase v1 -->
**Priority:** P1 · **Platforms:** Android, iOS

**Preconditions:** Logged-in user with one item in the cart

\`\`\`gherkin
Scenario: Promo code updates the order total
  Given a cart totalling $50.00
    And promo code "SAVE10" is active
  When the user applies promo code "SAVE10"
  Then the total shows $45.00
    And a "-$5.00" discount line is shown
\`\`\`
\`\`\`\`

- Omit the \`**Preconditions:**\` paragraph when there are none.
- Platforms are written \`Android\`, \`iOS\` or \`Android, iOS\`.
- Indent \`Given\`/\`When\`/\`Then\` by two spaces and \`And\` by four.

Then create the issue and add it to the feature's board:

\`\`\`sh
gh issue create --title "[TC] Promo code updates the order total" --body-file /tmp/tc-1.md \\
  --label testcase --label priority:P1 --label platform:android --label platform:ios \\
  --label status:draft --assignee @me
gh project item-add PROJECT_NUMBER --owner PROJECT_OWNER --url ISSUE_URL
\`\`\`

- The title is always \`[TC] \` followed by the scenario name.
- Use one \`platform:\` label per platform, matching the body.
- \`PROJECT_OWNER\` is the board's owner (the org or user in the board's URL).
- Create cases one at a time, a second apart, so GitHub doesn't rate-limit you.

## 7. Report back

List what you created with links, and remind the person that the cases are Drafts:
they can review and submit them for review in Test Case Manager (**Test cases** list).
`;

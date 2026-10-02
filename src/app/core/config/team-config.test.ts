import { describe, expect, test } from 'bun:test';
import {
  applyChanges,
  commitHeadline,
  describeChanges,
  diffDrafts,
  draftFrom,
  homeFor,
  newConfigText,
  parseConfig,
  rolesFor,
  serializeConfig,
  TeamConfig,
} from './team-config';

const SAMPLE = {
  $schema: 'https://example.github.io/tcm/config.schema.json',
  version: 1,
  team: {
    pm: ['priya-pm'],
    techLead: ['alex-lead'],
    android: ['sam-android', 'lee-android'],
    ios: ['jo-ios'],
  },
  project: { owner: 'acme', number: 7 },
  features: { '7': { targetVersion: '4.12.0', releaseDate: '2026-11-10' } },
  readiness: { blockingPriorities: ['P0'] },
  assignment: { defaultReviewer: { android: 'sam-android', ios: 'jo-ios' } },
  customKey: { kept: true },
};

function parsed(raw: unknown = SAMPLE) {
  const r = parseConfig(JSON.stringify(raw));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
}

describe('parseConfig', () => {
  test('parses the PRD example', () => {
    const { config, warnings } = parsed();
    expect(config.team.android).toEqual(['sam-android', 'lee-android']);
    expect(config.project).toEqual({ owner: 'acme', number: 7 });
    expect(config.features['7']).toEqual({ targetVersion: '4.12.0', releaseDate: '2026-11-10' });
    expect(config.assignment.defaultReviewer).toEqual({ android: 'sam-android', ios: 'jo-ios' });
    expect(warnings).toEqual([]);
  });

  test('missing roles default to empty and blocking priorities default to P0', () => {
    const { config } = parsed({ version: 1, team: { pm: ['a'] } });
    expect(config.team).toEqual({ pm: ['a'], techLead: [], android: [], ios: [] });
    expect(config.readiness.blockingPriorities).toEqual(['P0']);
  });

  test('reports invalid JSON', () => {
    const r = parseConfig('{ "version": 1, ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toStartWith('Not valid JSON');
  });

  test('reports bad usernames, versions and dates together', () => {
    const r = parseConfig(
      JSON.stringify({
        version: 2,
        team: { pm: ['not a login'] },
        features: { '7': { releaseDate: 'next week' } },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('"version" must be 1.');
      expect(r.errors.some((e) => e.includes('"not a login"'))).toBe(true);
      expect(r.errors.some((e) => e.includes('releaseDate'))).toBe(true);
    }
  });

  test('warns about unknown roles and default reviewers not on the team', () => {
    const { warnings, config } = parsed({
      version: 1,
      team: { android: ['sam'], qa: ['x'] },
      assignment: { defaultReviewer: { android: 'someone-else' } },
    });
    expect(warnings).toHaveLength(2);
    expect(config.assignment.defaultReviewer).toEqual({});
  });

  test('dedupes logins case-insensitively', () => {
    const { config } = parsed({ version: 1, team: { ios: ['Jo', 'jo'] } });
    expect(config.team.ios).toEqual(['Jo']);
  });
});

describe('roles', () => {
  const { config } = parsed();

  test('match logins case-insensitively', () => {
    expect(rolesFor(config, 'Sam-Android')).toEqual(['android']);
    expect(rolesFor(config, 'stranger')).toEqual([]);
  });

  test('a person can hold several roles', () => {
    const c: TeamConfig = { ...config, team: { ...config.team, techLead: ['priya-pm'] } };
    expect(rolesFor(c, 'priya-pm')).toEqual(['pm', 'techLead']);
  });

  test('home screen by role', () => {
    expect(homeFor(['pm'])).toBe('cases');
    expect(homeFor(['techLead'])).toBe('dashboard');
    expect(homeFor(['ios'])).toBe('inbox');
    expect(homeFor([])).toBe('dashboard');
  });
});

describe('team edits', () => {
  const { config, raw } = parsed();

  test('diff, describe and commit headline', () => {
    const before = draftFrom(config);
    const after = applyChanges(before, [
      { op: 'add', role: 'android', login: 'kim-android' },
      { op: 'remove', role: 'ios', login: 'jo-ios' },
    ]);
    const changes = diffDrafts(before, after);
    // Removing jo-ios also clears the iOS default reviewer.
    expect(changes).toEqual([
      { op: 'add', role: 'android', login: 'kim-android' },
      { op: 'remove', role: 'ios', login: 'jo-ios' },
      { op: 'setDefaultReviewer', platform: 'ios', login: null },
    ]);
    expect(describeChanges(changes)).toBe(
      'Add kim-android to Android engineers, remove jo-ios from iOS engineers, clear default iOS reviewer',
    );
    expect(commitHeadline(changes.slice(0, 1))).toBe('Update team config: add kim-android to android');
    expect(commitHeadline(changes)).toBe('Update team config: 3 changes');
  });

  test('adding someone already present is a no-op', () => {
    const d = draftFrom(config);
    expect(applyChanges(d, [{ op: 'add', role: 'pm', login: 'PRIYA-PM' }]).team.pm).toEqual(['priya-pm']);
  });

  test("re-applies a user's edits on top of someone else's save", () => {
    const mine = diffDrafts(
      draftFrom(config),
      applyChanges(draftFrom(config), [{ op: 'add', role: 'ios', login: 'max-ios' }]),
    );
    // Meanwhile someone else removed lee-android.
    const theirs = applyChanges(draftFrom(config), [{ op: 'remove', role: 'android', login: 'lee-android' }]);
    const merged = applyChanges(theirs, mine);
    expect(merged.team.ios).toEqual(['jo-ios', 'max-ios']);
    expect(merged.team.android).toEqual(['sam-android']);
  });

  test('serialize keeps unknown keys and round-trips', () => {
    const d = applyChanges(draftFrom(config), [{ op: 'add', role: 'pm', login: 'new-pm' }]);
    const text = serializeConfig(raw, d);
    expect(text.endsWith('\n')).toBe(true);
    const back = JSON.parse(text);
    expect(back.customKey).toEqual({ kept: true });
    expect(back.$schema).toBe(SAMPLE.$schema);
    expect(back.team.pm).toEqual(['priya-pm', 'new-pm']);
    const again = parseConfig(text);
    expect(again.ok).toBe(true);
  });

  test('serialize drops an empty assignment block', () => {
    const d = draftFrom(config);
    d.defaultReviewer = {};
    const back = JSON.parse(serializeConfig({ version: 1, team: {}, assignment: { defaultReviewer: {} } }, d));
    expect(back.assignment).toBeUndefined();
  });

  test('new config puts the creator in their roles and is valid', () => {
    const text = newConfigText('https://x/config.schema.json', 'priya-pm', ['pm', 'techLead']);
    const r = parseConfig(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(rolesFor(r.config, 'priya-pm')).toEqual(['pm', 'techLead']);
  });
});

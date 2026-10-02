// .testcases/config.json: parsing, validation, roles and team edits (PRD 5.1a).
// Framework-free so it can be unit-tested with `bun test`.

export const ROLES = ['pm', 'techLead', 'android', 'ios'] as const;
export type Role = (typeof ROLES)[number];
export type Platform = 'android' | 'ios';
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  pm: 'PM',
  techLead: 'Tech lead',
  android: 'Android engineers',
  ios: 'iOS engineers',
};

export type Team = Record<Role, string[]>;
export type DefaultReviewers = Partial<Record<Platform, string>>;

export interface FeatureSettings {
  targetVersion?: string;
  releaseDate?: string;
}

export interface TeamConfig {
  version: 1;
  team: Team;
  project?: { owner: string; number: number };
  features: Record<string, FeatureSettings>;
  readiness: { blockingPriorities: Priority[] };
  assignment: { defaultReviewer: DefaultReviewers };
}

export type ParseResult =
  | { ok: true; config: TeamConfig; raw: Record<string, unknown>; warnings: string[] }
  | { ok: false; errors: string[] };

const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidLogin(login: string): boolean {
  return LOGIN_RE.test(login);
}

export function parseConfig(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  if (!isObject(raw)) return { ok: false, errors: ['The file must contain a JSON object.'] };

  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw['version'] !== 1) errors.push('"version" must be 1.');

  const team = { pm: [], techLead: [], android: [], ios: [] } as Team;
  const rawTeam = raw['team'];
  if (!isObject(rawTeam)) {
    errors.push('"team" must be an object mapping roles to lists of GitHub usernames.');
  } else {
    for (const key of Object.keys(rawTeam)) {
      if (!(ROLES as readonly string[]).includes(key)) {
        warnings.push(`Unknown role "${key}" in "team" is ignored.`);
      }
    }
    for (const role of ROLES) {
      const list = rawTeam[role];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
        errors.push(`"team.${role}" must be a list of GitHub usernames.`);
        continue;
      }
      for (const login of list) {
        if (!isValidLogin(login)) errors.push(`"${login}" in "team.${role}" is not a valid GitHub username.`);
      }
      team[role] = dedupe(list.filter(isValidLogin));
    }
  }

  let project: TeamConfig['project'];
  const rawProject = raw['project'];
  if (rawProject !== undefined) {
    if (isObject(rawProject) && typeof rawProject['owner'] === 'string' && Number.isInteger(rawProject['number'])) {
      project = { owner: rawProject['owner'], number: rawProject['number'] as number };
    } else {
      errors.push('"project" must look like { "owner": "acme", "number": 7 }.');
    }
  }

  const features: Record<string, FeatureSettings> = {};
  const rawFeatures = raw['features'];
  if (rawFeatures !== undefined) {
    if (!isObject(rawFeatures)) {
      errors.push('"features" must be an object keyed by project number.');
    } else {
      for (const [key, value] of Object.entries(rawFeatures)) {
        if (!/^\d+$/.test(key)) errors.push(`"features" key "${key}" must be a project number.`);
        if (!isObject(value)) {
          errors.push(`"features.${key}" must be an object.`);
          continue;
        }
        const f: FeatureSettings = {};
        if (value['targetVersion'] !== undefined) {
          if (typeof value['targetVersion'] === 'string') f.targetVersion = value['targetVersion'];
          else errors.push(`"features.${key}.targetVersion" must be a string like "4.12.0".`);
        }
        if (value['releaseDate'] !== undefined) {
          if (typeof value['releaseDate'] === 'string' && DATE_RE.test(value['releaseDate'])) {
            f.releaseDate = value['releaseDate'];
          } else errors.push(`"features.${key}.releaseDate" must be a date like "2026-11-10".`);
        }
        features[key] = f;
      }
    }
  }

  let blockingPriorities: Priority[] = ['P0'];
  const rawReadiness = raw['readiness'];
  if (rawReadiness !== undefined) {
    const bp = isObject(rawReadiness) ? rawReadiness['blockingPriorities'] : undefined;
    if (Array.isArray(bp) && bp.every((p) => (PRIORITIES as readonly unknown[]).includes(p))) {
      blockingPriorities = bp as Priority[];
    } else {
      errors.push('"readiness.blockingPriorities" must be a list drawn from "P0", "P1", "P2", "P3".');
    }
  }

  const defaultReviewer: DefaultReviewers = {};
  const rawAssignment = raw['assignment'];
  if (rawAssignment !== undefined) {
    const dr = isObject(rawAssignment) ? rawAssignment['defaultReviewer'] : undefined;
    if (dr !== undefined && !isObject(dr)) {
      errors.push('"assignment.defaultReviewer" must be an object like { "android": "sam" }.');
    } else if (dr) {
      for (const platform of ['android', 'ios'] as const) {
        const login = dr[platform];
        if (login === undefined) continue;
        if (typeof login !== 'string' || !isValidLogin(login)) {
          errors.push(`"assignment.defaultReviewer.${platform}" must be a GitHub username.`);
        } else if (!includesLogin(team[platform], login)) {
          warnings.push(`Default ${platform} reviewer "${login}" is not in "team.${platform}" and is ignored.`);
        } else {
          defaultReviewer[platform] = login;
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    raw,
    warnings,
    config: {
      version: 1,
      team,
      project,
      features,
      readiness: { blockingPriorities },
      assignment: { defaultReviewer },
    },
  };
}

export function rolesFor(config: TeamConfig, login: string): Role[] {
  return ROLES.filter((role) => includesLogin(config.team[role], login));
}

export type HomeView = 'cases' | 'inbox' | 'dashboard';

/** The landing screen for a set of roles (TC-2). Viewers get the read-only dashboard. */
export function homeFor(roles: Role[]): HomeView {
  if (roles.includes('pm')) return 'cases';
  if (roles.includes('techLead')) return 'dashboard';
  if (roles.includes('android') || roles.includes('ios')) return 'inbox';
  return 'dashboard';
}

export function platformsFor(roles: Role[]): Platform[] {
  return (['android', 'ios'] as const).filter((p) => roles.includes(p));
}

/** Only the PM and tech lead get an editable Team settings screen (TC-4). */
export function canEditTeam(roles: Role[]): boolean {
  return roles.includes('pm') || roles.includes('techLead');
}

export function allLogins(team: Team): string[] {
  return dedupe(ROLES.flatMap((r) => team[r]));
}

// ---- Team edits -------------------------------------------------------------

/** The editable part of the config, as held by the Team settings screen. */
export interface TeamDraft {
  team: Team;
  defaultReviewer: DefaultReviewers;
}

export type TeamChange =
  | { op: 'add' | 'remove'; role: Role; login: string }
  | { op: 'setDefaultReviewer'; platform: Platform; login: string | null };

export function draftFrom(config: TeamConfig): TeamDraft {
  return {
    team: cloneTeam(config.team),
    defaultReviewer: { ...config.assignment.defaultReviewer },
  };
}

export function diffDrafts(before: TeamDraft, after: TeamDraft): TeamChange[] {
  const changes: TeamChange[] = [];
  for (const role of ROLES) {
    for (const login of after.team[role]) {
      if (!includesLogin(before.team[role], login)) changes.push({ op: 'add', role, login });
    }
    for (const login of before.team[role]) {
      if (!includesLogin(after.team[role], login)) changes.push({ op: 'remove', role, login });
    }
  }
  for (const platform of ['android', 'ios'] as const) {
    const a = before.defaultReviewer[platform] ?? null;
    const b = after.defaultReviewer[platform] ?? null;
    if ((a ?? '').toLowerCase() !== (b ?? '').toLowerCase()) {
      changes.push({ op: 'setDefaultReviewer', platform, login: b });
    }
  }
  return changes;
}

/**
 * Applies changes to a (possibly newer) draft. Used to re-apply a user's edits on top
 * of a config someone else saved in the meantime (Team settings, step 5).
 */
export function applyChanges(draft: TeamDraft, changes: TeamChange[]): TeamDraft {
  const next: TeamDraft = { team: cloneTeam(draft.team), defaultReviewer: { ...draft.defaultReviewer } };
  for (const c of changes) {
    if (c.op === 'add') {
      if (!includesLogin(next.team[c.role], c.login)) next.team[c.role].push(c.login);
    } else if (c.op === 'remove') {
      next.team[c.role] = next.team[c.role].filter((l) => !sameLogin(l, c.login));
    } else if (c.op === 'setDefaultReviewer') {
      if (c.login === null) delete next.defaultReviewer[c.platform];
      else next.defaultReviewer[c.platform] = c.login;
    }
  }
  // A default reviewer must still be on that platform's team.
  for (const platform of ['android', 'ios'] as const) {
    const login = next.defaultReviewer[platform];
    if (login && !includesLogin(next.team[platform], login)) delete next.defaultReviewer[platform];
  }
  return next;
}

const PLATFORM_NAMES: Record<Platform, string> = { android: 'Android', ios: 'iOS' };

/** Human summary, e.g. "Add lee-android to Android engineers, remove kim-ios from iOS engineers". */
export function describeChanges(changes: TeamChange[]): string {
  const parts = changes.map((c) => {
    if (c.op === 'add') return `add ${c.login} to ${ROLE_LABELS[c.role]}`;
    if (c.op === 'remove') return `remove ${c.login} from ${ROLE_LABELS[c.role]}`;
    if (c.op !== 'setDefaultReviewer') return '';
    return c.login
      ? `set default ${PLATFORM_NAMES[c.platform]} reviewer to ${c.login}`
      : `clear default ${PLATFORM_NAMES[c.platform]} reviewer`;
  });
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Commit headline, e.g. "Update team config: add lee-android to android". */
export function commitHeadline(changes: TeamChange[]): string {
  const parts = changes.map((c) => {
    if (c.op === 'add') return `add ${c.login} to ${c.role}`;
    if (c.op === 'remove') return `remove ${c.login} from ${c.role}`;
    if (c.op !== 'setDefaultReviewer') return '';
    return c.login ? `default ${c.platform} reviewer ${c.login}` : `clear default ${c.platform} reviewer`;
  });
  const headline = `Update team config: ${parts.join(', ')}`;
  return headline.length <= 72 ? headline : `Update team config: ${changes.length} changes`;
}

/**
 * Writes the draft back into the raw config object, keeping any keys the app doesn't
 * know about, and returns the file contents.
 */
export function serializeConfig(raw: Record<string, unknown>, draft: TeamDraft): string {
  const out: Record<string, unknown> = { ...raw };
  out['team'] = cloneTeam(draft.team);
  const assignment = isObject(raw['assignment']) ? { ...raw['assignment'] } : {};
  const defaultReviewer = { ...draft.defaultReviewer };
  if (Object.keys(defaultReviewer).length) assignment['defaultReviewer'] = defaultReviewer;
  else delete assignment['defaultReviewer'];
  if (Object.keys(assignment).length) out['assignment'] = assignment;
  else delete out['assignment'];
  return JSON.stringify(out, null, 2) + '\n';
}

export function newConfigText(schemaUrl: string, login: string, roles: Role[]): string {
  const team: Team = { pm: [], techLead: [], android: [], ios: [] };
  for (const role of roles) team[role].push(login);
  const raw: Record<string, unknown> = {
    $schema: schemaUrl,
    version: 1,
    team,
    features: {},
    readiness: { blockingPriorities: ['P0'] },
  };
  return JSON.stringify(raw, null, 2) + '\n';
}

// ---- helpers ----------------------------------------------------------------

export function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function includesLogin(list: string[], login: string): boolean {
  return list.some((l) => sameLogin(l, login));
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((l) => {
    const k = l.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cloneTeam(team: Team): Team {
  return { pm: [...team.pm], techLead: [...team.techLead], android: [...team.android], ios: [...team.ios] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

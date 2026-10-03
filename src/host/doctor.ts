/**
 * `doctor` — the read-only answer to "is the provider on or off on THIS
 * machine" (PITFALLS §22: the effective switch lives in a JSON file that no
 * config file and no Host route ever reported).
 *
 * A plain reader over the plugin's own state files — it imports no Host peer,
 * so it runs on a clean checkout and answers from disk even when no Host is
 * running. It reports what is ON DISK, nothing more: where a row has no state
 * file it prints "unset (deployment default rules)" instead of guessing, and
 * it never reads `cordis.patch.yml` — so "effective" here means "the
 * panel-saved override, when one exists", not the merged configuration.
 * Never secrets.
 *
 * @module dsh-connect-sensenova-token-plan/doctor
 */
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { isProfileSegment, dshHome as defaultDshHome } from "./state-store.ts";
import { PROVIDER_VERSION, normalizeEnabled } from "./provider-store.ts";
import { DRAW_STORE_VERSION, normalizeDrawEnabled, normalizeDrawModelId } from "./draw-store.ts";
import { CATALOG_VERSION, normalizeEntries, normalizeEnabledIds } from "./catalog-store.ts";
import { SYMPTOM, hintFor, type SymptomValue } from "./codes.ts";

/** A scope whose state the doctor reported on (a profile name, or "" for shared). */
export interface DoctorScope {
  profile: string | null;
  stateDir: string;
  /** `registerProvider` the panel saved; `null` = fall back to the deployment default. */
  providerPanel: boolean | null;
  /** The saved draw-tool switch; `null` = fall back to the deployment default. */
  drawPanel: boolean | null;
  /** The saved draw-model preference; `null` = auto. */
  drawModelPanel: string | null;
  /** Stored catalog entries, `[]` when nothing usable is stored. */
  catalogEntries: object[];
  /** The stored model allow-list; `[]` means "no filter". */
  catalogEnabledIds: string[];
  /** When the catalog was fetched (ms), or 0 when unknown. */
  catalogFetchedAt: number;
  /** The state file could not be read as this plugin's payload. */
  unreadable: string[];
}

/** The full doctor report: one entry per state scope, plus the shared layout. */
export interface DoctorReport {
  /** The DSH home the report was read from. */
  dshHome: string;
  /** The plugin state directory name. */
  plugin: string;
  /**
   * One entry per profile found, in read order. The shared (pre-profile) layout
   * is its own field ({@link DoctorReport.shared}), not an entry here.
   */
  scopes: DoctorScope[];
  /** The shared (pre-profile-segment) state directory, present when in use. */
  shared: DoctorScope | null;
  /** Whether a profile-scoped layout existed at all (false = pre-§23 shared-only machine). */
  profiled: boolean;
  /**
   * Symptom ids this machine's state matches, with the first move for each.
   *
   * The point of the field: `doctor` answers from DISK, while most reported
   * problems ("额度那栏一直是空的") are things a human SEES on the panel. Naming
   * the symptom and pointing at `docs/TROUBLESHOOTING.md` closes the loop
   * between the two — an operator (or an agent) runs one read-only command and
   * gets told which page answers what they are seeing. Ids come from `SYMPTOM`
   * in `codes.ts`, the single declaration; the page and the declaration are
   * pinned together by `test/doctor.test.mjs`.
   */
  symptoms: { id: SymptomValue; hint: string }[];
}

/** Read a state JSON, or `null` when absent / unreadable / not JSON. */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Whether a path exists (any kind). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parse one stored provider switch, or `null` when absent / corrupt / foreign version. */
export function parseProviderPayload(raw: unknown): { enabled: boolean | null } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (source.version !== PROVIDER_VERSION) return null;
  return { enabled: normalizeEnabled(source.enabled) };
}

/** Parse one stored draw switch + model preference, or `null` on a bad payload. */
export function parseDrawPayload(raw: unknown): { enabled: boolean | null; modelId: string | null } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (source.version !== DRAW_STORE_VERSION) return null;
  return { enabled: normalizeDrawEnabled(source.enabled), modelId: normalizeDrawModelId(source.drawModelId) };
}

/** Parse one stored catalog record, or `null` when absent / corrupt / foreign version. */
export function parseCatalogPayload(raw: unknown): { fetchedAt: number; entries: object[]; enabledModelIds: string[] } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.version !== "number" || source.version !== CATALOG_VERSION) return null;
  const fetchedAt = typeof source.fetchedAt === "number" && source.fetchedAt > 0 ? source.fetchedAt : 0;
  const entries = normalizeEntries(source.entries);
  const enabledModelIds = normalizeEnabledIds(source.enabledModelIds);
  if (fetchedAt <= 0 && entries.length === 0) return null;
  return { fetchedAt, entries, enabledModelIds };
}

/**
 * Read one state directory into a scope, tolerant of a missing directory.
 * A directory that is absent or unreadable yields an all-empty scope; a file
 * that exists but is not this plugin's payload is named in `unreadable`.
 * @param {string} stateDir - the directory to read.
 * @param {string|null} profile - the profile this scope belongs to ("" = shared).
 * @returns {Promise<DoctorScope>} the populated scope.
 */
async function readScope(stateDir: string, profile: string | null): Promise<DoctorScope> {
  // The literal's own shape would pin every null/[] field to `null`/`never[]`
  // (initializer-typed, see the tsconfig note); annotate against the exported
  // contract this function is documented to fill.
  const scope: DoctorScope = {
    profile: profile === "" ? null : profile,
    stateDir,
    providerPanel: null,
    drawPanel: null,
    drawModelPanel: null,
    catalogEntries: [],
    catalogEnabledIds: [],
    catalogFetchedAt: 0,
    unreadable: []
  };
  // Distinguish "file absent" from "file present but not this plugin's
  // payload": only the latter is named in `unreadable`, so a machine that has
  // never toggled a switch reports nothing, while a corrupt or foreign file
  // is called out by name (the §22 question: "is this file even ours?").
  const present = async (file: string): Promise<boolean> => {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  };

  const providerFile = join(stateDir, "provider.json");
  if (await present(providerFile)) {
    const parsed = parseProviderPayload(await readJson(providerFile));
    if (parsed !== null) scope.providerPanel = parsed.enabled;
    else scope.unreadable.push("provider.json");
  }
  const drawFile = join(stateDir, "draw.json");
  if (await present(drawFile)) {
    const parsed = parseDrawPayload(await readJson(drawFile));
    if (parsed !== null) {
      scope.drawPanel = parsed.enabled;
      scope.drawModelPanel = parsed.modelId;
    } else scope.unreadable.push("draw.json");
  }
  const catalogFile = join(stateDir, "catalog.json");
  if (await present(catalogFile)) {
    const parsed = parseCatalogPayload(await readJson(catalogFile));
    if (parsed !== null) {
      scope.catalogEntries = parsed.entries;
      scope.catalogEnabledIds = parsed.enabledModelIds;
      scope.catalogFetchedAt = parsed.fetchedAt;
    } else scope.unreadable.push("catalog.json");
  }
  return scope;
}

/** List the profile-segment names under a `$DSH_HOME/state` directory. */
async function listProfiles(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(stateRoot);
    const profiles: string[] = [];
    for (const entry of entries) {
      // The shared (pre-§23) layout lives at `state/<plugin>/`; that directory
      // is a PLUGIN, not a profile, so it must not be read back as one.
      if (entry === name) continue;
      if (!isProfileSegment(entry)) continue;
      const abs = join(stateRoot, entry);
      if (!(await stat(abs)).isDirectory()) continue;
      // A directory here is only a PROFILE if it contains THIS plugin's state.
      //
      // `$DSH_HOME/state/` is shared by every installed plugin, so a sibling
      // bundle's flat directory (`state/dsh-connect-agnes-token-plan/`) also
      // passes `isProfileSegment` — it is a legal single path segment. Reading
      // it as a profile made doctor print another plugin's switches under a
      // profile name, parsed by the WRONG parser, on a machine with both
      // plugins installed. The shape that identifies a profile is the nesting:
      // `state/<profile>/<plugin>/`. A sibling plugin's flat directory has no
      // such child and is skipped.
      if (!(await exists(join(abs, name)))) continue;
      profiles.push(entry);
    }
    return profiles;
  } catch {
    return [];
  }
}

/**
 * Derive the symptom ids this state layout matches.
 *
 * Only what DISK can prove is reported — deliberately narrow, because a
 * symptom doctor cannot see (a panel showing stale numbers, a peer that failed
 * to load) would be a guess, and a guess printed as a fact is worse than no
 * line at all. The rule each entry follows: the state file is present, and
 * what it says is the surprising half of a situation the user would otherwise
 * have to infer.
 *
 *   `state-unreadable` — a file exists but is not this build's payload. That
 *     is the ADR-006 guard's territory: the file was written by another
 *     version, so the value on screen and the value on disk cannot be trusted
 *     to agree, and the fix is in TROUBLESHOOTING C2.
 *
 *   `provider-missing` — the provider switch is explicitly OFF on disk. Not a
 *     malfunction: the default is off, so an operator who never ticked it sees
 *     no models and has no way to tell "off by default" from "broken". Naming
 *     it turns the most common false alarm into a one-line answer.
 *
 *   `tool-or-model-missing` — draw is on yet no model was ever chosen AND no
 *     catalog was stored, i.e. the tool has nothing to call. (Draw tools mount
 *     only on the NEXT Host start, so "on" here says nothing about whether the
 *     agent has it — that half is in TROUBLESHOOTING B3.)
 *
 *   `quota-empty` — the catalog is absent or empty while a switch is on: the
 *     key was stored but the model list never arrived, which is what "额度那栏
 *     一直是空的" usually turns out to be when credentials are fine.
 *
 * A clean machine reports NONE of these — an empty array is the honest answer
 * for "nothing on disk to worry about", and it is also what a scripted check
 * should assert on.
 * @param {DoctorScope[]} scopes - every scope the report covers.
 * @returns {Array<{id: SymptomValue, hint: string}>} ids, de-duplicated, in
 *   declaration order.
 */
export function deriveSymptoms(scopes: DoctorScope[]): { id: SymptomValue; hint: string }[] {
  const found = new Set<SymptomValue>();
  for (const scope of scopes) {
    if (scope.unreadable.length > 0) found.add(SYMPTOM.STATE_UNREADABLE);
    if (scope.providerPanel === false) found.add(SYMPTOM.PROVIDER_MISSING);
    if (scope.drawPanel === true && scope.drawModelPanel === null && scope.catalogEntries.length === 0) {
      found.add(SYMPTOM.TOOL_OR_MODEL_MISSING);
    }
    if (scope.catalogEntries.length === 0 && (scope.providerPanel === true || scope.drawPanel === true)) {
      found.add(SYMPTOM.QUOTA_EMPTY);
    }
  }
  // Declaration order (the VALUES of the frozen SYMPTOM), not discovery order:
  // two runs of the same machine must produce the same array.
  //
  // `hintFor` is a total function on purpose: indexing `SYMPTOM_HINT` directly
  // types the result as `string | undefined` (an index signature cannot promise
  // every key is present), and `strictNullChecks` then refuses the assignment.
  // The fix is not a `!` or a cast — it is a lookup whose RETURN type is
  // `string`, so a missing entry is impossible to represent and a new id
  // without a hint fails to compile.
  return symptomIds()
    .filter((id) => found.has(id))
    .map((id) => ({ id, hint: hintFor(id) }));
}

/**
 * Every symptom id, in declaration order.
 *
 * `Object.values(SYMPTOM)`, named — because the IDS are the values, not the
 * keys: a caller that iterates `Object.keys` gets `QUOTA_EMPTY` where the wire
 * and the documentation both spell `quota-empty`, and every lookup built on it
 * silently misses.
 * @returns {SymptomValue[]} the declared ids, declaration order.
 */
export function symptomIds(): SymptomValue[] {
  return Object.values(SYMPTOM);
}

/**
 * Diagnose one DSH home: read every profile's state directory plus the shared
 * layout, and answer which switch / model list is in effect from disk.
 * A directory that does not exist answers as "no state here" (null scope),
 * so a clean machine is distinguished from a machine with an all-empty one.
 * @param {object} [options]
 * @param {string} [options.dshHome] - the DSH home to read; defaults to `~/.dsh` (or `$DSH_HOME`).
 * @returns {Promise<DoctorReport>}
 */
export async function diagnose(options: { dshHome?: string } = {}) {
  const home = typeof options.dshHome === "string" && options.dshHome !== "" ? options.dshHome : defaultDshHome();
  const stateRoot = join(home, "state");
  const sharedDir = join(stateRoot, name);
  const profiles = await listProfiles(stateRoot);
  const dirExists = async (dir: string): Promise<boolean> => {
    try {
      return (await stat(dir)).isDirectory();
    } catch {
      return false;
    }
  };
  const sharedScope = profiles.length === 0 && (await dirExists(sharedDir)) ? await readScope(sharedDir, "") : null;
  const profileScopes = await Promise.all(profiles.map((profile) => readScope(join(stateRoot, profile, name), profile)));
  const allScopes = sharedScope === null ? profileScopes : [sharedScope, ...profileScopes];
  return {
    dshHome: home,
    plugin: name,
    scopes: profileScopes,
    shared: sharedScope,
    profiled: profiles.length > 0,
    symptoms: deriveSymptoms(allScopes)
  };
}

/** Render a report as human-readable lines (the non-`--json` doctor output). */
export function renderReport(report: DoctorReport): string {
  const lines = [`dshHome: ${report.dshHome}`];
  const scopes = report.shared !== null ? [report.shared, ...report.scopes] : report.scopes;
  if (scopes.length === 0) {
    lines.push(`no state found under ${join(report.dshHome, "state", report.plugin)} (a clean machine, or one that has never toggled a switch)`);
  }
  for (const scope of scopes) {
    const label = scope.profile === null ? "shared" : scope.profile;
    const provider = scope.providerPanel === null ? "unset (deployment default rules)" : String(scope.providerPanel);
    const draw = scope.drawPanel === null ? "unset (deployment default rules)" : String(scope.drawPanel);
    const modelPart = scope.drawModelPanel !== null ? ` model=${scope.drawModelPanel}` : "";
    const enabledPart = scope.catalogEnabledIds.length === 0 ? "(no filter)" : String(scope.catalogEnabledIds.length);
    lines.push(
      `${label}: provider=${provider} draw=${draw}${modelPart} catalog=${scope.catalogEntries.length} enabled=${enabledPart}`
    );
    if (scope.unreadable.length > 0) lines.push(`${label}: unreadable state: ${scope.unreadable.join(", ")}`);
  }
  // Symptoms last: they are what a reader acts on, and each line says where
  // the full answer lives. A clean machine prints none, and says so — silence
  // here means "nothing on disk to worry about", not "the check did not run".
  if (report.symptoms.length === 0) {
    lines.push("symptoms: none (nothing on disk that needs explaining)");
  } else {
    lines.push(`symptoms (see docs/TROUBLESHOOTING.md): ${report.symptoms.map((s) => s.id).join(", ")}`);
    for (const symptom of report.symptoms) lines.push(`  ${symptom.id}: ${symptom.hint}`);
  }
  return lines.join("\n");
}

/** `--json` entry: print a stable report object. */
export async function main(argv = process.argv.slice(2)) {
  const report = await diagnose();
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  return report;
}

/**
 * `doctor` — the read-only answer to "is the provider on or off on THIS
 * machine" (PITFALLS §22: the effective switch lives in a JSON file that no
 * config file and no Host route ever reported).
 *
 * A plain reader over the plugin's own state files — it imports no Host peer,
 * so it runs on a clean checkout and answers from disk even when no Host is
 * running. It reports EFFECTIVE values ("panel-saved value beats the
 * deployment default"), never secrets.
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
  /** One entry per profile found (plus a "" shared entry when the shared layout was used). */
  scopes: DoctorScope[];
  /** The shared (pre-profile-segment) state directory, present when in use. */
  shared: DoctorScope | null;
  /** Whether a profile-scoped layout existed at all (false = pre-§23 shared-only machine). */
  profiled: boolean;
}

/** Read a state JSON, or `null` when absent / unreadable / not JSON. */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Parse one stored provider switch, or `null` when absent / corrupt / foreign version. */
export function parseProviderPayload(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  if (source.version !== PROVIDER_VERSION) return null;
  return { enabled: normalizeEnabled(source.enabled) };
}

/** Parse one stored draw switch + model preference, or `null` on a bad payload. */
export function parseDrawPayload(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  if (source.version !== DRAW_STORE_VERSION) return null;
  return { enabled: normalizeDrawEnabled(source.enabled), modelId: normalizeDrawModelId(source.drawModelId) };
}

/** Parse one stored catalog record, or `null` when absent / corrupt / foreign version. */
export function parseCatalogPayload(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
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
async function readScope(stateDir, profile) {
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
  const present = async (file) => {
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
async function listProfiles(stateRoot) {
  try {
    const entries = await readdir(stateRoot);
    const profiles: string[] = [];
    for (const entry of entries) {
      // The shared (pre-§23) layout lives at `state/<plugin>/`; that directory
      // is a PLUGIN, not a profile, so it must not be read back as one.
      if (entry === name) continue;
      if (!isProfileSegment(entry)) continue;
      const abs = join(stateRoot, entry);
      if ((await stat(abs)).isDirectory()) profiles.push(entry);
    }
    return profiles;
  } catch {
    return [];
  }
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
  const dirExists = async (dir) => {
    try {
      return (await stat(dir)).isDirectory();
    } catch {
      return false;
    }
  };
  const sharedScope = profiles.length === 0 && (await dirExists(sharedDir)) ? await readScope(sharedDir, "") : null;
  const profileScopes = await Promise.all(profiles.map((profile) => readScope(join(stateRoot, profile, name), profile)));
  return {
    dshHome: home,
    plugin: name,
    scopes: profileScopes,
    shared: sharedScope,
    profiled: profiles.length > 0
  };
}

/** Render a report as human-readable lines (the non-`--json` doctor output). */
export function renderReport(report) {
  const lines = [`dshHome: ${report.dshHome}`];
  const scopes = report.shared !== null ? [report.shared, ...report.scopes] : report.scopes;
  if (scopes.length === 0) {
    lines.push(`no state found under ${join(report.dshHome, "state", report.plugin)} (a clean machine, or one that has never toggled a switch)`);
    return lines.join("\n");
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
  return lines.join("\n");
}

/** `--json` entry: print a stable report object. */
export async function main(argv = process.argv.slice(2)) {
  const report = await diagnose();
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReport(report));
  return report;
}

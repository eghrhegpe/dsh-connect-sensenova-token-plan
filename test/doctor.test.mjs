/**
 * Unit checks for the doctor module (`doctor.ts`) — PEER-FREE, like the other
 * host-side pure readers: it answers "is the provider on or off on this
 * machine" from the plugin's own state files, without a Host running.
 *
 * Covers:
 *   - the three payload parsers (provider / draw / catalog) and their
 *     "corrupt or foreign version reads as unset" direction;
 *   - `diagnose` over a real on-disk layout: the shared (pre-§23) directory,
 *     a profile-scoped directory, and a machine with neither;
 *   - the "a corrupt file is named, not silently dropped" rule;
 *   - `renderReport` lines.
 *
 * Nothing here imports a Host peer or opens a socket.
 */
import { mkdtemp, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProviderPayload,
  parseDrawPayload,
  parseCatalogPayload,
  diagnose,
  deriveSymptoms,
  renderReport
} from "../src/host/doctor.ts";
import { SYMPTOM, SYMPTOM_HINT } from "../src/host/codes.ts";
import { name as PLUGIN_NAME } from "../src/host/host-config.ts";

/** Shorthand: derive symptom ids for a hand-built scope list. */
const derive = (scopes) => deriveSymptoms(scopes);

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- 1. parseProviderPayload ------------------------------------------------
{
  check("a stored true round-trips", parseProviderPayload({ version: 1, enabled: true }).enabled === true);
  check("a stored false round-trips", parseProviderPayload({ version: 1, enabled: false }).enabled === false);
  check("a payload with no enabled key reads as null (fall back to config)",
    parseProviderPayload({ version: 1, updatedAt: "x" }).enabled === null);
  check("a foreign version reads as unset", parseProviderPayload({ version: 99, enabled: true }) === null);
  check("a non-object payload reads as unset",
    parseProviderPayload(null) === null && parseProviderPayload([]) === null && parseProviderPayload("x") === null);
}

// --- 2. parseDrawPayload ----------------------------------------------------
{
  const ok = parseDrawPayload({ version: 1, enabled: true, drawModelId: "sensenova-u1.5-lite" });
  check("draw switch + model round-trip", ok.enabled === true && ok.modelId === "sensenova-u1.5-lite");
  const noModel = parseDrawPayload({ version: 1, enabled: true });
  check("draw with no model preference reads modelId null (auto)",
    noModel.enabled === true && noModel.modelId === null);
  check("draw with a junk model preference reads null",
    parseDrawPayload({ version: 1, enabled: true, drawModelId: 7 }).modelId === null);
  check("a foreign draw version reads as unset", parseDrawPayload({ version: 99 }) === null);
}

// --- 3. parseCatalogPayload -------------------------------------------------
{
  const ok = parseCatalogPayload({
    version: 1,
    fetchedAt: 1000,
    entries: [{ id: "m1", output_modalities: ["image"] }, { id: "m2" }],
    enabledModelIds: ["m1", "m1", 3, null]
  });
  check("catalog entries normalize + allow-list dedupes junk",
    ok.entries.length === 2 && JSON.stringify(ok.enabledModelIds) === JSON.stringify(["m1"]));
  check("a foreign catalog version reads as unset", parseCatalogPayload({ version: 99, fetchedAt: 1, entries: [] }) === null);
  check("a catalog with no fetchedAt and no entries reads as unset",
    parseCatalogPayload({ version: 1, entries: [] }) === null);
}

// --- 4. diagnose over an on-disk layout -------------------------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-"));
  const stateRoot = join(home, "state");
  const sharedDir = join(stateRoot, PLUGIN_NAME);
  const profileDir = join(stateRoot, "web", PLUGIN_NAME);
  await mkdir(sharedDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  // The shared (pre-§23) layout keeps its own values.
  await writeFile(join(sharedDir, "provider.json"), JSON.stringify({ version: 1, enabled: true }));
  await writeFile(join(sharedDir, "draw.json"), JSON.stringify({ version: 1, enabled: true }));
  await writeFile(join(sharedDir, "catalog.json"), JSON.stringify({
    version: 1, fetchedAt: 1000,
    entries: [{ id: "a" }, { id: "b", output_modalities: ["image"] }],
    enabledModelIds: []
  }));
  // The profile-scoped layout has its own, DIFFERENT values.
  await writeFile(join(profileDir, "provider.json"), JSON.stringify({ version: 1, enabled: false }));
  await writeFile(join(profileDir, "catalog.json"), JSON.stringify({
    version: 1, fetchedAt: 2000, entries: [{ id: "c" }], enabledModelIds: ["c"]
  }));

  const report = await diagnose({ dshHome: home });
  check("diagnose sees the profile-scoped scope",
    report.scopes.some((s) => s.profile === "web") === true,
    JSON.stringify(report.scopes.map((s) => s.profile)));
  const web = report.scopes.find((s) => s.profile === "web");
  check("the profile scope reads its OWN values, not the shared ones",
    web.providerPanel === false && web.drawPanel === null && web.catalogEntries.length === 1,
    JSON.stringify({ provider: web.providerPanel, draw: web.drawPanel, entries: web.catalogEntries.length }));
  check("the profile scope reads its own allow-list", JSON.stringify(web.catalogEnabledIds) === JSON.stringify(["c"]));

  // A machine that has a profile directory should NOT also report the shared
  // directory as a fake "profile" — the shared layout is only the pre-§23 answer.
  check("the shared dir is not mistaken for a profile when profiles exist",
    report.scopes.every((s) => s.profile !== null),
    JSON.stringify(report.scopes.map((s) => s.profile)));
  check("with profiles present, the shared layout is reported as `shared`, not a scope",
    report.shared === null && report.profiled === true,
    JSON.stringify({ shared: report.shared === null ? "null" : "set", profiled: report.profiled }));

  await rm(home, { recursive: true, force: true });
}

// --- 4b2. a SIBLING plugin's flat state directory is not a profile ----------
// `$DSH_HOME/state/` is shared by every installed bundle. A sibling plugin
// keeps its state at `state/<sibling-plugin>/` — a flat directory that passes
// `isProfileSegment` (it is a legal single path segment). Reading it as a
// profile made doctor print ANOTHER plugin's switches under a profile name,
// parsed by the wrong parser, on any machine with both plugins installed (this
// one does). The shape that identifies a profile is the NESTING
// `state/<profile>/<plugin>/`; a sibling's flat directory has no such child.
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-sibling-"));
  const stateRoot = join(home, "state");
  // A real profile for THIS plugin.
  await mkdir(join(stateRoot, "web", PLUGIN_NAME), { recursive: true });
  // A sibling plugin's own flat state directory, with values that would be
  // wrong to attribute to a "profile" named after it.
  await mkdir(join(stateRoot, "dsh-connect-agnes-token-plan"), { recursive: true });
  await writeFile(join(stateRoot, "dsh-connect-agnes-token-plan", "provider.json"),
    JSON.stringify({ version: 1, enabled: true }));

  const report = await diagnose({ dshHome: home });
  check("a sibling plugin's flat state directory is not reported as a profile",
    report.scopes.every((s) => s.profile !== "dsh-connect-agnes-token-plan"),
    JSON.stringify(report.scopes.map((s) => s.profile)));
  check("only the real profile (which nests this plugin) is listed",
    report.scopes.length === 1 && report.scopes[0].profile === "web",
    JSON.stringify(report.scopes.map((s) => s.profile)));
  await rm(home, { recursive: true, force: true });
}

// --- 4b. diagnose over a shared-only (pre-§23) machine ----------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-shared-"));
  const stateRoot = join(home, "state");
  const sharedDir = join(stateRoot, PLUGIN_NAME);
  await mkdir(sharedDir, { recursive: true });
  await writeFile(join(sharedDir, "provider.json"), JSON.stringify({ version: 1, enabled: true }));

  const report = await diagnose({ dshHome: home });
  check("a machine with only the shared layout reports it as `shared`",
    report.shared !== null && report.shared.providerPanel === true && report.profiled === false,
    JSON.stringify({ profiled: report.profiled, provider: report.shared?.providerPanel }));
  await rm(home, { recursive: true, force: true });
}

// --- 4c. a corrupt file is named, not silently dropped ----------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-corrupt-"));
  const stateRoot = join(home, "state");
  const dir = join(stateRoot, PLUGIN_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "provider.json"), "this is not json");
  const report = await diagnose({ dshHome: home });
  check("a corrupt provider.json is named in the scope's unreadable list",
    report.shared.unreadable.includes("provider.json"),
    JSON.stringify(report.shared.unreadable));
  check("the unreadable file still reads the switch as null (fall back to config)",
    report.shared.providerPanel === null);
  const lines = renderReport(report);
  check("the human report names the unreadable file", lines.includes("provider.json"), lines);
  await rm(home, { recursive: true, force: true });
}

// --- 4d. a clean machine (no state at all) ----------------------------------
{
  const home = await mkdtemp(join(tmpdir(), "dsh-doctor-clean-"));
  const report = await diagnose({ dshHome: home });
  check("a clean machine reports no state and is not profiled",
    report.shared === null && report.scopes.length === 0 && report.profiled === false,
    JSON.stringify({ shared: report.shared, scopes: report.scopes.length, profiled: report.profiled }));
  const lines = renderReport(report);
  check("the human report says so plainly", lines.includes("no state found"), lines);
  await rm(home, { recursive: true, force: true });
}

// --- 5. symptom ids: the report names what a user SEES, and points at a page -
// The symptom layer exists so "额度那栏一直是空的" is answerable from one
// read-only command instead of by guessing which document owns the topic. Two
// halves are pinned: the derivation (disk → ids) and the closure (ids ↔ the
// troubleshooting page), because a symptom id with no page is exactly the
// "document is right but you cannot find it" failure this was built to remove.
{
  const ids = (report) => report.symptoms.map((s) => s.id);
  const scopeIds = (scopes) => deriveSymptoms(scopes).map((s) => s.id);

  // -- 5a. a clean machine names nothing, and says so.
  {
    const home = await mkdtemp(join(tmpdir(), "dsh-doctor-sym-clean-"));
    const report = await diagnose({ dshHome: home });
    check("a clean machine reports no symptoms", ids(report).length === 0, JSON.stringify(ids(report)));
    check("the human report says 'none' rather than staying silent",
      renderReport(report).includes("symptoms: none"), renderReport(report));
    await rm(home, { recursive: true, force: true });
  }

  // -- 5b. the provider switch being OFF is a symptom, not a malfunction.
  // (Default is off, so this is the single most common false alarm.)
  {
    const scope = { profile: null, stateDir: "/x", providerPanel: false, drawPanel: null,
      drawModelPanel: null, catalogEntries: [], catalogEnabledIds: [], catalogFetchedAt: 0, unreadable: [] };
    check("provider explicitly off reports provider-missing",
      scopeIds([scope]).includes("provider-missing"), JSON.stringify(scopeIds([scope])));
    check("an UNSET provider switch is not a symptom (the default rules decide)",
      !scopeIds([{ ...scope, providerPanel: null }]).includes("provider-missing"));
  }

  // -- 5c. a state file that is not this build's payload.
  {
    const scope = { profile: null, stateDir: "/x", providerPanel: null, drawPanel: null,
      drawModelPanel: null, catalogEntries: [], catalogEnabledIds: [], catalogFetchedAt: 0,
      unreadable: ["catalog.json"] };
    check("an unreadable state file reports state-unreadable",
      scopeIds([scope]).includes("state-unreadable"));
  }

  // -- 5d. a switch on but nothing to call / nothing fetched.
  {
    const scope = (over) => ({ profile: null, stateDir: "/x", providerPanel: null, drawPanel: null,
      drawModelPanel: null, catalogEntries: [], catalogEnabledIds: [], catalogFetchedAt: 0,
      unreadable: [], ...over });
    check("draw on with neither a model nor a catalog reports tool-or-model-missing",
      scopeIds([scope({ drawPanel: true })]).includes("tool-or-model-missing"),
      JSON.stringify(scopeIds([scope({ drawPanel: true })])));
    check("draw on WITH a catalog stops reporting tool-or-model-missing",
      !scopeIds([scope({ drawPanel: true, catalogEntries: [{ id: "m" }] })]).includes("tool-or-model-missing"));
    check("a switch on with an empty catalog reports quota-empty",
      scopeIds([scope({ providerPanel: true })]).includes("quota-empty"),
      JSON.stringify(scopeIds([scope({ providerPanel: true })])));
    check("a filled catalog stops reporting quota-empty",
      !scopeIds([scope({ providerPanel: true, catalogEntries: [{ id: "m" }] })]).includes("quota-empty"));
  }

  // -- 5e. every id carries a non-empty first move.
  for (const id of Object.values(SYMPTOM)) {
    check(`symptom ${id} carries a first move`,
      typeof SYMPTOM_HINT[id] === "string" && SYMPTOM_HINT[id].length > 0, String(SYMPTOM_HINT[id]));
  }
  check("no declared symptom id is missing from the hint table",
    Object.values(SYMPTOM).every((id) => typeof SYMPTOM_HINT[id] === "string" && SYMPTOM_HINT[id].length > 0),
    Object.values(SYMPTOM).filter((id) => !SYMPTOM_HINT[id]).join(", "));

  // -- 5f. the order is the declaration order, not discovery order: two runs on
  //        the same machine must produce the same array.
  {
    const messy = [
      { profile: "web", stateDir: "/x", providerPanel: false, drawPanel: true, drawModelPanel: null,
        catalogEntries: [], catalogEnabledIds: [], catalogFetchedAt: 0, unreadable: [] },
      { profile: "desktop", stateDir: "/y", providerPanel: false, drawPanel: null,
        drawModelPanel: null, catalogEntries: [], catalogEnabledIds: [], catalogFetchedAt: 0, unreadable: ["draw.json"] }
    ];
    check("the same state derives the same ids in the same order",
      JSON.stringify(scopeIds(messy)) === JSON.stringify(scopeIds(messy)), JSON.stringify(scopeIds(messy)));
    check("ids come out in SYMPTOM declaration order",
      JSON.stringify(scopeIds(messy)) === JSON.stringify(
        Object.values(SYMPTOM).filter((id) => scopeIds(messy).includes(id))),
      JSON.stringify(scopeIds(messy)));
  }

  // -- 5g. THE CLOSURE: every declared id is documented, and every documented id
  //        is declared. This is the gate that keeps "findable by symptom" true:
  //        a new symptom that nobody wrote a page for, or a page whose code was
  //        renamed, both land here.
  {
    const page = await readFile(new URL("../docs/TROUBLESHOOTING.md", import.meta.url), "utf8");
    const declared = Object.values(SYMPTOM);
    // Collect the ids the page ASSERTS, in either spelling it uses: a lone
    // line (`` `quota-empty` ``) or several on one line separated by `·`
    // (`` `needs-login` · `login-refused` ``). Matching bare `a-b` tokens
    // instead would sweep up CI job names, file names and anchor slugs and
    // report every one of them as a stale symptom.
    const documented = new Set();
    for (const m of page.matchAll(/^([^\n]*)$/gm)) {
      // Only lines that consist of ids and separators, nothing else.
      if (!/^[`\s·a-z-]+$/.test(m[1])) continue;
      for (const id of m[1].matchAll(/`([a-z][a-z0-9]*-[a-z0-9-]+)`/g)) documented.add(id[1]);
    }
    const missingDoc = declared.filter((id) => !documented.has(id));
    check("every declared symptom id is documented in TROUBLESHOOTING.md",
      missingDoc.length === 0, `missing=${missingDoc.join(", ")} documented=${[...documented].join(", ")}`);
    // The reverse direction: an asserted id in the page that no longer exists in
    // code is a page that sends readers (and agents) to nothing.
    const staleDoc = [...documented].filter((id) => !declared.includes(id));
    check("every symptom id quoted in TROUBLESHOOTING.md exists in code",
      staleDoc.length === 0, staleDoc.join(", "));
    // And every hint must point at a page anchor that actually exists. The hint
    // reads `path#anchor — what to do`, so the anchor ends at the first space.
    const anchors = [...page.matchAll(/\{#([^}]+)\}/g)].map((m) => m[1]);
    const badAnchor = declared.filter((id) => {
      const ref = SYMPTOM_HINT[id].match(/TROUBLESHOOTING\.md#([^\s—]+)/);
      return ref !== null && !anchors.includes(ref[1]);
    });
    check("every symptom hint points at an anchor the page defines",
      badAnchor.length === 0, badAnchor.map((id) => `${id} -> ${SYMPTOM_HINT[id].match(/#(\S+)/)?.[1]}`).join("; "));
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

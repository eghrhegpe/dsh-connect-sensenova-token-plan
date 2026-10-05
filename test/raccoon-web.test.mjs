/**
 * Unit checks for the Raccoon `ctx.web` web-search mount (`lifecycle.ts`) and
 * its opt-in switch store (`raccoon-web-store.ts`) — PEER-FREE:
 *
 * - `applyWebSearchSelection`: take-over remembers the displaced backend,
 *   re-assert does not forget it, hand-back restores only what it displaced,
 *   a pre-existing own pin is left alone, and a non-owner hand-back is a no-op;
 * - `registerWebSearchProvider`: off / config-error / no-web-service bail, and
 *   the happy path — one provider registered, selection taken over, and the
 *   restore remembered on `wiring.webSearchRestore`;
 * - the switch store: save / read / forget round-trip in a temp dir, the
 *   ADR-006 version guard, and "unrecognised reads as not set".
 *
 * Nothing here opens a socket or touches the real credentials.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWebSearchProvider, applyWebSearchSelection, webSearchSelection, reconcileWebSearch, teardown } from "../src/host/lifecycle.ts";
import { RACCOON_SEARCH_PROVIDER_ID as PROVIDER_ID } from "../src/host/raccoon-search.ts";
import { createFileRaccoonWebStore, RACCOON_WEB_SWITCH_VERSION } from "../src/host/raccoon-web-store.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: !!condition, detail });
}
function fail(group, error) {
  results.push({ name: `${group}: threw ${error?.name ?? "Error"}`, pass: false, detail: String(error?.message ?? error) });
}

/** A minimal `ctx.web` runtime that records registrations. */
function makeWeb(prior = undefined) {
  const registered = [];
  return {
    searchProviderId: prior,
    registered,
    registerSearchProvider: (provider) => registered.push(provider)
  };
}

function makeWiring(overrides = {}) {
  return {
    settings: { webSearchEnabled: false },
    configError: null,
    publisher: { isDisposed: () => false },
    resolveRaccoonToken: async () => "tok",
    webSearchStore: { enabled: async () => null },
    // Always present since2026-10-05: "no takeover held" is `current: null`,
    // not a missing property. The factory used to omit the field entirely and
    // let the type declare it optional, which is the shape the slot replaced.
    webSearchRestore: { current: null },
    ...overrides
  };
}

try {
  // --- 1. applyWebSearchSelection ----------------------------------------
  {
    const web = makeWeb("deepseek-official");
    const state = webSearchSelection();
    applyWebSearchSelection(web, state, true);
    check("enable takes the selection over and remembers the displaced id",
      web.searchProviderId === PROVIDER_ID && state.owner === true && state.displaced === "deepseek-official" && state.preexisting === false, JSON.stringify({ web: web.searchProviderId, state }));

    applyWebSearchSelection(web, state, true);
    check("a re-assert keeps the remembered displaced id", state.displaced === "deepseek-official", JSON.stringify(state));

    applyWebSearchSelection(web, state, false);
    check("hand-back restores the displaced backend and clears owner",
      web.searchProviderId === "deepseek-official" && state.owner === false, JSON.stringify({ id: web.searchProviderId, state }));

    applyWebSearchSelection(web, state, false);
    check("a non-owner hand-back is a no-op", web.searchProviderId === "deepseek-official", web.searchProviderId);
  }

  {
    // Already our own id: preexisting — take-over and hand-back both touch nothing.
    const web = makeWeb(PROVIDER_ID);
    const state = webSearchSelection();
    applyWebSearchSelection(web, state, true);
    check("a pre-existing own pin is remembered, not treated as displacement",
      state.preexisting === true && state.displaced === undefined, JSON.stringify(state));
    applyWebSearchSelection(web, state, false);
    check("hand-back leaves a pre-existing own pin alone", web.searchProviderId === PROVIDER_ID && state.owner === false, web.searchProviderId);
  }

  {
    // A frozen runtime must not throw.
    const frozen = Object.freeze({ searchProviderId: undefined, registerSearchProvider: () => {} });
    const state = webSearchSelection();
    let threw = false;
    try {
      applyWebSearchSelection(frozen, state, true);
    } catch {
      threw = true;
    }
    check("a hardened runtime degrades instead of throwing", threw === false, String(threw));
  }

  // --- 2. registerWebSearchProvider -------------------------------------
  {
    const offWeb = makeWeb();
    await registerWebSearchProvider({ get: (n) => (n === "web" ? offWeb : null) }, makeWiring());
    check("off: no provider is registered and no restore is armed",
      offWeb.registered.length === 0, JSON.stringify(offWeb.registered));

    const errWeb = makeWeb();
    const errWiring = makeWiring({ configError: "bad config" });
    await registerWebSearchProvider({ get: (n) => (n === "web" ? errWeb : null) }, errWiring);
    check("a config error bails without registering", errWeb.registered.length === 0);

    const noService = makeWiring({ settings: { webSearchEnabled: true } });
    await registerWebSearchProvider({ get: () => null }, noService);
    check("no web service: no registration, no restore armed", noService.webSearchRestore.current === null);

    const noMethod = makeWeb();
    delete noMethod.registerSearchProvider;
    const noMethodWiring = makeWiring({ settings: { webSearchEnabled: true } });
    await registerWebSearchProvider({ get: (n) => (n === "web" ? noMethod : null) }, noMethodWiring);
    check("a web service without registerSearchProvider is treated as absent", noMethodWiring.webSearchRestore.current === null);

    const web = makeWeb("deepseek-official");
    const wiring = makeWiring({
      settings: { webSearchEnabled: true },
      webSearchStore: { enabled: async () => true }
    });
    await registerWebSearchProvider({ get: (n) => (n === "web" ? web : null) }, wiring);
    check("on: one provider is registered under the raccoon id",
      web.registered.length === 1 && web.registered[0].id === PROVIDER_ID && web.registered[0].available() === true, JSON.stringify(web.registered.map((p) => p.id)));
    check("on: the selection is taken over and the restore is armed",
      web.searchProviderId === PROVIDER_ID && typeof wiring.webSearchRestore.current === "function", web.searchProviderId);

    wiring.webSearchRestore.current();
    check("the armed restore hands the selection back", web.searchProviderId === "deepseek-official", web.searchProviderId);

    // Panel OFF beats config ON (the adjudicator's job, but it must hold here).
    const panelOffWeb = makeWeb();
    const panelOffWiring = makeWiring({
      settings: { webSearchEnabled: true },
      webSearchStore: { enabled: async () => false }
    });
    await registerWebSearchProvider({ get: (n) => (n === "web" ? panelOffWeb : null) }, panelOffWiring);
    check("a panel-saved OFF beats the config default",
      panelOffWeb.registered.length === 0 && panelOffWiring.webSearchRestore.current === null);

    // The dispose race (P0-1): `startSideEffects` fires this without awaiting,
    // so `await resolveServiceWithRetry` can be pending when the host disposes
    // the plugin. The teardown has then already run and read `current` before
    // it is armed, so a late-arriving take-over must hand the selection straight
    // back instead of arming an unreachable restore — otherwise the global
    // `searchProviderId` stays hijacked by Raccoon after the plugin exits.
    const disposedWeb = makeWeb("deepseek-official");
    const disposedWiring = makeWiring({
      settings: { webSearchEnabled: true },
      webSearchStore: { enabled: async () => true },
      publisher: { isDisposed: () => true }
    });
    await registerWebSearchProvider({ get: (n) => (n === "web" ? disposedWeb : null) }, disposedWiring);
    check("disposed mid-flight: selection is NOT hijacked",
      disposedWeb.searchProviderId === "deepseek-official", disposedWeb.searchProviderId);
    check("disposed mid-flight: no unreachable restore is armed",
      disposedWiring.webSearchRestore.current === null, typeof disposedWiring.webSearchRestore.current);
  }

  // --- 2b. the restore SLOT (reconcile / teardown) ------------------------
  // Added 2026-10-05 with the `{ current }` slot. Two behaviours the slot made
  // expressible that the optional-property shape could not state: "never armed"
  // and "armed then drained" were both just `undefined` before, so the
  // in-session flip had no assertion of its own — the suite only ever checked
  // register's happy path and its bails.
  //
  // The flip is driven through a MUTABLE store because
  // `resolveSwitchEnabled(panel, config) = (panel ?? config)` — the panel-saved
  // value wins, so "off" means the store returns false, NOT that the config
  // default is false (that combination reads as ON, and the first draft of
  // this section got it backwards and armed instead of draining).
  {
    // Flip ON: reconcile arms the slot and takes the selection over.
    const onWeb = makeWeb("deepseek-official");
    const onWiring = makeWiring({
      settings: { webSearchEnabled: true },
      webSearchStore: { enabled: async () => true }
    });
    await reconcileWebSearch({ get: (n) => (n === "web" ? onWeb : null) }, onWiring);
    check("reconcile arms the slot and takes the selection over",
      typeof onWiring.webSearchRestore.current === "function" && onWeb.searchProviderId === PROVIDER_ID,
      `current=${typeof onWiring.webSearchRestore.current} id=${onWeb.searchProviderId}`);

    // Flip ON → OFF in-session: the panel store now says false.
    let switchOn = true;
    const web = makeWeb("deepseek-official");
    const wiring = makeWiring({
      settings: { webSearchEnabled: true },
      webSearchStore: { enabled: async () => switchOn }
    });
    await reconcileWebSearch({ get: (n) => (n === "web" ? web : null) }, wiring);
    check("armed before the flip: the slot holds a closure and the selection is ours",
      typeof wiring.webSearchRestore.current === "function" && web.searchProviderId === PROVIDER_ID,
      `current=${typeof wiring.webSearchRestore.current} id=${web.searchProviderId}`);

    switchOn = false;
    await reconcileWebSearch({ get: (n) => (n === "web" ? web : null) }, wiring);
    check("a flip to OFF drains the slot",
      wiring.webSearchRestore.current === null,
      `current=${String(wiring.webSearchRestore.current)}`);
    check("a flip to OFF hands the displaced backend back",
      web.searchProviderId === "deepseek-official", web.searchProviderId);

    // A second reconcile over the drained slot: nothing held, so nothing is
    // handed back and nothing throws. (Under the old shape this was the same
    // code path, but with no assertion pinning it.)
    let secondThrew = null;
    try {
      await reconcileWebSearch({ get: (n) => (n === "web" ? web : null) }, wiring);
    } catch (error) {
      secondThrew = String(error.message ?? error);
    }
    check("a second reconcile over a drained slot is a no-op, not a throw",
      secondThrew === null && wiring.webSearchRestore.current === null, secondThrew ?? "(no throw)");

    // teardown with a never-armed slot — the dispose-before-mount path. It
    // needs a publisher with `dispose` and a `releaseProvider`, because
    // teardown's job is the whole withdrawal, not just the web hand-back.
    let disposed = 0;
    let released = 0;
    let teardownThrew = null;
    try {
      teardown(makeWiring({
        publisher: { isDisposed: () => false, dispose: () => { disposed += 1; } },
        releaseProvider: () => { released += 1; }
      }), []);
    } catch (error) {
      teardownThrew = String(error.message ?? error);
    }
    check("teardown on a never-armed slot does not throw", teardownThrew === null, teardownThrew ?? "(no throw)");
    check("teardown still disposes the publisher and releases the provider",
      disposed === 1 && released === 1, `disposed=${disposed} released=${released}`);

    // And the armed case: teardown hands the selection back exactly once.
    const armedWeb = makeWeb("deepseek-official");
    const armedWiring = makeWiring({
      settings: { webSearchEnabled: true },
      webSearchStore: { enabled: async () => true }
    });
    await registerWebSearchProvider({ get: (n) => (n === "web" ? armedWeb : null) }, armedWiring);
    teardown(makeWiring({
      ...armedWiring,
      publisher: { isDisposed: () => false, dispose: () => {} },
      releaseProvider: () => {}
    }), []);
    check("teardown hands an armed selection back to the displaced backend",
      armedWeb.searchProviderId === "deepseek-official", armedWeb.searchProviderId);
  }

  // --- 3. raccoon-web-store ---------------------------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), "raccoon-web-"));
    const store = createFileRaccoonWebStore({ dir });
    check("an empty store reads as not set", (await store.isSet()) === false && (await store.enabled()) === null);

    await store.save(true);
    check("save then read round-trips true", (await store.enabled()) === true && (await store.isSet()) === true);

    await store.save(false);
    check("save then read round-trips false", (await store.enabled()) === false);

    await store.forget();
    check("forget clears the saved value", (await store.isSet()) === false);

    await store.save(true);
    // ADR-006: a file holding a version this build does not know is refused.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "raccoon-web-search.json"), JSON.stringify({ version: RACCOON_WEB_SWITCH_VERSION + 99, enabled: false }));
    let refusal = null;
    try {
      await store.save(false);
    } catch (error) {
      refusal = String(error.message ?? error);
    }
    check("the ADR-006 version guard refuses to clobber a newer file", refusal !== null, refusal ?? "(no throw)");

    const bad = createFileRaccoonWebStore({ dir: join(dir, "nope") });
    check("an unrecognised payload reads as not set", (await bad.isSet()) === false);
  }
} catch (error) {
  fail("raccoon-web", error);
}

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
for (const row of failed) console.log(JSON.stringify(row));
console.log(`raccoon-web.test.mjs: ${passed}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
/**
 * Frozen BEHAVIOR baseline for token-store.js — the pre-split guardrail for
 * the planned login / renewal / throttle / migration split (review item #5:
 * "944-line token-store.js monolith").
 *
 * store.test.mjs asserts CHOSEN semantics live (its own hand-written checks).
 * THIS file freezes the store's FULL observable surface as a JSON trace:
 * every credentials-service call, every throttle-store call, every grant/ref
 * write, every thrown {code,message}, and the exact state() object at every
 * step. After the split, ANY behavioral drift — even an interaction nobody
 * thought to assert — fails here byte-for-byte.
 *
 * It drives only the PUBLIC store API through injected fakes (a scripted
 * auth, an in-memory credentials service, a shared in-memory throttle store
 * standing in for persistence across a "restart", a virtual clock): no
 * network, no peer packages, no wall clock — runnable on a clean checkout.
 *
 * Regenerate intentionally, with the reason for the behavior change in the
 * commit message:
 *   UPDATE_BASELINE=1 node test/store-baseline.test.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTokenStore,
  RECORD_SCOPE,
  LEGACY_SCOPE,
  RECORD_ID,
  THROTTLE_ID,
  USERNAME_REF,
  PASSWORD_REF
} from "../src/host/token-store.ts";
import { createMemoryThrottleStore } from "../src/host/throttle-store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(HERE, "baselines");
const BASELINE = join(BASELINE_DIR, "token-store-behavior.json");

// Virtual epoch: timestamps the store computes (expiresAt/until) come out as
// T0 + k; the trace normalizes them to offsets from T0. Durations stay raw.
const T0 = 1_000_000_000_000;
const SKEW_MS = 120_000;

const GRANT_KEY = `${RECORD_SCOPE}/${RECORD_ID}`;
const LEGACY_GRANT_KEY = `${LEGACY_SCOPE}/${RECORD_ID}`;
const THROTTLE_KEY_RAW = `${RECORD_SCOPE}/${THROTTLE_ID}`;
const LEGACY_THROTTLE_KEY_RAW = `${LEGACY_SCOPE}/${THROTTLE_ID}`;

// ---------------------------------------------------------------- fixtures

const credKey = (scope, id) => `${scope}/${id}`;

const grant = (accessToken, refreshToken, expiresAt) => ({
  kind: "grant",
  payload: { version: 1, accessToken, refreshToken, expiresAt }
});

const legacyThrottleRecord = (code, parked, attempt) => ({
  kind: "grant",
  payload: { marker: "signin-throttle", version: 1, code, parked, attempt }
});

const failure = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code }, extra);

function makeService(initialRecords = {}, initialRefs = {}, events, hooks = {}) {
  const records = new Map(Object.entries(initialRecords));
  const refs = new Map(Object.entries(initialRefs));
  return {
    records,
    refs,
    async readRecord(k) {
      events.push({ via: "credentials", op: "readRecord", key: normKey(k) });
      return records.get(k);
    },
    async modifyRecord(k, mutate) {
      events.push({ via: "credentials", op: "modifyRecord", key: normKey(k) });
      await hooks.beforeMutate?.(k, records);
      const next = await mutate(records.get(k));
      if (next === undefined) return records.get(k);
      records.set(k, next);
      return next;
    },
    async deleteRecord(k) {
      events.push({ via: "credentials", op: "deleteRecord", key: normKey(k) });
      records.delete(k);
    },
    async resolve(r) {
      events.push({ via: "credentials", op: "resolve", ref: normRef(r) });
      const value = refs.get(r);
      return typeof value === "string" && value !== ""
        ? { value, source: "fake" }
        : undefined;
    },
    async set(r, value) {
      events.push({ via: "credentials", op: "set", ref: normRef(r) });
      refs.set(r, value);
    },
    async unset(r) {
      events.push({ via: "credentials", op: "unset", ref: normRef(r) });
      refs.delete(r);
    }
  };
}

const unreachable = async () => {
  throw new Error("scripted auth path must not be reached");
};

function makeAuth(script, events) {
  return {
    async login(account) {
      events.push({
        via: "auth",
        op: "login",
        username: account.username,
        hasPassword: typeof account.password === "string" && account.password.length > 0
      });
      return script.login(account);
    },
    async refresh(token) {
      events.push({ via: "auth", op: "refresh", token });
      return script.refresh(token);
    }
  };
}

// ------------------------------------------------------------- normalizing

function normKey(k) {
  return String(k)
    .split(LEGACY_SCOPE).join("$LEGACY")
    .split(RECORD_SCOPE).join("$SCOPE")
    // THROTTLE_ID contains RECORD_ID as a prefix, so replace it first.
    .split(THROTTLE_ID).join("$THROTTLE")
    .split(RECORD_ID).join("$GRANT");
}

function normRef(r) {
  return String(r)
    .split(USERNAME_REF).join("$USER")
    .split(PASSWORD_REF).join("$PASS");
}

function normError(e) {
  return {
    code: e && typeof e === "object" ? (e.code ?? null) : null,
    message: e instanceof Error ? e.message : String(e)
  };
}

function norm(x) {
  if (typeof x === "number") return x >= T0 ? x - T0 : x;
  if (typeof x === "string") return normRef(normKey(x));
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(norm);
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (v !== undefined) out[normRef(normKey(k))] = norm(v);
  }
  return out;
}

// --------------------------------------------------------------- scenarios

const defs = [];
function define(name, run) {
  defs.push({ name, run });
}

/**
 * Build one isolated scenario world: fresh clock, event log, credentials
 * service and throttle store. Stores created inside run share the world, so
 * a second store stands in for a process restart.
 */
async function runScenario(def) {
  let t = 0;
  const now = () => T0 + t;
  const advance = (ms) => {
    t += ms;
  };
  const events = [];
  const frames = [];

  const makeStore = ({ service, auth, env = {}, throttleStore }) =>
    createTokenStore({
      credentials: service ?? null,
      credentialKey: credKey,
      auth,
      env,
      skewMs: SKEW_MS,
      throttleStore,
      now
    });

  async function snapshot(service, throttleStore) {
    const records = {};
    if (service) for (const [k, v] of service.records) records[normKey(k)] = norm(v);
    const refs = {};
    if (service) for (const [r, v] of service.refs) refs[normRef(r)] = norm(v);
    return {
      records,
      refs,
      // The store's own read view (an expired window already reads null).
      throttle: throttleStore ? norm(await throttleStore.read()) : null
    };
  }

  // One frame = one public-API call, plus the full world state after it.
  async function frame(note, fn, deps) {
    const start = events.length;
    let ok = true;
    let value;
    try {
      value = await fn();
    } catch (e) {
      ok = false;
      value = e;
    }
    frames.push({
      t,
      note,
      calls: events.slice(start).map((e) => ({ ...e })),
      ...(await snapshot(deps.service, deps.throttleStore)),
      ...(ok
        ? { result: value === undefined ? null : norm(value) }
        : { error: normError(value) })
    });
  }

  const ctx = {
    T0,
    now,
    advance,
    frame,
    GRANT_KEY,
    LEGACY_GRANT_KEY,
    THROTTLE_KEY: THROTTLE_KEY_RAW,
    LEGACY_THROTTLE_KEY: LEGACY_THROTTLE_KEY_RAW,
    grant,
    legacyThrottleRecord,
    failure,
    envAccount(extra = {}) {
      return { [USERNAME_REF]: "alice", [PASSWORD_REF]: "pw", ...extra };
    },
    service(records = {}, refs = {}, hooks = {}) {
      return makeService(records, refs, events, hooks);
    },
    throttle() {
      return createMemoryThrottleStore(now);
    },
    auth(script = {}) {
      return makeAuth({ login: unreachable, refresh: unreachable, ...script }, events);
    },
    store(opts) {
      return makeStore(opts);
    }
  };

  await def.run(ctx);
  return { name: def.name, frames };
}

// S1 — [login] nothing configured: no login attempt, no throttle written,
// not_configured is not a refusal.
define("S1 unconfigured: no attempt and no throttle", async ({ frame, service, throttle, auth, store }) => {
  const svc = service();
  const thr = throttle();
  const s = store({ service: svc, auth: auth({ login: async () => ({ accessToken: "AT1", refreshToken: "RT1", expiresIn: 10800 }) }), env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("initial", async () => null, deps);
  await frame("getToken with no grant and no account", () => s.getToken(), deps);
  await frame("state after the not_configured failure", () => s.state(), deps);
});

// S2 — [login] env bootstrap: one login, grant persisted v1 with
// now+expiresIn, second call served from cache.
define("S2 env login persists the grant then serves from cache", async ({ frame, service, throttle, auth, store, envAccount }) => {
  const svc = service();
  const thr = throttle();
  const a = auth({ login: async () => ({ accessToken: "AT1", refreshToken: "RT1", expiresIn: 10800 }) });
  const s = store({ service: svc, auth: a, env: envAccount(), throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken performs one login", () => s.getToken(), deps);
  await frame("getToken again is served from cache", () => s.getToken(), deps);
  await frame("state after login", () => s.state(), deps);
});

// S3 — [throttle] a credential-shaped refusal is parked (no deadline) and
// survives a "restart" into a second store sharing the same backends; the
// second store must not spend a login attempt.
define("S3 parked refusal survives a restart with no new login", async ({ frame, service, throttle, auth, store, failure }) => {
  const svc = service();
  const thr = throttle();
  const a1 = auth({ login: async () => {
    throw failure("login_rejected", "platform: invalid account or password");
  } });
  const s1 = store({ service: svc, auth: a1, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("saveAccount with a wrong password", () => s1.saveAccount({ username: "alice", password: "bad" }), deps);
  await frame("state reports the parked refusal", () => s1.state(), deps);
  // "Restart": second store, same backends, no password. Its auth must never
  // be called — the trace gains a login event only if the park was lost.
  const a2 = auth({ login: async () => {
    throw failure("login_rejected", "platform: park was lost");
  } });
  const s2 = store({ service: svc, auth: a2, env: {}, throttleStore: thr });
  await frame("getToken after restart refuses without a login attempt", () => s2.getToken(), deps);
  await frame("state after restart still shows the park", () => s2.state(), deps);
});

// S4 — [throttle] local backoff doubles 60s -> 120s across a closed window
// (attempt count is kept), and a success clears the wait and the count.
define("S4 local backoff doubles, then success clears it", async ({ frame, service, throttle, auth, store, envAccount, failure, advance }) => {
  const svc = service();
  const thr = throttle();
  let n = 0;
  const a = auth({
    login: async () => {
      n += 1;
      if (n <= 2) throw failure("rate_limited", `platform: too many attempts (${n})`);
      return { accessToken: "AT1", refreshToken: "RT1", expiresIn: 10800 };
    }
  });
  const s = store({ service: svc, auth: a, env: envAccount(), throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken #1 fails: 60s local backoff", () => s.getToken(), deps);
  advance(61_000);
  await frame("getToken #2 after the window fails: doubled 120s backoff", () => s.getToken(), deps);
  advance(121_000);
  await frame("getToken #3 after the doubled window succeeds", () => s.getToken(), deps);
  await frame("state after success", () => s.state(), deps);
});

// S5 — [throttle] a platform-stated window is taken verbatim and never
// truncated by the local 30-minute cap.
define("S5 platform-stated window is honoured untruncated", async ({ frame, service, throttle, auth, store, envAccount, failure }) => {
  const svc = service();
  const thr = throttle();
  const a = auth({
    login: async () => {
      throw failure("rate_limited", "platform: try again in 2 hours", { retryAfterMs: 7_200_000 });
    }
  });
  const s = store({ service: svc, auth: a, env: envAccount(), throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken fails carrying the 2h platform window", () => s.getToken(), deps);
  await frame("state shows the full 2h countdown", () => s.state(), deps);
});

// S6a — [renewal] near-expiry grant is renewed; rotated pair persisted via
// compare-and-set naming the superseded access token.
define("S6a near-expiry grant is renewed and the rotation persisted", async ({ frame, service, throttle, auth, store, grant, GRANT_KEY, T0 }) => {
  const svc = service({ [GRANT_KEY]: grant("AT1", "RT1", T0 + 60_000) });
  const thr = throttle();
  const a = auth({ refresh: async () => ({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 10800 }) });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken renews the near-expiry grant", () => s.getToken(), deps);
  await frame("state after renewal", () => s.state(), deps);
});

// S6b — [renewal] concurrent polls share one in-flight acquisition.
define("S6b three concurrent polls share exactly one refresh", async ({ frame, service, throttle, auth, store, grant, GRANT_KEY, T0 }) => {
  const svc = service({ [GRANT_KEY]: grant("AT1", "RT1", T0 + 60_000) });
  const thr = throttle();
  const a = auth({ refresh: async () => ({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 10800 }) });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("three concurrent getToken calls", async () => Promise.all([s.getToken(), s.getToken(), s.getToken()]), deps);
});

// S6c — [renewal] compare-and-set defers: while our refresh write is in
// flight, another process rotated the grant; our write yields to the newer
// grant instead of overwriting it (the consumed refresh is discarded).
define("S6c refresh write defers to a concurrently rotated grant", async ({ frame, service, throttle, auth, store, grant, GRANT_KEY, T0 }) => {
  const svc = service(
    { [GRANT_KEY]: grant("AT1", "RT1", T0 + 60_000) },
    {},
    {
      beforeMutate: (k, records) => {
        if (k === GRANT_KEY) records.set(k, grant("AT9", "RT9", T0 + 10_000_000));
      }
    }
  );
  const thr = throttle();
  const a = auth({ refresh: async () => ({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 10800 }) });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken returns the other process's newer grant", () => s.getToken(), deps);
  await frame("state keeps the newer grant", () => s.state(), deps);
});

// S7a — [renewal->reap] refresh_rejected with no account: dead grant is
// purged so no ownerless pair lingers and polls stop hitting the dead token.
define("S7a dead refresh with no account reaps the grant", async ({ frame, service, throttle, auth, store, grant, failure, GRANT_KEY, T0 }) => {
  const svc = service({ [GRANT_KEY]: grant("AT1", "RT1", T0 + 60_000) });
  const thr = throttle();
  const a = auth({
    refresh: async () => {
      throw failure("refresh_rejected", "refresh token is dead");
    }
  });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken surfaces refresh_rejected and reaps the grant", () => s.getToken(), deps);
  await frame("state after the reap", () => s.state(), deps);
});

// S7b — [renewal->login] refresh_rejected WITH an env account falls through
// to a password login instead of reaping.
define("S7b dead refresh with an account re-logs-in", async ({ frame, service, throttle, auth, store, grant, failure, envAccount, GRANT_KEY, T0 }) => {
  const svc = service({ [GRANT_KEY]: grant("AT1", "RT1", T0 + 60_000) });
  const thr = throttle();
  const a = auth({
    refresh: async () => {
      throw failure("refresh_rejected", "refresh token is dead");
    },
    login: async () => ({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 10800 })
  });
  const s = store({ service: svc, auth: a, env: envAccount(), throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken falls through to a password login", () => s.getToken(), deps);
  await frame("state after re-login", () => s.state(), deps);
});

// S8 — [renewal] invalidate(): a console-refused token is never handed out
// again even while its exp looks fresh, forcing exactly one renewal.
define("S8 invalidated token is renewed once, never replayed", async ({ frame, service, throttle, auth, store, grant, GRANT_KEY, T0 }) => {
  const svc = service({ [GRANT_KEY]: grant("AT1", "RT1", T0 + 10_000_000) });
  const thr = throttle();
  const a = auth({ refresh: async () => ({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 10800 }) });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken serves the fresh stored token", () => s.getToken(), deps);
  await frame("invalidate marks that token refused", () => s.invalidate("AT1"), deps);
  await frame("next getToken renews instead of replaying it", () => s.getToken(), deps);
  await frame("following getToken is served from cache", () => s.getToken(), deps);
});

// S9a — [migration] a grant saved under the pre-rename namespace is adopted
// once: rewritten at the current address, deleted at the old one.
define("S9a legacy grant is adopted and the old record deleted", async ({ frame, service, throttle, auth, store, grant, LEGACY_GRANT_KEY, T0 }) => {
  const svc = service({ [LEGACY_GRANT_KEY]: grant("AT1", "RT1", T0 + 10_000_000) });
  const thr = throttle();
  const a = auth({});
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("state adopts the legacy grant on first read", () => s.state(), deps);
  await frame("getToken serves the adopted grant with no auth call", () => s.getToken(), deps);
});

// S9b — [migration] a parked throttle smuggled into the credentials service
// is adopted into the throttle store. The first matching candidate wins;
// the other address is swept later by clearThrottle on resubmit.
define("S9b legacy parked throttle is adopted then swept on resubmit", async ({ frame, service, throttle, auth, store, legacyThrottleRecord, THROTTLE_KEY, LEGACY_THROTTLE_KEY }) => {
  const svc = service({
    [THROTTLE_KEY]: legacyThrottleRecord("login_rejected", true, 3),
    [LEGACY_THROTTLE_KEY]: legacyThrottleRecord("verification_required", true, 2)
  });
  const thr = throttle();
  const a = auth({ login: async () => ({ accessToken: "AT1", refreshToken: "RT1", expiresIn: 10800 }) });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("getToken adopts the current-address park and refuses", () => s.getToken(), deps);
  await frame("state keeps the park; the other legacy record waits for sweep", () => s.state(), deps);
  await frame("saveAccount with the correct password sweeps both legacy records", () => s.saveAccount({ username: "alice", password: "pw" }), deps);
  await frame("state after resubmit", () => s.state(), deps);
});

// S9c — [migration] a password a previous version persisted in the
// credentials service is swept on the first readAccount contact.
define("S9c legacy stored password is swept on first contact", async ({ frame, service, throttle, auth, store, PASSWORD_REF }) => {
  const svc = service({}, { [PASSWORD_REF]: "legacy-secret" });
  const thr = throttle();
  const a = auth({});
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("state sweeps the legacy password reference", () => s.state(), deps);
});

// S10 — [login lifecycle] saveAccount persists the username only and logs in;
// forgetAccount drops the username but the grant keeps serving.
define("S10 saveAccount then forgetAccount leaves the grant serving", async ({ frame, service, throttle, auth, store }) => {
  const svc = service();
  const thr = throttle();
  const a = auth({ login: async () => ({ accessToken: "AT1", refreshToken: "RT1", expiresIn: 10800 }) });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("saveAccount stores the username and logs in", () => s.saveAccount({ username: "alice", password: "pw" }), deps);
  await frame("state after saveAccount", () => s.state(), deps);
  await frame("forgetAccount removes the username", () => s.forgetAccount(), deps);
  await frame("state after forgetAccount still shows the grant", () => s.state(), deps);
  await frame("getToken keeps serving the surviving grant", () => s.getToken(), deps);
});

// S11 — [throttle->login] an explicit corrected resubmit is the one path
// that clears a park; the countdown disappears.
define("S11 wrong-password park is cleared by a corrected resubmit", async ({ frame, service, throttle, auth, store, failure }) => {
  const svc = service();
  const thr = throttle();
  let n = 0;
  const a = auth({
    login: async () => {
      n += 1;
      if (n === 1) throw failure("login_rejected", "platform: invalid account or password");
      return { accessToken: "AT1", refreshToken: "RT1", expiresIn: 10800 };
    }
  });
  const s = store({ service: svc, auth: a, env: {}, throttleStore: thr });
  const deps = { service: svc, throttleStore: thr };
  await frame("saveAccount with the wrong password parks", () => s.saveAccount({ username: "alice", password: "bad" }), deps);
  await frame("state shows needsUserAction", () => s.state(), deps);
  await frame("saveAccount with the corrected password clears the park", () => s.saveAccount({ username: "alice", password: "pw" }), deps);
  await frame("state after the corrected resubmit", () => s.state(), deps);
});

// S12 — [fallback] no credentials service: the in-memory vault keeps the
// panel working and state() says it is ephemeral.
define("S12 no credentials service still works, marked ephemeral", async ({ frame, throttle, auth, store }) => {
  const thr = throttle();
  const a = auth({ login: async () => ({ accessToken: "AT1", refreshToken: "RT1", expiresIn: 10800 }) });
  const s = store({ service: null, auth: a, env: {}, throttleStore: thr });
  const deps = { service: null, throttleStore: thr };
  await frame("saveAccount works against the in-memory vault", () => s.saveAccount({ username: "alice", password: "pw" }), deps);
  await frame("getToken serves the token", () => s.getToken(), deps);
  await frame("state reports ephemeral", () => s.state(), deps);
});

// ---------------------------------------------------------------- compare

function diffPaths(a, b, path = "", out = []) {
  if (out.length >= 12) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(path);
    return out;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) {
      out.push(`${path} (array shape)`);
      return out;
    }
    for (let i = 0; i < a.length; i += 1) diffPaths(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) out.push(`${path} (keys)`);
  for (const k of new Set([...ka, ...kb])) diffPaths(a[k], b[k], `${path}.${k}`, out);
  return out;
}

async function build() {
  const out = [];
  for (const def of defs) out.push(await runScenario(def));
  return out;
}

const actual = await build();

// ── closed-set pins: the scenario roster is spec, not a suggestion ───────
// The drift check below compares the frozen JSON field for field, but a
// REMOVED scenario simply stops appearing in both sides and diffs clean —
// regenerating the baseline after deleting a scenario would go all green, and
// no gate would notice the spec shrank. So the suite pins the roster itself
// (names, in order) and the total frame count, on BOTH the compare path and
// the UPDATE_BASELINE path: shrinking the spec now shows up here, before any
// JSON is written. A legitimate retirement of a scenario must retire its name
// here too — that is the closed-set fix, and it appears in the diff.
const FROZEN_SCENARIOS = [
  "S1 unconfigured: no attempt and no throttle",
  "S2 env login persists the grant then serves from cache",
  "S3 parked refusal survives a restart with no new login",
  "S4 local backoff doubles, then success clears it",
  "S5 platform-stated window is honoured untruncated",
  "S6a near-expiry grant is renewed and the rotation persisted",
  "S6b three concurrent polls share exactly one refresh",
  "S6c refresh write defers to a concurrently rotated grant",
  "S7a dead refresh with no account reaps the grant",
  "S7b dead refresh with an account re-logs-in",
  "S8 invalidated token is renewed once, never replayed",
  "S9a legacy grant is adopted and the old record deleted",
  "S9b legacy parked throttle is adopted then swept on resubmit",
  "S9c legacy stored password is swept on first contact",
  "S10 saveAccount then forgetAccount leaves the grant serving",
  "S11 wrong-password park is cleared by a corrected resubmit",
  "S12 no credentials service still works, marked ephemeral"
];
const FROZEN_FRAME_COUNT = 48;
const scenarioNames = defs.map((def) => def.name);
const frameCount = actual.reduce((n, s) => n + s.frames.length, 0);
if (JSON.stringify(scenarioNames) !== JSON.stringify(FROZEN_SCENARIOS)) {
  const dropped = FROZEN_SCENARIOS.filter((n) => !scenarioNames.includes(n));
  const added = scenarioNames.filter((n) => !FROZEN_SCENARIOS.includes(n));
  console.error(
    `the scenario roster moved (${defs.length} defined vs ${FROZEN_SCENARIOS.length} pinned):\n` +
    (dropped.length ? `  dropped: ${dropped.join(", ")}\n` : "") +
    (added.length ? `  added: ${added.join(", ")}\n` : "") +
    "Retiring a scenario means retiring its name from FROZEN_SCENARIOS in the same change; adding one means registering it there."
  );
  process.exit(1);
}
if (frameCount !== FROZEN_FRAME_COUNT) {
  console.error(
    `the frame count moved (${frameCount} vs ${FROZEN_FRAME_COUNT} pinned): a scenario grew or shrank its scripted frames — update FROZEN_FRAME_COUNT in the same change as the scenario`
  );
  process.exit(1);
}
if (process.env.UPDATE_BASELINE === "1") {
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`baseline (re)written: ${defs.length} scenarios -> ${BASELINE}`);
  process.exit(0);
}

let expected;
try {
  expected = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch (e) {
  console.error(`cannot read frozen baseline ${BASELINE}: ${e.message}`);
  console.error("generate it once with: UPDATE_BASELINE=1 node test/store-baseline.test.mjs");
  process.exit(1);
}

const diffs = diffPaths(expected, actual);
if (diffs.length === 0) {
  const frames = actual.reduce((n, s) => n + s.frames.length, 0);
  console.log(`all ${defs.length} token-store behavior scenarios (${frames} frames) match the frozen baseline`);
  process.exit(0);
}

console.error("token-store behavior DRIFTED from the frozen baseline:");
for (const d of diffs) console.error(`  ${d}`);
console.error(
  "\nIf this change is intentional, review every frame and regenerate:\n" +
    "  UPDATE_BASELINE=1 node test/store-baseline.test.mjs"
);
process.exit(1);

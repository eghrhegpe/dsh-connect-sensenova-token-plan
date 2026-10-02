/**
 * The shared context a token store instance runs on — the seam the split
 * around `token-store.ts` stands on.
 *
 * `token-store.ts` is one closure holding four intertwined blocks (grant,
 * account, renewal, throttle) that share seven mutable variables. The split
 * (docs/TOKEN-STORE-SPLIT.md) moves each block into its own module; what they
 * all keep in common is exactly what this file owns:
 *
 *   - `wiring` — the read side: the credentials backend (real service or the
 *     in-memory vault), the keys, the injected clock, env, auth, and the
 *     throttle store. Built once per instance.
 *   - `state` — the seven mutable fields, now named instead of closure-scoped:
 *     `cached`, `rejected`, `inflight`, `lastError`, `throttle`,
 *     `consecutiveRefusals`, `passwordSwept`. Each block writes only its own
 *     fields (the ownership table lives in the split doc §1); every block may
 *     read any field through `state.`.
 *
 * Step 1 of the split: `createStoreContext()` is the one new piece of code in
 * this move. `token-store.ts`'s `createTokenStore` now builds this context and
 * keeps its bodies verbatim against it, so the behavior baseline
 * (`test/store-baseline.test.mjs`) and the 131 live checks stay green —
 * no semantics moved, only the names did.
 *
 * @module dsh-connect-sensenova-token-plan/token-store/state
 */

import { createAuth } from "../sensenova-auth.ts";
import { createMemoryThrottleStore } from "../throttle-store.ts";
import { name as RECORD_SCOPE } from "../host-config.ts";

/**
 * The credential backend the blocks read and write through.
 *
 * Two implementations exist: the real DSH credentials service (resolved per
 * use, so it may register after mount) and the in-memory vault above. The
 * methods are the subset the store actually calls — declared so a block's
 * `backend().readRecord(...)` is not a read off `unknown`.
 */
export interface CredentialBackend {
  readRecord(key: string): Promise<unknown>;
  modifyRecord(key: string, mutate: (current: unknown) => unknown): Promise<unknown>;
  deleteRecord(key: string): Promise<unknown>;
  resolve(ref: string): Promise<{ value?: unknown; source?: string } | undefined>;
  set(ref: string, value: string): Promise<unknown>;
  unset(ref: string): Promise<unknown>;
}

/** The throttle store the blocks persist refusals through (`throttle-store.ts`). */
export interface ThrottleStore {
  read(): Promise<HeldThrottle | null>;
  write(held: HeldThrottle): Promise<unknown>;
  clear(): Promise<unknown>;
}

/** The auth instance (`createAuth()`), as the login/renewal blocks consume it. */
export interface AuthLike {
  login(credentials: { username: string; password: string }, options?: { onTrace?: unknown }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    [key: string]: unknown;
  }>;
  refresh(refreshToken: string, options?: unknown): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    [key: string]: unknown;
  }>;
}

/**
 * The read side of the store context — everything the four blocks may reach.
 *
 * Declared for the same reason as {@link TokenStoreState}: the inferred literal
 * left `credentials` typed as its `null` default and `backend` as a function
 * over `unknown`, which is what pushed `never` into the blocks downstream.
 */
export interface StoreContextWiring {
  credentials?: unknown;
  auth: AuthLike;
  env: Record<string, string | undefined>;
  skewMs: number;
  throttleStore: ThrottleStore;
  now: () => number;
  onTrace?: (hops: unknown[], error: unknown) => void;
  credentialKey: (scope: string, id: string) => string;
  key: string;
  THROTTLE_KEY: string;
  backend: () => CredentialBackend;
  ephemeral: () => boolean;
}

/** Record address: this plugin's own namespace, so a stranger cannot collide. */
const RECORD_ID = "sensenova-console";
const THROTTLE_ID = "sensenova-console-throttle";
const DEFAULT_SKEW_MS = 120_000;

/** The stored grant shape `grant.ts` parses and `acquire` carries. */
export interface StoredGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

/**
 * The refusal a throttle stands for (`throttle.ts` owns the semantics).
 *
 * `until` is `null` for a parked (credential-shaped) refusal: it has no
 * deadline, so there is nothing to count down.
 */
export interface HeldThrottle {
  code: string;
  parked: boolean;
  until: number | null;
  attempt: number;
}

/**
 * The seven mutable fields the four blocks share (see the module doc above).
 *
 * Declared rather than inferred (docs/IMPROVEMENTS.md §8): under
 * strictNullChecks a bare object literal pins each field to its INITIALIZER's
 * type, so `cached: null` became the type `null` and `rejected: new Set()`
 * became `Set<never>` — every reader downstream then saw `never`. The runtime
 * values are unchanged; only the declaration is now explicit.
 */
export interface TokenStoreState {
  /** In-memory token for this process; the record is the durable truth. */
  cached: StoredGrant | null;
  /** Tokens the console has already refused (never handed out again). */
  rejected: Set<string>;
  /** One in-flight acquisition, so N concurrent polls share one login. */
  inflight: Promise<string> | null;
  /** Last failure, surfaced to the panel instead of a bare "not configured". */
  lastError: unknown;
  /** The refusal in force, or `null` when sign-in may be attempted. */
  throttle: HeldThrottle | null;
  /** How many refusals in a row this store has seen (survives the throttle). */
  consecutiveRefusals: number;
  /** True once a legacy stored password has been swept. */
  passwordSwept: boolean;
}

/**
 * Build one store instance's wiring + state.
 *
 * The body of what `createTokenStore` used to do before its first `let`:
 * resolve the throttle store, build the in-memory vault, the service
 * resolver, the backend and the ephemeral check, and the key pair. The
 * defaults and their comments move here unchanged; `token-store.ts` still
 * documents the OPTIONS (they are the public face of the factory).
 *
 * @param {object} options - the same options object `createTokenStore` takes.
 * @returns {{wiring: object, state: object}}
 */
export function createStoreContext({
  credentials,
  auth = createAuth(),
  env = process.env,
  skewMs = DEFAULT_SKEW_MS,
  throttleStore: injectedThrottleStore,
  now = Date.now,
  onTrace,
  credentialKey
}: {
  credentials?: unknown;
  auth?: AuthLike;
  env?: Record<string, string | undefined>;
  skewMs?: number;
  throttleStore?: ThrottleStore;
  now?: () => number;
  onTrace?: (hops: unknown[], error: unknown) => void;
  credentialKey: (scope: string, id: string) => string;
}): { wiring: StoreContextWiring; state: TokenStoreState } {
  const key = credentialKey(RECORD_SCOPE, RECORD_ID);
  const THROTTLE_KEY = credentialKey(RECORD_SCOPE, THROTTLE_ID);
  // Resolved here rather than as a parameter default, for two reasons.
  //
  // It has to judge its window with the clock the rest of the store uses: a
  // store given an injected clock and a throttle reading the real one would
  // disagree about whether a wait is over, which is invisible in production
  // and fatal in a test that crosses the window deliberately.
  //
  // And it defaults to MEMORY, not to the file. The file is shared and
  // durable, so a default that writes it makes every store in the process
  // share one throttle — in a test suite that means one case's lockout
  // refuses the next case's login, which reads as a bug in the code under
  // test. The Host passes the file store explicitly (see `index.ts`, where the
  // wiring is assembled), so a production store shares one throttle record.
  const throttleStore = injectedThrottleStore ?? createMemoryThrottleStore(now);
  /**
   * The in-memory fallback used while no credentials service is reachable. A
   * Host without the service still gets a working panel: the account and grant
   * live here, which is exactly as private as the real store and simply does
   * not outlive the process.
   */
  const memory = {
    records: new Map(),
    account: new Map(),
    async readRecord(k: string) { return this.records.get(k); },
    async modifyRecord(k: string, mutate: (current: unknown) => unknown) {
      const next = await mutate(this.records.get(k));
      if (next === undefined) return this.records.get(k);
      this.records.set(k, next);
      return next;
    },
    // Keyed, because the throttle is a second record: clearing one throttle
    // must not take a stored grant with it.
    async deleteRecord(k: string) { this.records.delete(k); },
    async resolve(ref: string) {
      const value = this.account.get(ref);
      return typeof value === "string" && value !== "" ? { value, source: "memory" } : undefined;
    },
    async set(ref: string, value: string) { this.account.set(ref, value); },
    async unset(ref: string) { this.account.delete(ref); }
  };
  /**
   * Resolve the credentials service on EVERY use, not once at mount: the
   * service may register after this plugin loads, and a flag frozen at mount
   * would then claim "no credentials service" forever while the store quietly
   * exists on disk. Accepts the service itself (tests) or a resolver function
   * (production, where the service is looked up per use) and normalises
   * anything absent to `null`.
   */
  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };
  /** The live backend: the real service when attached, else the in-memory vault. */
  const backend = () => resolveService() ?? memory;
  /** True while nothing written through the store would survive a restart. */
  const ephemeral = () => resolveService() === null;

  const wiring = {
    credentials,
    auth,
    env,
    skewMs,
    throttleStore,
    now,
    onTrace,
    credentialKey,
    key,
    THROTTLE_KEY,
    backend,
    ephemeral
  };

  const state: TokenStoreState = {
    /** In-memory token for this process; the record is the durable truth. */
    cached: null,
    /**
     * Tokens the console has already rejected.
     *
     * A 401 does not prove the token expired — it proves the console refused it —
     * so a rejected token must never be handed out again even while its `exp`
     * still looks valid. Without this the store would re-read the same record
     * and replay the token the console just refused.
     */
    rejected: new Set(),
    /** One in-flight acquisition, so N concurrent polls share one login. */
    inflight: null,
    /** Last failure, surfaced to the panel instead of a bare "not configured". */
    lastError: null,
    /**
     * A refusal that must not be repeated on a timer.
     *
     * The platform locks an account after a few bad attempts, so retrying a
     * failed sign-in automatically turns one mistake into a lockout. This records
     * why sign-in is pointless right now and until when.
     *
     * `until` is the absolute deadline when the platform names one ("try again
     * in 8 minutes"); otherwise a local backoff applies, doubling per attempt up
     * to a cap. `parked` marks a credential-shaped refusal, which has no
     * deadline at all: waiting cannot make a wrong password right.
     */
    throttle: null,
    /**
     * How many refusals in a row this store has seen.
     *
     * Kept separately from `throttle` because the throttle record is deleted as
     * soon as its window closes, while this count must survive that deletion —
     * otherwise the doubling has nothing to double from and every wait restarts
     * at the shortest one.
     */
    consecutiveRefusals: 0,
    /** True once a legacy stored password has been swept from the credentials service. */
    passwordSwept: false
  };

  return { wiring, state };
}

/**
 * Shared READ-side scaffolding for the four per-profile switch stores
 * (`provider-store`, `draw-store`, `raccoon-switch-store`, `raccoon-web-store`).
 *
 * The WRITE side was already converged into `state-store.ts`'s
 * `createVersionedJsonWriter` (ADR-006): four line-identical write closures became
 * one factory. This is the matching READ side — the state directory, the one-shot
 * legacy inheritance, the version-gated parse, and the short-TTL read cache — which
 * the four stores had re-typed in parallel. A fix to any of those primitives now
 * applies to all four instead of drifting per file.
 *
 * What stays in each store: its payload normalisation (`normalize`) and its public
 * method surface (the accessors differ per store — `enabled()`, `modelId()`,
 * `enabledIds()`, ...). What moves here: everything that was identical, plus the
 * single shared on/off normaliser.
 *
 * peer-free like the write factory: `createSwitchStore` imports no Host peer; the
 * ADR-006 refusal is wired to the host's `degrade` the way the four stores did it
 * before — one `onRefuse` line here instead of four.
 *
 * @module dsh-connect-sensenova-token-plan/switch-store
 */
import { degrade } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import {
  readStateJson,
  createStateReadCache,
  createVersionedJsonWriter,
  STATE_READ_TTL_MS,
  profileStateDir,
  stateDir as sharedStateDir,
} from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/**
 * The one on/off answer every switch store reads the same way: only a real
 * boolean is an answer; anything else reads as "not set". This was copied into
 * four files under four names (provider / draw / raccoon-switch / raccoon-web —
 * each `typeof raw === "boolean" ? raw : null`), which is exactly the "half a
 * rule, drifted" shape PITFALLS §36 warns about. Now one function; each store
 * re-exports it under its historical name.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeSwitchEnabled(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/** The shared plumbing a switch store hands to its per-store methods. */
export interface SwitchStoreBase<T> {
  /** The parsed record, or `null` when nothing is set. */
  read(): Promise<T | null>;
  /** Remember a just-written value (visible to this process without waiting out the TTL). */
  remember(value: T | null): void;
  /** Atomically persist a full payload; `null` = landed, `string` = the ADR-006 refusal. */
  writePayload(payload: object): Promise<string | null>;
  /** The current shape version. */
  readonly version: number;
}

export interface SwitchStoreConfig<T> {
  /** ADR-006 write-side guard label ("provider" / "draw" / "raccoon-switch" / "raccoon-web-switch"). */
  label: string;
  /** The state file name ("provider.json", ...). */
  file: string;
  /** Current shape version, bumped when the persisted form changes incompatibly. */
  version: number;
  /** Every persisted shape this build reads (the ADR-006 write-side whitelist). */
  knownVersions: readonly number[];
  /** Parse one raw payload into the record, or `null` when unrecognised / version-mismatch. */
  normalize: (raw: unknown) => T | null;
  /** The payload to backfill when the one-shot legacy inheritance adopts a value. */
  writeInherited: (value: T) => object;
  /** Whether a shared-directory legacy file exists and should be inherited (PITFALLS §23). */
  hasLegacy?: boolean;
}

/**
 * Build the shared read-side scaffolding for one switch store: the state
 * directory + file path, the ADR-006 version-guarded atomic writer, the one-shot
 * legacy inheritance, and the short-TTL read cache. The store keeps only its own
 * payload normalisation and method surface on top of what this returns.
 * @param {SwitchStoreConfig<T>} config - what makes this switch its own.
 * @param {StoreOptions} [options] - {@link StoreOptions}; `dir`/`profile`/`ttlMs`/`logger`.
 * @returns {SwitchStoreBase<T>} the plumbing the store's methods wrap.
 */
export function createSwitchStore<T>(config: SwitchStoreConfig<T>, options: StoreOptions = {}): SwitchStoreBase<T> {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = dir ?? profileStateDir(name, profile);
  const filePath = join(stateDir, config.file);

  // ADR-006 write-side guard (refuse an unknown on-disk version) + the 0600
  // temp-file atomic write, both in `createVersionedJsonWriter`. A refusal
  // surfaces through the host's `degrade` — one wiring line here instead of the
  // four identical ones the stores carried.
  const writePayload = createVersionedJsonWriter({
    file: filePath,
    versions: config.knownVersions,
    label: config.label,
    onRefuse: (reason) => degrade(reason, null, logger, null),
  });

  // Pre-§23 machines kept this switch in the SHARED directory. A profile-scoped
  // store inherits it once, when its own file is missing — an explicit `dir`
  // (the tests) was never part of the shared layout, so it never inherits.
  const legacyFile = config.hasLegacy === true && dir === undefined && profile
    ? join(sharedStateDir(name), config.file)
    : null;

  // Short-TTL read cache, shared across the switches and the catalog
  // (`state-store.ts`): "someone else edited this file" must become visible here
  // within a tick, not after a restart — but one poll must not re-read the file
  // for every question it asks. Absent / unreadable / non-JSON reads as `null`.
  const parse = (raw: unknown) => config.normalize(raw);
  const cache = createStateReadCache(async () => parse(await readStateJson(filePath)), {
    ttlMs,
    inheritFrom: legacyFile === null ? null : {
      read: async () => parse(await readStateJson(legacyFile)),
      write: async (value) => {
        await writePayload(config.writeInherited(value));
      },
    },
  });

  return {
    read: () => cache.read(),
    remember: (value) => cache.remember(value),
    writePayload: async (payload) => writePayload(payload),
    version: config.version,
  };
}

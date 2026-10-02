/**
 * Shared structural types for the Host half.
 *
 * The Host wires its modules together with an injected dependency object
 * (`HostDeps`). That object is built once in `index.ts` from the Cordis
 * context and passed down; the runtime fields are many and come from peers
 * that ship no `.d.ts`, so the single source of truth for "what a dep may
 * carry" lives here rather than in per-file `{}` placeholders (which TS
 * reads as an empty object and then rejects every field access on).
 * @module dsh-connect-sensenova-token-plan/types
 */

/** A failure code this plugin can produce or carry (a `CODE` wire value). */
export type CodeValue = string;

/**
 * The dependency bag injected into the Host modules. Every field is optional:
 * each consumer falls back to a local default when a field is absent, so a
 * module keeps working even if `index.ts` does not wire a given capability.
 * Peer-typed members (`logger`, `emit`, …) use loose types because the
 * matching `@deepseek-ai/*` packages ship no declarations in this repo.
 */
export interface HostDeps {
  /** Resolved plugin settings object. */
  settings?: any;
  /** Toggle that flips the sidebar panel on/off from the Host. */
  panelSwitch?: any;
  /** Lazy-load the LLM adapter module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: any;
  /** Lazy-load the Raccoon LLM adapter module (ROADMAP §6.1 second provider). */
  loadRaccoonAdapterModule?: any;
  /** Resolve the registered LLM instance. */
  getLlm?: any;
  /** Resolve the API key from the credentials service. */
  resolveApiKey?: any;
  /** Cordis event emitter. */
  emit?: (...args: any[]) => void;
  /** Cordis logger (loose: peer has no declarations here). */
  logger?: any;
  /** Lazy-load the tools module. */
  loadToolsModule?: any;
  /** Host webserver fetch used by the draw route. */
  drawFetch?: (...args: any[]) => Promise<any>;
  /** Login-trace sink used by the auth half. */
  onTrace?: (...args: any[]) => void;
  /** The resolved credential record. */
  credential?: any;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** JWKS endpoint override. */
  jwksEndpoint?: string;
  /** Encryption key id used by the JWE sealer. */
  encKeyId?: string;
  /** Base URL override for the LLM adapter / provider config. */
  baseUrl?: string;
  /** Shared JWKS cache. */
  cache?: any;
  /** Max redirect hops for the login trace. */
  maxHops?: number;
  /** Login request timeout in milliseconds (config alias). */
  requestTimeoutMs?: number;
}

/** Options every file-backed store accepts. */
export interface StoreOptions {
  /** Profile key; stores are segmented per profile. */
  profile?: string | null;
  /** Clock override for tests. */
  now?: () => number;
  /** Idle entry TTL in milliseconds. */
  ttlMs?: number;
  /** Directory the store persists into. */
  dir?: string;
}

/** A draw (image generation) request body. */
export interface DrawRequest {
  model: string;
  prompt: string;
  n: number;
  size: string;
  responseFormat: string;
  outputFormat: string;
  watermark: boolean;
}

/** A provider/adapter configuration object. */
export interface AdapterConfig {
  providerId?: string;
  enabledIds?: string[];
  unavailableModelIds?: string[];
  baseUrl?: string;
}

/** Options for the JWKS cache / JWE sealer. */
export interface JwksOptions {
  /** A caller-owned key-set cache; typed loosely (see createJwksCache). */
  cache?: any;
  jwksEndpoint?: string;
  encKeyId?: string;
  timeoutMs?: number;
}

/** Dependency bag for the Raccoon credential store (`raccoon-store.ts`). */
export interface RaccoonStoreDeps {
  /** The `ctx.credentials` service, a resolver, or `null` (resolved on every use). */
  credentials?: any;
  /** Injected fetch for the refresh call (tests stub it; defaults to global fetch). */
  fetcher?: typeof fetch;
}

/** Dependency bag for the Raccoon provider publisher (`raccoon-publish.ts`). */
export interface RaccoonPublisherDeps {
  /** Panel-saved switch value; `null` = state file untouched (provider stays OFF). */
  panelSwitch?: () => Promise<boolean | null>;
  /** Resolve the live Raccoon JWT per request (empty when not logged in). */
  resolveToken?: () => Promise<string>;
  /** Optional-service resolver for the `llm` registration service. */
  getLlm?: (service: string) => any;
  /** Lazy-load the Raccoon adapter factory module (peer `dsh-llm-pi-ai`). */
  loadAdapterModule?: () => Promise<{ createRaccoonAdapter: (...args: any[]) => any }>;
  /** Cordis event emitter for `llm/adapters-updated`. */
  emit?: (event: string) => void;
  /** Cordis logger (loose: the peer ships no declarations here). */
  logger?: { warn: (message: string) => void };
}

/** Options for the Raccoon adapter factory (`raccoon-llm-adapter.ts`). */
export interface RaccoonAdapterOptions {
  /** The roster rows to offer (`raccoonRoster` result). */
  rows?: any[];
  /** The credential's office identity (`""` for a personal account). */
  officeIdentity?: string;
  /**
   * Resolve the live Raccoon JWT per request (refreshes inside the expiry window first).
   *
   * REQUIRED, not optional: an adapter without a token resolver can never serve
   * a request — `assemblePiAiAdapter` calls it on every call. `createSensenovaAdapter`
   * requires `resolveApiKey` for the same reason (docs/IMPROVEMENTS.md §8).
   */
  resolveToken: () => Promise<string>;
  /** Service resolver for the image hooks (`attachments`, `fs`). */
  get?: (service: string) => any;
}

/**
 * An `Error` with the stable `code` the panel branches on, plus optional
 * structured fields. The fields are attached at runtime (not inherited), so
 * this is a structural annotation: a `catch (e)` downstream may read `e.code`.
 */
export interface PluginError extends Error {
  code?: CodeValue;
  retryAfterMs?: number;
  detail?: unknown;
  trace?: unknown[];
}

/**
 * The wiring bag `index.ts` assembles once at mount and hands to the route
 * handlers (`routes.ts`). It is the single seam that decides what a route may
 * touch: every service a handler reaches for is listed here, so a route that
 * needs a new dependency gets it through the wiring, never by importing the
 * service directly.
 *
 * The stores / publishers / caches are opaque injected objects (the DSH peers
 * ship no declarations in this repo), so they are typed loosely — the shape is
 * pinned by the creators (`createFile*Store`, `createProviderPublisher`, …)
 * and by the tests, not by this annotation. A new field must keep the "one
 * seam" discipline: add it here, wire it in `index.ts`, and read it through.
 */
export interface Wiring {
  /** The resolved settings row (panel values + config defaults). */
  settings: any;
  /** A settings/auth misconfiguration surfaced through the snapshot; `null` when clean. */
  configError: string | null;
  /** The console-response cache shared across polls. */
  cache: Map<string, any>;
  /** The single-flight map shared across polls. */
  inflight: Map<string, any>;
  /** The token store (`createTokenStore`). */
  tokenStore: any;
  /** The inference API-key store (`createApiKeyStore`). */
  apiKeyStore: any;
  /** The model-catalog store (`createFileCatalogStore`). */
  catalogStore: any;
  /** The provider switch store (`createFileProviderStore`). */
  providerStore: any;
  /** The draw-tool store (`createFileDrawStore`); may be absent on some Hosts. */
  drawStore: any | null;
  /** The directly-registered provider publisher (`createProviderPublisher`). */
  publisher: any;
  /** The publisher's live registration state (shared reference). */
  providerState: any;
  /** `(entries, enabledIds, unavailableIds) => publisher.publish` with rollback. */
  publishProvider: (entries: any[], enabledIds: string[], unavailableModelIds?: string[]) => Promise<any>;
  /** Release the registered provider pair (adapter + directory). */
  releaseProvider: () => void;
  /** Resolve the live `sk-` key per request. */
  resolveApiKey: () => Promise<string>;
  /** The settings-row vision writer filled by `startSideEffects` (no-op until then). */
  visionPublish: { current: ((models: any[], ids: string[]) => Promise<any>) | null };
  /** `ctx.logger` (Host logging); optional so tests may omit it. */
  logger?: any;
  /** The Raccoon credential store (`createRaccoonStore`); the second upstream. */
  raccoonStore: any | null;
  /** The Raccoon switch store (`createFileRaccoonStore`); may be absent. */
  raccoonSwitch: any | null;
  /** The Raccoon publisher (`createRaccoonPublisher`); may be absent. */
  raccoonPublisher: any | null;
  /** The Raccoon gateway read cache (balance + catalogue); may be absent. */
  raccoonCache: any | null;
}

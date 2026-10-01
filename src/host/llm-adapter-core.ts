/**
 * The shared `PiAiAdapter` assembly both upstreams use.
 *
 * The two adapters (`llm-adapter.ts` for the Token Plan provider,
 * `raccoon-llm-adapter.ts` for the Raccoon one) were written as copies: same
 * inert pi-ai auth plane, same profile row, same `PiAiAdapter` wiring, same
 * stream-reclassification Proxy. That is assembly against the runtime peers,
 * not domain logic — a difference between the two copies buys nothing and
 * costs a fix twice (the 429 misclassification layer is a correction, and
 * every correction must reach both routes or one of them silently stops
 * retrying).
 *
 * What stays in each adapter: the descriptor build (each upstream maps its
 * own roster/catalog) and the credential resolver each route reads.
 *
 * Peer-dependent: imports `pi-ai` / `dsh-llm` / `dsh-llm-pi-ai`, which ship
 * inside the Host. Like the adapters themselves, it cannot be imported by the
 * offline unit suite and is exercised by the wiring/e2e checks.
 *
 * @module dsh-connect-sensenova-token-plan/llm-adapter-core
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { name as pluginName } from "./host-config.ts";
import { buildRetryPolicyConfig } from "./llm-retry.ts";
import { reclassifyStream } from "./llm-error-fix.ts";

/** Idle ceiling while one stream read is outstanding (dsh-llm-pi-ai default). */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Pixel budget at the `dsh-llm-pi-ai` default (the Token Plan provider). */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304;

/** The `fs` service face the image hook reads — a single host-path mapper. */
type FsService = { processPathFromHostPath?: (hostPath: string) => unknown };

/**
 * Image budgets at the `dsh-llm-pi-ai` defaults, with the pixel budget
 * overridable: the Raccoon gateway caps a request body near 10 MB, so there
 * the per-image byte ceiling binds instead and the pixel budget is lowered to
 * keep an image inside it.
 * @param {number} [requestImagePixelBudget] - override for the pixel budget.
 * @returns {{maxRequestImageBytes: number, requestImagePixelBudget: number,
 *   requestImageMaxBytes: number}} the profile's image budget row.
 */
export function imageBudgets(requestImagePixelBudget = DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET) {
  return {
    maxRequestImageBytes: 20_971_520,
    requestImagePixelBudget,
    requestImageMaxBytes: 1_048_576
  };
}

/**
 * Inert pi-ai auth plane.
 *
 * Authentication goes through the credential resolver each route supplies
 * (the stored `SENSENOVA_API_KEY` reference, or the stored Raccoon JWT), read
 * per request. pi-ai's own credential lifecycle must never manufacture a
 * credential for these routes, so every ambient question answers "nothing
 * stored, nothing set".
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    // Deliberately a no-op, not a throw: pi-ai may call `modify` as an
    // optional "persist the latest credential" hook during a normal request,
    // and an exception there would 500 a conversation that is otherwise
    // working. The credential lifecycle for these routes lives in the plugin's
    // own stores (`api-key-store.ts`, `raccoon-store.ts`), not here.
    async modify() {},
    async delete() {}
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    }
  }
};

/**
 * Wrap an adapter so both stream exits reclassify a misjudged 429.
 *
 * The peer's `classifyPiAiError` can read a "budget/credits" worded 429 as
 * QUOTA (which is not retried); this layer corrects such a body back to
 * RATE_LIMIT before the stream leaves, so the backoff in `llm-retry.ts`
 * actually fires. Only the stream exits are intercepted — no peer internals
 * are touched and no ordinary data chunk is altered. See `llm-error-fix.ts`.
 * @param {object} inner - the `PiAiAdapter` to wrap.
 * @returns {object} the wrapped adapter.
 */
function withReclassifiedStream(inner) {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // `stream(...)` and `prepareCall(...).stream` both return an async
      // iterable; both are wrapped here. Everything else (image,
      // resolveApiKey, …) passes through untouched.
      if (prop === "stream") {
        return (options) => reclassifyStream(target.stream(options));
      }
      if (typeof value === "function" && prop === "prepareCall") {
        return (...args) => {
          const prepared = value.apply(target, args);
          if (prepared && typeof prepared.then === "function") {
            return prepared.then((p) => p && typeof p.stream === "function"
              ? { ...p, stream: (o) => reclassifyStream(p.stream(o)) }
              : p);
          }
          return prepared && typeof prepared.stream === "function"
            ? { ...prepared, stream: (o) => reclassifyStream(prepared.stream(o)) }
            : prepared;
        };
      }
      return value;
    }
  });
}

/**
 * What one upstream contributes to the shared assembly — everything the two
 * routes differ on, and nothing they share.
 */
export interface PiAiAdapterParts {
  /** The id this adapter owns. */
  providerId: string;
  /** The picker row's display name. */
  displayName: string;
  /** The name pi-ai shows for the credential. */
  apiKeyName: string;
  /** The built descriptors to offer. */
  models: object[];
  /** Reads the live credential per request. */
  resolveCredential: () => Promise<string>;
  /** Service resolver for the image hooks (`attachments`, `fs`). */
  get?: (service: string) => unknown;
  /** The profile's pinned reasoning effort. */
  reasoning?: string;
  /** Override for the pixel budget (`imageBudgets`). */
  requestImagePixelBudget?: number;
}

/**
 * Assemble one provider's adapter: the pi-ai provider, its single profile
 * row, and the `PiAiAdapter` carrying them.
 *
 * A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
 * profiles snapshot internally, so the caller REPLACES the registered adapter
 * when the catalog or credential changes and emits `llm/adapters-updated`.
 * @param {PiAiAdapterParts} options - the per-upstream facts.
 * @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
 *   it owns.
 */
export function assemblePiAiAdapter({
  providerId,
  displayName,
  apiKeyName,
  models,
  resolveCredential,
  get,
  reasoning,
  requestImagePixelBudget
}: PiAiAdapterParts) {
  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: apiKeyName,
          /**
           * pi-ai hands the credential it resolved; these routes store none,
           * so the parameter is typed only to name what is read off it.
           * @param {{credential?: {key?: string}}} [options]
           */
          async resolve({ credential }: { credential?: { key?: string } } = {}) {
            const key = credential?.key;
            return key === undefined || key.length === 0
              ? undefined
              : { auth: { apiKey: key }, source: displayName };
          }
        }
      },
      models,
      api: openAICompletionsApi()
    }),
    // The adapter's resolver re-reads the provider to discover its models;
    // returning the immutable descriptor set this build was registered with.
    getModels: () => models
  };

  const profiles = new Map([
    [
      providerId,
      {
        provider: providerId,
        displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        // Quota-aware retry policy: explicit (not `undefined`) so a future peer
        // default change cannot silently alter this provider. Excludes the quota
        // codes (a depleted pool cannot be retried into health; see
        // `llm-retry.ts`), keeps `RATE_LIMIT` with a gentle shared-pool backoff.
        retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${pluginName}.${providerId}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...imageBudgets(requestImagePixelBudget),
        piProvider: provider
      }
    ]
  ]);

  const inner = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // The stored credential reference is the only one this route presents; it
    // is read per request, so rotating it needs no re-registration.
    resolveApiKey: async () => resolveCredential(),
    // Image input is a hard requirement of pi-ai, not an optional extra:
    // `streamWithSnapshot` throws UNSUPPORTED_CONTENT whenever a message
    // carries an image and `resolveAttachments()` yields undefined. Both hooks
    // are wired the same way the official `llm-pi-ai` plugin wires them.
    resolveAttachments: () => get?.("attachments"),
    // Resolved lazily through `get("fs")` because the service may register
    // after this adapter is built.
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => (get?.("fs") as FsService | undefined)?.processPathFromHostPath?.(hostPath),
        ref
      )
  });

  return { adapter: withReclassifiedStream(inner), providerIds: [providerId] };
}

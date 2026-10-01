/**
 * The peer-dependent half of the directly-registered Raccoon provider —
 * "second upstream provider" (ROADMAP §6.1).
 *
 * Mirrors `llm-adapter.ts`'s shape: ONE `PiAiAdapter` carrying ONE profile
 * (`sensenova-raccoon` → `https://xiaohuanxiong.com/api/web/llm/v2`), an
 * INERT pi-ai auth plane (the Raccoon JWT is resolved per request from the
 * plugin's own credential store, pi-ai never manufactures it), both IMAGE
 * hooks wired (a vision model that receives an image answers
 * `UNSUPPORTED_CONTENT` otherwise), and no token baked into the profile —
 * the picker advertises models without one and a request fails at resolve
 * time, where the panel status is visible.
 *
 * The descriptor mapping lives in the peer-free `raccoon-models.ts`, so this
 * module holds only assembly against the runtime and is exercised by the
 * wiring/e2e checks, exactly as `llm-adapter.ts` is.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-llm-adapter
 */
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveRetryPolicy, resolveImageAttachmentAccess } from "@deepseek-ai/dsh-llm";
import { name } from "./host-config.ts";
import { RACCOON_DISPLAY_NAME, RACCOON_PROVIDER_ID, buildRaccoonDescriptors, raccoonRoster } from "./raccoon-models.ts";
import { buildRetryPolicyConfig } from "./llm-retry.ts";
import { reclassifyStream } from "./llm-error-fix.ts";
import type { RaccoonAdapterOptions } from "./types.ts";

/** Idle ceiling while one stream read is outstanding (dsh-llm-pi-ai default). */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

/**
 * Image budgets at the dsh-llm-pi-ai defaults. The Raccoon gateway caps one
 * request body at ~10 MB (`HTTP_413`), so the per-image byte ceiling is the
 * binding constraint; the pixel budget keeps an image inside it.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 640_000,
  requestImageMaxBytes: 1_048_576
};

/**
 * Inert pi-ai auth plane.
 *
 * Authentication goes through `resolveToken` (the stored Raccoon JWT, read
 * per request from `raccoon-store.ts`) — pi-ai's own credential lifecycle
 * must never manufacture a credential for this route, so every ambient
 * question answers "nothing stored, nothing set".
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
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
 * Assemble the Raccoon adapter for one credential/catalogue snapshot.
 *
 * A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
 * profiles snapshot internally, so the caller REPLACES the registered
 * adapter when the credential or catalogue changes and emits
 * `llm/adapters-updated`.
 * @param {object} options - wiring.
 * @param {object[]} [options.rows] - the Raccoon roster rows (`raccoonRoster`).
 * @param {object} [options.officeIdentity] - the credential's `office_identity`
 *   (`""` for a personal account) — feeds the per-request headers.
 * @param {() => Promise<string>} options.resolveToken - resolves the live Raccoon
 *   JWT per request (refreshes inside the expiry window first).
 * @param {(service: string) => unknown} [options.get] - service resolver for
 *   the image hooks (`attachments`, `fs`).
 * @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
 *   it owns.
 */
export function createRaccoonAdapter({
  rows,
  officeIdentity = "",
  resolveToken,
  get
}: RaccoonAdapterOptions = {}) {
  const models = buildRaccoonDescriptors(rows ?? raccoonRoster(null), { officeIdentity });

  const provider = {
    ...createProvider({
      id: RACCOON_PROVIDER_ID,
      name: RACCOON_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: "Raccoon access token",
          async resolve({ credential }: { credential?: { key?: string } } = {}) {
            const token = credential?.key;
            return token === undefined || token === ""
              ? undefined
              : { auth: { apiKey: token }, source: RACCOON_DISPLAY_NAME };
          }
        }
      },
      models,
      api: openAICompletionsApi()
    }),
    getModels: () => models
  };

  const profiles = new Map([
    [
      RACCOON_PROVIDER_ID,
      {
        provider: RACCOON_PROVIDER_ID,
        displayName: RACCOON_DISPLAY_NAME,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${RACCOON_PROVIDER_ID}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider
      }
    ]
  ]);

  const inner = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => resolveToken(),
    resolveAttachments: () => get?.("attachments"),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => /** @type {unknown} */ (get?.("fs"))?.processPathFromHostPath?.(hostPath),
        ref
      )
  });

  // The same 429-misclassification correction layer `llm-adapter.ts` applies
  // (a "budget/credits" worded 429 is reclassified to RATE_LIMIT so the
  // retry backoff actually fires). It is provider-agnostic.
  const adapter = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
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

  return { adapter, providerIds: [RACCOON_PROVIDER_ID] };
}

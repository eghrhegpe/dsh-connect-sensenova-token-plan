/**
 * The peer-dependent half of the directly-registered SenseNova provider.
 *
 * Everything here runs against Host-shipped peers (`pi-ai`, `dsh-llm`,
 * `dsh-llm-pi-ai`), which is exactly why the descriptor mapping lives in the
 * peer-free `llm-models.ts` instead: this module cannot be imported by the
 * offline unit suite, so it holds only assembly against the runtime and is
 * exercised in wiring/e2e checks.
 *
 * The shape mirrors the qoder adapter that is known to work:
 *
 * - ONE `PiAiAdapter` carrying one profile (this provider has one region —
 *   `https://token.sensenova.cn/v1`);
 * - an INERT pi-ai auth plane — the key is resolved per request from the
 *   plugin's own store, pi-ai must never manufacture a credential;
 * - both IMAGE hooks wired, or an image-accepting model answers
 *   `UNSUPPORTED_CONTENT` the moment a message carries an image;
 * - no API key baked into the profile: the picker advertises models without
 *   one and a request fails at resolve time, where the panel status is visible.
 *
 * The assembly is shared with the Raccoon adapter (`llm-adapter-core.ts`) —
 * what THIS provider contributes is its descriptor build, its credential
 * resolver, and the reasoning effort its profile pins.
 *
 * @module dsh-connect-sensenova-token-plan/llm-adapter
 */
import { buildDescriptors, LLM_PROVIDER_ID, LLM_DISPLAY_NAME, DEFAULT_REASONING_EFFORT } from "./llm-models.ts";
import { assemblePiAiAdapter } from "./llm-adapter-core.ts";

/**
 * Assemble the adapter instance for one catalog snapshot.
 *
 * A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
 * profiles snapshot internally (`if (this.snapshot?.profiles === profiles)`),
 * so the caller REPLACES the registered adapter when the catalog or key changes
 * and emits `llm/adapters-updated`, exactly as the qoder route refreshes its
 * own registration.
 * @param {object} options - wiring.
 * @param {object[]} options.entries - the normalized catalog entries.
 * @param {string[]} [options.enabledIds] - the curated allow-list; empty means
 *   every catalog model is offered.
 * @param {string} options.baseUrl - the OpenAI-compatible base URL.
 * @param {() => Promise<string>} options.resolveApiKey - resolves the live
 *   `sk-` key per request.
 * @param {(service: string) => unknown} [options.get] - service resolver for
 *   the image hooks (`attachments`, `fs`).
 * @param {string[]} [options.unavailableModelIds] - model ids whose quota pool
 *   is exhausted; excluded from the offer so no doomed `429` request is sent.
 * @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
 *   it owns.
 */
export function createSensenovaAdapter({ entries, enabledIds = [], baseUrl, resolveApiKey, get, unavailableModelIds = [] }: {
  entries: unknown;
  enabledIds?: string[];
  baseUrl: string;
  resolveApiKey: () => Promise<string>;
  get?: (service: string) => unknown;
  unavailableModelIds?: string[];
}) {
  const models = buildDescriptors(entries as object[], { providerId: LLM_PROVIDER_ID, baseUrl, enabledIds, unavailableModelIds });

  return assemblePiAiAdapter({
    providerId: LLM_PROVIDER_ID,
    displayName: LLM_DISPLAY_NAME,
    apiKeyName: "SenseNova API key",
    models,
    // The stored API-key reference is the only credential this route presents;
    // it is read per request, so rotating the key needs no re-registration.
    resolveCredential: resolveApiKey,
    get,
    // The picker's "Default" pins to DEFAULT_REASONING_EFFORT (high).
    // SenseNova thinks by default (reasoning_effort default high), and the
    // descriptor's thinkingLevelMap spells off as `none`, so an unselected
    // effort must not reach pi-ai as "no effort" — that would dispatch
    // `map.off` and silently turn thinking off. Pinning the profile default
    // keeps the platform default; the snapshot quotes this same constant to
    // the panel roster, so the displayed default cannot drift from it.
    reasoning: DEFAULT_REASONING_EFFORT
  });
}

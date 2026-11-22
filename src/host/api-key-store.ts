/**
 * The SenseNova inference API key (`sk-…`) store — the credential behind the
 * directly-registered LLM provider and the `/v1/models` catalog.
 *
 * It is the SAME reference-value mechanism the console account uses
 * (`token-store.ts`): the key is not a new credentials record KIND (the
 * service admits only `grant` / `api-key`, and a private kind makes the whole
 * credentials document unparseable and takes the Host down). It is stored as a
 * credential REFERENCE named `SENSENOVA_API_KEY` — owner-only in
 * `~/.dsh/.credentials.yaml` — and the raw process environment stays honored
 * as a fallback, so an existing `$DSH_HOME/.env` setup keeps working untouched.
 *
 * Precedence, per read: the credentials service (a value typed into the panel
 * must win without a restart), then this process's memory (a Host with no
 * credentials service), then the environment.
 *
 * @module dsh-connect-sensenova-token-plan/api-key-store
 */

import { isEphemeral, resolveCredentialsService } from "./credentials-service.ts";
import { verbatim } from "./util.ts";

/**
 * The reference name the key is stored under.
 *
 * The hand-written `llm-pi-ai` provider resolves the same `apiKeyEnv` name, so
 * a key this panel saves lights that provider too — one stored value, both
 * routes.
 */
export const API_KEY_REF = "SENSENOVA_API_KEY";

/**
 * The provider-DERIVED reference name DSH's built-in 添加模型 page stores the
 * key under for this provider: `deriveKeyRef("sensenova-token-plan")`
 * (`dsh-client-ui-settings-models`: provider id upper-cased, non-alphanumerics
 * to `_`, plus `_API_KEY`). Without probing it, a key saved through that
 * page was invisible to the plugin and the provider reported
 * "not configured" (GitHub PR #9). The constant is hard-coded here — the
 * Host UI bundle is a client package this Host module must not import.
 */
export const DERIVED_KEY_REF = "SENSENOVA_TOKEN_PLAN_API_KEY";

/**
 * The CLOSED probe list `resolve()` walks, in order (first non-empty wins):
 * the plugin's own ref first — what this panel's 接入 API tab writes and what
 * `save()` / `forget()` manage — then the provider-derived ref.
 *
 * No wildcard scan, deliberately: the credentials service is shared by every
 * plugin on this Host (red line 2: its records are only `grant` / `api-key`),
 * and the 小浣熊 upstream keeps refs of its own (§5 invariant 3: the two
 * upstreams' credential references are fully isolated). A `/sensenova/i`
 * sweep (the shape GitHub PR #9 shipped) could hand the Token Plan provider
 * the raccoon's OAuth token; and reaching into the service's internal
 * `values` shape is the same trap as treating upstream packaging as contract
 * — an internal rename must not change behaviour.
 */
export const RESOLVE_REF_PROBES: readonly string[] = Object.freeze([API_KEY_REF, DERIVED_KEY_REF]);

/**
 * Build the API-key store.
 * @param {object} [options] - wiring.
 * @param {object|Function|null} [options.credentials] - the `ctx.credentials`
 *   service, a resolver, or `null`. Resolved on EVERY use, like token-store:
 *   the service may register after this plugin mounts.
 * @param {object} [options.env] - environment source; defaults to `process.env`.
 * @returns {{save: Function, forget: Function, resolve: Function, state: Function}}
 */
export function createApiKeyStore({ credentials = null, env = process.env }: { credentials?: unknown; env?: Record<string, string | undefined> } = {}) {
  /** Fallback vault for a Host that has no credentials service. */
  const memory = new Map();

  return {
    /**
     * Persist a typed-in key as the `SENSENOVA_API_KEY` reference.
     *
     * The value is stored verbatim (no trim): like the console password,
     * trimming an invisible character is a change the user cannot see. A
     * whitespace-only value is still "nothing entered".
     * @param {string} apiKey - the key.
     * @returns {Promise<void>}
     */
    async save(apiKey: string) {
      const value = verbatim(apiKey, "");
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error("an API key is required");
      }
      const service = resolveCredentialsService(credentials);
      if (service !== null && typeof service.set === "function") {
        // The durable copy first: a save the service refuses must propagate
        // and leave nothing behind, as the route reports it.
        await service.set(API_KEY_REF, value);
        // Mirror into this process's memory as well — the service may
        // unregister between this save and a later resolve, and a key that
        // was durably stored must not read back as absent when it does.
        memory.set(API_KEY_REF, value);
      } else {
        memory.set(API_KEY_REF, value);
      }
    },

    /**
     * Forget the stored key. The environment fallback is NOT touched: clearing
     * a panel-saved reference must not delete an operator's `.env` setting.
     *
     * The durable copy is only UNSET when the service is confirmed to hold a
     * value: `resolve()` reads the service FIRST, so an unset that failed while
     * a value was still there would come back on the next read as `source:
     * "credentials"` — a key the panel was told is gone. That case PROPAGATES
     * (the route answers ok:false). A service that cannot even be READ yields
     * no proof a durable copy exists, so the in-memory delete degrades quietly,
     * as it did before this guard.
     * @returns {Promise<void>}
     */
    async forget() {
      memory.delete(API_KEY_REF);
      const service = resolveCredentialsService(credentials);
      if (service === null || typeof service.unset !== "function") return;
      // Proof, not trust: only a value the service hands back RIGHT NOW is one
      // a failed unset would leave behind. A service whose reads throw gives no
      // proof, and stays on the quiet path.
      let held: { value?: string } | undefined;
      try {
        held = typeof service.resolve === "function"
          ? await service.resolve(API_KEY_REF).catch(() => undefined)
          : undefined;
      } catch {
        held = undefined;
      }
      if (typeof held?.value !== "string" || held.value.trim() === "") return;
      try {
        await service.unset(API_KEY_REF);
      } catch (error) {
        // The durable copy is STILL in the credentials service: answer the
        // route with the failure rather than a clean ok, or the next resolve()
        // would resurrect the "forgotten" key under `source: "credentials"`.
        // The in-memory delete above still stands — this process no longer
        // claims it from memory, only the service copy survives.
        throw error;
      }
    },

    /**
     * Resolve the live key and where it came from.
     *
     * The credentials service is walked over the CLOSED probe list
     * (`RESOLVE_REF_PROBES`): the plugin's own ref first, then the
     * provider-derived ref the built-in 添加模型 page writes (GitHub PR #9).
     * Other refs are never consulted — see the constant's doc for why the
     * list stays closed.
     * @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
     */
    async resolve() {
      try {
        const service = resolveCredentialsService(credentials);
        if (service !== null && typeof service.resolve === "function") {
          for (const ref of RESOLVE_REF_PROBES) {
            const resolved = await service.resolve(ref).catch(() => undefined);
            const value = verbatim(resolved?.value, "");
            if (typeof value === "string" && value.trim() !== "") return { value, source: "credentials" };
          }
        }
      } catch {
        // No usable answer from the service: fall through to memory/env.
      }
      const held = memory.get(API_KEY_REF);
      if (typeof held === "string" && held.trim() !== "") return { value: held, source: "memory" };
      const fromEnv = verbatim(env[API_KEY_REF], "");
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") return { value: fromEnv, source: "env" };
      return { value: "", source: null };
    },

    /**
     * The secret-free description the routes and panel report.
     *
     * `ephemeral` mirrors token-store: true when this Host has no credentials
     * service, so a key the panel saved would not survive a restart. A key read
     * from the environment is still reported with its real source.
     * @returns {Promise<{hasApiKey: boolean, keySource: string|null, ephemeral: boolean}>}
     */
    async state() {
      const { source } = await this.resolve();
      return { hasApiKey: source !== null, keySource: source, ephemeral: isEphemeral(credentials) };
    }
  };
}

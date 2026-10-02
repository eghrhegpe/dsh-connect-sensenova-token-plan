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

  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };

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
      const service = resolveService();
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
     * Both the service reference and the in-memory copy are cleared, so a key
     * saved on a Host without the service disappears too.
     * @returns {Promise<void>}
     */
    async forget() {
      memory.delete(API_KEY_REF);
      try {
        const service = resolveService();
        if (service !== null && typeof service.unset === "function") {
          await service.unset(API_KEY_REF);
        }
      } catch {
        // The in-memory copy above is already gone; nothing else to do.
      }
    },

    /**
     * Resolve the live key and where it came from.
     * @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
     */
    async resolve() {
      try {
        const service = resolveService();
        if (service !== null && typeof service.resolve === "function") {
          const resolved = await service.resolve(API_KEY_REF).catch(() => undefined);
          const value = verbatim(resolved?.value, "");
          if (typeof value === "string" && value.trim() !== "") return { value, source: "credentials" };
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
      return { hasApiKey: source !== null, keySource: source, ephemeral: resolveService() === null };
    }
  };
}

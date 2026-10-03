/**
 * The model-roster curation route.
 *
 * Part of the routes split (see `../routes.ts` for the family map). POST-only:
 * an absent field is refused rather than read as "all models", the curated
 * allow-list is capped, and a save re-publishes immediately with the CURRENT
 * catalogue (a failed publish rolls back inside `publishProvider`).
 *
 * @module dsh-connect-sensenova-token-plan/routes/models
 */
import { name } from "../host-config.ts";
import { normalizeEnabledIds } from "../catalog-store.ts";
import { syncSignaturesAfterPublish } from "../provider-publish.ts";
import { optional } from "../util.ts";
import { resolveSwitchEnabled } from "../switch-precedence.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, MAX_ENABLED_MODEL_IDS, redactedError } from "./http.ts";
import type { Wiring } from "../types.ts";

/** The model-roster route (docs/API.md). */
export const MODELS_PATH = `/api/${name}/models`;

/**
 * Register the models route. Wiring subset: `settings`, `catalogStore`,
 * `providerStore`, `providerState`, `publishProvider`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "catalogStore" | "providerStore" | "providerState" | "publishProvider">} wiring
 *   - the subset this route reads, as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerModelsRoute(ctx: any, wiring: Pick<Wiring, "settings" | "catalogStore" | "providerStore" | "providerState" | "publishProvider">) {
  const { settings, catalogStore, providerStore, providerState, publishProvider } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same fence as the other routes: a foreign page must not be able to
      // decide which models this Host offers.
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // An absent field is refused rather than read as "all models": writing
      // that would silently widen the offer to every model in the catalogue.
      if (!Array.isArray(body.value.enabledModelIds)) {
        writeJson(response, 400, { ok: false, error: "expected { enabledModelIds: string[] }" },
          { "cache-control": "no-store" });
        return;
      }
      const ids = normalizeEnabledIds(body.value.enabledModelIds);
      if (ids.length > MAX_ENABLED_MODEL_IDS) {
        writeJson(response, 400,
          { ok: false, error: `enabledModelIds is too long (max ${MAX_ENABLED_MODEL_IDS})` },
          { "cache-control": "no-store" });
        return;
      }
      const answer = async (extra = {}) => {
        writeJson(response, 200, {
          ok: true,
          enabledModelIds: await optional(catalogStore.listEnabledIds(), providerState.enabledIds),
          registerProvider:
            resolveSwitchEnabled(await optional(providerStore.enabled()), settings.registerProvider),
          providerRegistered: providerState.registered,
          ...(providerState.error !== null ? { providerError: providerState.error } : {}),
          ...extra
        }, { "cache-control": "no-store" });
      };
      try {
        await catalogStore.setEnabledIds(ids);
        // Publish immediately with the CURRENT catalogue: the offer must not
        // wait for the next poll. A failed publish rolls back to the previous
        // pair inside publishProvider and surfaces its reason.
        await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
        // Adopt the signature of what was just offered so the next poll does not
        // see a "change" and re-publish the same set.
        syncSignaturesAfterPublish(providerState);
      } catch (error) {
        await answer({ ok: false, error: redactedError(error) });
        return;
      }
      await answer();
    }, settings.allowedHosts)
  });
}

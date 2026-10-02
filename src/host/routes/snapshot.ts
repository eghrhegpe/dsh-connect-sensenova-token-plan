/**
 * The snapshot route — the one read-only route the Client panel polls.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * aggregation itself lives in `snapshot-aggregate.ts`; this module is the
 * HTTP edge: the trust fence, the config-error short-circuit, the vision
 * write-back, and the `ok:false` shape with its code taxonomy.
 *
 * @module dsh-connect-sensenova-token-plan/routes/snapshot
 */
import { name } from "../host-config.ts";
import { buildSnapshotBody, failureCode } from "../snapshot-aggregate.ts";
import { CODE } from "../codes.ts";
import { optional, errMsg } from "../util.ts";
import { writeJson, refuseMethod, withOrigin } from "./http.ts";
import type { Wiring } from "../types.ts";

/** The one read-only route the Client panel polls. */
export const SNAPSHOT_PATH = `/api/${name}/snapshot`;

/**
 * Register the snapshot route. Wiring subset: `settings`, `configError`,
 * `cache`, `inflight`, `tokenStore`, `apiKeyStore`, `publisher`,
 * `catalogStore`, `providerStore`, `drawStore`, `visionPublish`, `logger`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "configError" | "cache" | "inflight" | "tokenStore" | "apiKeyStore" | "publisher" | "catalogStore" | "providerStore" | "drawStore" | "visionPublish" | "logger">} wiring
 *   - the subset this route reads, as assembled by `apply()` in `index.ts`.
 *   Twelve of twenty-two — the widest surface in the family, and the reason
 *   the declaration is worth having: `apiKeyStore` is read directly off the
 *   bag rather than destructured, so it was invisible to a grep of the
 *   destructuring line and the `Pick` now names it in the type instead.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerSnapshotRoute(ctx: any, wiring: Pick<Wiring, "settings" | "configError" | "cache" | "inflight" | "tokenStore" | "apiKeyStore" | "publisher" | "catalogStore" | "providerStore" | "drawStore" | "visionPublish" | "logger">) {
  const { settings, configError, cache, inflight, tokenStore, publisher, catalogStore, providerStore, drawStore, visionPublish, logger } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: SNAPSHOT_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response);
        return;
      }
      if (configError !== null) {
        // The panel maps this code to its own line, so the operator sees the
        // misconfiguration instead of a generic network failure.
        writeJson(response, 200, {
          ok: false,
          code: CODE.CONFIG_ERROR,
          error: configError,
          auth: await optional(tokenStore.state())
        }, { "cache-control": "no-store" });
        return;
      }
      try {
        // Step two (vision, ARCHITECTURE.md §5.1): publish the computed list to
        // this row's own settings namespace so a later LLM connect plugin can
        // read it. The aggregate needs to know the vision list before it builds
        // the body (it carries `visionModels`), so the caller computes it up
        // front and hands it in.
        const body = await buildSnapshotBody({
          settings,
          cache,
          inflight,
          tokenStore,
          apiKeyStore: wiring.apiKeyStore,
          publisher,
          catalogStore,
          panelSwitch: () => optional(providerStore.enabled()),
          drawSwitch: () => optional(drawStore ? drawStore.enabled() : null),
          drawModelId: () => optional(drawStore ? drawStore.modelId() : null)
        });
        if (body.visionModels !== undefined) {
          // A write failure here is silent otherwise: the vision list fails to
          // persist to this row's settings, so the later image-routing plugin
          // reads a stale or empty set with no trace to explain why. Log it; the
          // in-memory body the panel already got is unaffected.
          void visionPublish.current?.(body.visionModels, body.visionModels.map((entry: any) => entry.id))
            .catch((error) => logger?.warn?.(`${name}: vision model list write failed`, error));
        }
        writeJson(response, 200, body, { "cache-control": "no-store" });
      } catch (error) {
        // Distinguish "we cannot get a token" from "the console call failed":
        // the first is fixed by logging in, the second is usually transient.
        writeJson(response, 200, {
          ok: false,
          error: errMsg(error),
          code: failureCode(error),
          auth: await optional(tokenStore.state())
        }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}

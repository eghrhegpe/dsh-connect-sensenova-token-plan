/**
 * The draw-tool switch route.
 *
 * Part of the routes split (see `../routes.ts` for the family map). GET
 * answers the effective switch and model preference with their sources; POST
 * distinguishes three purposes by body — a saved boolean, a saved model
 * preference (`null` = auto), or a forget. `forget` clears the SWITCH and
 * deliberately keeps the model preference (`drawModelId: null` is the model's
 * own reset), so the picker choice survives a switch being given back.
 *
 * @module dsh-connect-sensenova-token-plan/routes/draw
 */
import { name } from "../host-config.ts";
import { optional, errMsg } from "../util.ts";
import { resolveSwitchEnabled, resolveSwitchValue, switchSource } from "../switch-precedence.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin } from "./http.ts";
import type { Wiring } from "../types.ts";

/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
export const DRAW_PATH = `/api/${name}/draw`;

/**
 * Register the draw route. Wiring subset: `settings`, `drawStore`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "drawStore">} wiring - the subset this
 *   route reads, as assembled by `apply()` in `index.ts`. The smallest
 *   dependency surface in the family, and now the compiler enforces it.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerDrawRoute(ctx: any, wiring: Pick<Wiring, "settings" | "drawStore">) {
  const { settings, drawStore } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: DRAW_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same trust fence as the other routes: a foreign page must not be able
      // to turn an agent image tool on or off.
      const method = request.method === undefined ? "GET" : request.method;
      const answer = async (extra = {}) => {
        const panelDraw = await optional(drawStore ? drawStore.enabled() : null);
        const panelModel = await optional(drawStore ? drawStore.modelId() : null);
        // The effective value: a saved panel value always wins, otherwise the
        // config default. The source tells the panel which side is in charge.
        const effectiveDraw = resolveSwitchEnabled(panelDraw, settings.drawEnabled);
        const effectiveModel = resolveSwitchValue(panelModel, settings.drawModelId);
        writeJson(
          response,
          200,
          {
            ok: true,
            drawEnabled: effectiveDraw,
            drawSource: switchSource(panelDraw),
            drawModelId: effectiveModel,
            drawModelSource: switchSource(panelModel),
            ...extra
          },
          { "cache-control": "no-store" }
        );
      };
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // Three purposes, distinguished by the body — the same shape the
      // account and api-key routes use: a saved boolean, a saved model
      // preference (`null` = auto), or a forget. `forget` clears the SWITCH
      // only and deliberately keeps the model preference — `drawStore.forget`
      // rewrites the row with the existing `modelId` intact, and `saveModel`
      // is the path that resets it. Do not read "a forget" as "reset all":
      // the panel's picker choice must survive the switch being given back.
      if (body.value.forget === true) {
        if (!drawStore) {
          await answer({ ok: false, error: "draw store is unavailable" });
          return;
        }
        try {
          await drawStore.forget();
        } catch (error) {
          await answer({ ok: false, error: errMsg(error) });
          return;
        }
        await answer();
        return;
      }
      if (body.value.drawModelId !== undefined) {
        const raw = body.value.drawModelId;
        if (raw !== null && (typeof raw !== "string" || raw.trim() === "")) {
          writeJson(response, 400, { ok: false, error: "drawModelId expects a non-empty string or null" }, { "cache-control": "no-store" });
          return;
        }
        if (!drawStore) {
          await answer({ ok: false, error: "draw store is unavailable" });
          return;
        }
        try {
          await drawStore.saveModel(raw);
        } catch (error) {
          await answer({ ok: false, error: errMsg(error) });
          return;
        }
        await answer();
        return;
      }
      if (typeof body.value.enabled !== "boolean") {
        writeJson(response, 400, { ok: false, error: "expected { enabled: boolean }, { drawModelId }, or { forget: true }" }, { "cache-control": "no-store" });
        return;
      }
      if (!drawStore) {
        await answer({ ok: false, error: "draw store is unavailable" });
        return;
      }
      try {
        await drawStore.save(body.value.enabled);
      } catch (error) {
        await answer({ ok: false, error: errMsg(error) });
        return;
      }
      await answer();
    }, settings.allowedHosts)
  });
}

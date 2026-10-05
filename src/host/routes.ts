/**
 * The HTTP route handlers — the registry facade of the routes family.
 *
 * `apply()` (in `index.ts`) stays the single mount seam: it assembles a
 * `wiring` object and hands it to {@link registerRoutes}; each route is its
 * own module (one per resource) that closes over the wiring, so a route never
 * imports a service directly. Nothing here imports a Host peer — the only
 * lazy peer loads (the adapter / tools modules) live in `lifecycle.ts` and
 * are injected from `apply` via `deps`.
 *
 * 2026-10 split (the token-store playbook: behaviour frozen first —
 * `routes.test.mjs` + `wiring.test.mjs` ran green against THIS facade,
 * unchanged, before and after the move). The family:
 *
 *   - `routes/http.ts`      — the shared primitives (writeJson, the bounded
 *                             body reader, the fence/method refusals, the
 *                             body ceilings);
 *   - `routes/snapshot.ts`  — the polled read-only snapshot (and the
 *                             failure-code taxonomy);
 *   - `routes/account.ts`   — panel sign-in / forget, trace writes;
 *   - `routes/api-key.ts`   — the `sk-` reference, forget-and-republish;
 *   - `routes/provider.ts`  — the registration switch;
 *   - `routes/models.ts`    — the curated allow-list;
 *   - `routes/draw.ts`      — the draw-tool switch;
 *   - `routes/raccoon.ts`   — the second-upstream provider (switch / models /
 *                             login / logout).
 *
 * The registration ORDER is load-bearing: the returned `off()` callbacks run
 * in this order on teardown. Public API and export surface are unchanged.
 *
 * @module dsh-connect-sensenova-token-plan/routes
 */
import { registerSnapshotRoute } from "./routes/snapshot.ts";
import { registerAccountRoute } from "./routes/account.ts";
import { registerApiKeyRoute } from "./routes/api-key.ts";
import { registerProviderRoute } from "./routes/provider.ts";
import { registerModelsRoute } from "./routes/models.ts";
import { registerDrawRoute } from "./routes/draw.ts";
import { registerRaccoonRoute } from "./routes/raccoon.ts";
import type { Wiring } from "./types.ts";

/**
 * Register the six Token Plan routes plus the Raccoon route on the Host's web
 * server. Each route is its own module; this assembler only decides what they
 * may touch (the wiring) and hands back the unregister callbacks, in
 * registration order — `teardown` runs them last.
 * @param {any} ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Wiring} wiring - assembled by `apply()` in `index.ts`.
 * @returns {Array<() => void>} the seven `off()` unregister callbacks, in
 *   registration order. Spelled out rather than `Function[]` so it matches
 *   what `teardown` now accepts — and note that a JSDoc type is a COMMENT
 *   here, not a type source, so `tsc` never checked this line either way.
 *   The real guarantee for each route is its own `Pick<Wiring, …>` parameter.
 */
export function registerRoutes(ctx: any, wiring: Wiring) {
  return [
    registerSnapshotRoute(ctx, wiring),
    registerAccountRoute(ctx, wiring),
    registerApiKeyRoute(ctx, wiring),
    registerProviderRoute(ctx, wiring),
    registerModelsRoute(ctx, wiring),
    registerDrawRoute(ctx, wiring),
    registerRaccoonRoute(ctx, wiring)
  ];
}

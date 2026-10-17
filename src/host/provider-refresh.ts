/**
 * The background provider refresher (2026-10 review #1b) — peer-free.
 *
 * WHY: every refresher in this plugin used to live on the panel's poll —
 * catalog age, quota flips, and therefore also the provider registration a
 * conversation keeps USING. The panel lives and dies with the browser tab
 * (`use-polling-interval` pauses while hidden and stops on unmount by design,
 * and README promises it), while a REGISTERED provider is a standing
 * execution channel: on a panel-closed Host the picker kept serving whatever
 * the last opener left, an exhausted pool un-blocked and a stale catalog
 * un-refreshed until someone happened to look. `seedPublisherFromCatalog`
 * fixed the restart path (#1a); this fixes the no-restart path.
 *
 * WHAT it runs: the SAME `buildSnapshotBody` the snapshot route calls, with
 * the same cache/inflight/tokenStore/publisher — NOT a second half-engine.
 * Its change-detection (signatures), persist (catalog + quota), publish
 * (queued) and degradation are exactly the poll's; the return body is
 * discarded, because the panel is not here to read it. Sharing the cache maps
 * means a panel that opens later hits the warm entries rather than doubling
 * the upstream traffic. The steady-state cost is honest: each tick re-reads
 * pool-usage + trend (both caches, 60s/300s, are shorter than any allowed
 * cadence) = two console reads per tick — at the shipped 15 minutes, eight
 * per hour per profile, plus one catalog fetch per cache hour. An open panel
 * makes those reads every 30 s; this is the floor for a Host that serves a
 * provider with nobody looking.
 *
 * GATES (the opt-in invariant, ARCHITECTURE §5):
 *   - `providerRefreshMinutes === 0` schedules NOTHING (a config-driven
 *     deployment keeps today's panel-only behaviour exactly);
 *   - the effective provider switch (panel store beats the patch default,
 *     `switch-precedence.ts`) is re-read BEFORE every tick — off is the
 *     DEFAULT, so an off Host runs no aggregate at all, no console probe,
 *     no upstream read beyond what the seed already did;
 *   - a Host without a console login is self-limiting: the aggregate's
 *     console reads fail soft into `quotaError` and the catalog read needs
 *     the `sk-` key, so an unconfigured Host does at most two local throws
 *     and writes nothing — the same as one snapshot poll on a signed-out
 *     panel, on a 15-minute clock.
 *   - disposed: the interval callback checks `publisher.isDisposed()` first
 *     and `teardown` clears the slot, so no tick races the unmount.
 *
 * Failure discipline: a rejecting tick is REPORTED through `degrade` (one
 * warn line with the reason) and never kills the timer — a transient console
 * outage that silenced the refresher for the rest of the session would be
 * the exact staleness this module exists to prevent, with a longer fuse.
 *
 * @module dsh-connect-sensenova-token-plan/provider-refresh
 */
import { buildSnapshotBody } from "./snapshot-aggregate.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
import { degrade } from "./util.ts";
import type { Wiring } from "./types.ts";

/** The handle the slot holds: `close()` stops the clock, idempotent. */
export interface ProviderRefresher {
  close(): void;
}

/**
 * Arm the background refresher and return its handle, honouring BOTH gates on
 * the CALLER's behalf: `minutes <= 0` or an already-disposed publisher arm
 * nothing (return `null`). `startSideEffects` calls this; `teardown` closes
 * the handle it stored in `wiring.providerRefresh.current`.
 * @param {Wiring} wiring - the assembled wiring; reads settings, stores,
 *   caches, publishers and the logger.
 * @param {number} minutes - the effective cadence in minutes (> 0 expected;
 *   re-checked, a non-positive value is a no-op, not a bug report).
 * @returns {ProviderRefresher|null} the handle, or null when nothing armed.
 */
export function armProviderRefresher(wiring: Wiring, minutes: number): ProviderRefresher | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const { settings, cache, inflight, tokenStore, apiKeyStore, publisher, catalogStore, providerStore } = wiring;
  const everyMs = Math.min(24 * 60, Math.max(1, Math.floor(minutes))) * 60_000;
  let closed = false;
  let ticking = false;
  const tick = async () => {
    if (closed || publisher.isDisposed()) return;
    // One refresh at a time: a tick whose aggregate is still in flight when
    // the next fires would be a second concurrent full aggregate for no
    // reader. The shared cache/single-flight would coalesce most of it anyway;
    // this keeps the publisher queue honest too.
    if (ticking) return;
    ticking = true;
    try {
      // Re-read the EFFECTIVE switch each tick (panel-first dialect, same
      // adjudicator the publisher and the routes use): a flip between mount
      // and tick takes effect without a restart, and OFF means this tick does
      // literally nothing — no console probe, no aggregate. INSIDE the try:
      // a store that throws synchronously must reach `degrade` like any other
      // failure, not reject the tick past every guard (the interval callback
      // awaits nothing — an escaping rejection would be an unhandled one).
      const panelValue = await providerStore.enabled().catch(() => null);
      if (resolveSwitchEnabled(panelValue, settings.registerProvider) !== true) return;
      // Only the REQUIRED surface of the aggregate is passed. The three draw
      // readers and `drawToolNote` exist to word the snapshot's `llm` block
      // for a PANEL — this caller discards the body, so it asks the stores
      // for nothing they would not render. Same engine, same change-detection,
      // same persist, same queue, zero extra reads.
      await buildSnapshotBody({
        settings,
        cache,
        inflight,
        tokenStore,
        apiKeyStore,
        publisher,
        catalogStore,
        panelSwitch: () => providerStore.enabled().catch(() => null),
        // The background tick discards the body but must not discard the one
        // signal the body cannot carry to a reader — see `onShapeDrift`.
        onShapeDrift: (message: string) => degrade(message, null, wiring.logger, null)
      });
    } catch (error) {
      // A throwing tick is REPORTED, and the clock survives: a transient
      // failure that silenced the refresher for the rest of the session would
      // re-create the exact staleness this module exists to prevent, only with
      // a longer fuse.
      degrade("provider-refresh: the background refresh failed; the timer stays armed", error, wiring.logger, null);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, everyMs);
  // A timer that only exists to age data must not keep a shutting-down
  // process alive; `unref` is exactly that. Hosts without it (a stubbed
  // global) are unaffected.
  (timer as { unref?: () => void }).unref?.();
  return {
    close() {
      closed = true;
      clearInterval(timer);
    }
  };
}

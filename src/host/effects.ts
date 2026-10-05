/**
 * The mount-time effect registry (ADR-008): the named, trackable form of
 * this plugin's mount side effects.
 *
 * Before this, every absorbed module arrived with its own anonymous
 * `void (async () => { … })()` IIFE and its own post-hoc race guard (the
 * `disposed` gate of the publish queues, the `isDisposed` checks inside the
 * retry loops, the web-search mount's hand-back when the Host was already
 * gone — PITFALLS §18 / §31, P0-1 `65ab2dc`). Each guard is correct for its
 * own module, but the surface they cover grows combinatorially with every
 * absorption: unmount runs while N effects are still settling, and nothing
 * OBSERVED which of the N were still settling.
 *
 * The registry is bookkeeping, not a new safety mechanism:
 *   - `add` runs the effect immediately (mount semantics unchanged: every
 *     effect starts concurrently, none blocks the mount) and tracks its
 *     promise under a short label;
 *   - `drain` (called from the unmount cleanup, BEFORE `teardown`) waits
 *     for the still-settling effects up to a bounded cap, so the common case
 *     becomes "let it finish, then dispose" instead of "dispose, and pray
 *     the guards hold";
 *   - a cap-straggler is reported by label and left to the
 *     guards that already exist — the registry must never hold an unmount
 *     hostage to a hung effect.
 *
 * A rejecting effect is swallowed here (with a warn), because a mount
 * effect's failure is already the module's own concern: every one of them
 * degrades by design (the panel and the quota read keep working), and the
 * real reason is logged where it happened. Swallowing also keeps the
 * rejection from becoming an unhandledRejection on the Host process — which
 * is exactly the hole `void reconcileWebSearch(…)` left: a `registerSearchProvider`
 * that THREW (rather than merely being absent) used to reject the mount IIFE
 * with no handler anywhere.
 *
 * @module dsh-connect-sensenova-token-plan/effects
 */

import { errMsg } from "./util.ts";

/** The unmount's cap for waiting on still-settling mount effects. */
export const MOUNT_EFFECT_DRAIN_TIMEOUT_MS = 5000;

/** One tracked mount-time effect. */
export interface EffectRegistry {
  /**
   * Run and track one mount-time effect. `run` is called immediately.
   * @param {string} label - a short stable name ("raccoon-seed", "vision").
   * @param {() => Promise<unknown>} run - the effect body.
   * @returns {void}
   */
  add(label: string, run: () => Promise<unknown>): void;
  /**
   * Await every still-settling effect, capped at `timeoutMs`.
   * @param {number} timeoutMs - the cap; never exceeded.
   * @returns {Promise<string[]>} the labels still settling when the cap hit.
   */
  drain(timeoutMs: number): Promise<string[]>;
  /** The labels still settling right now. */
  inFlight(): string[];
}

/**
 * Build an effect registry.
 * @param {{ warn?: (message: string) => void } | undefined} [logger] - `ctx.logger`.
 * @returns {EffectRegistry}
 */
export function createEffectRegistry(
  logger: { warn?: (message: string) => void } = {}
): EffectRegistry {
  /** Still-settling effects, by label. */
  const live = new Map<string, Promise<unknown>>();
  return {
    add(label, run) {
      const promise = run().catch((error) => {
        // A mount effect must not take the process with it: its module's own
        // guard already named the failure, or a `null` service is the whole
        // reason and needs no line at all.
        if (error !== null && error !== undefined) {
          logger?.warn?.(`mount effect "${label}" rejected: ${errMsg(error)}`);
        }
      });
      live.set(label, promise);
      void promise.then(() => {
        if (live.get(label) === promise) live.delete(label);
      });
    },
    drain(timeoutMs) {
      const inFlight = [...live.entries()];
      if (inFlight.length === 0) return Promise.resolve<string[]>([]);
      const gate = new Promise((resolve) => {
        // The cap's timer is deliberately NOT unref'd: the cap is a safety
        // property, so `drain` must settle even when nothing else keeps the
        // event loop alive (a Node host shutting down with effects still in
        // flight, or the F6 registry check in `wiring.test`). An unref'd
        // gate never fires in that situation and the unmount's cleanup
        // promise would stay unsettled — an unmount that hangs is worse
        // than a 5-second lingering timer in a long-lived Host process.
        setTimeout(resolve, timeoutMs);
      });
      return Promise.all(
        inFlight.map(async ([label, promise]) => {
          // Both settle outcomes count as "settled": a reject has already been
          // swallowed (and warned) by `add`, so `then` must not re-propagate
          // it — a rejecting straggler must reach the cap, not reject the
          // drain itself.
          const settled = await Promise.race([promise.then(() => true, () => true), gate]);
          return settled ? null : label;
        })
      ).then((names) => names.filter((n): n is string => n !== null));
    },
    inFlight() {
      return [...live.keys()];
    }
  };
}

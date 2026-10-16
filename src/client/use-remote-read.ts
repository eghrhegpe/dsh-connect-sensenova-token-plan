/**
 * The polling core every Host-route read shares: one generation guard, one abort
 * handle, one back-off switch, and the unmount teardown.
 *
 * Why it exists: the panel's snapshot poller and the composer pill's Raccoon
 * balance reader are the same machine pointed at two routes. Written twice they
 * drift, and they drifted the moment they were written twice — the pill's copy
 * arrived with a bare status string where the snapshot's carried the structured
 * `errorOfStatus`, and its request forgot the `cache` line. `duplication-gate.mjs`
 * caught it at import time: two unregistered clones of one body, the same §343
 * shape as the Token Plan ↔ raccoon publish pair that PITFALLS.md §343 records.
 * The copies are never the real problem; the copies are how two quota universes
 * end up sharing a bug fix by accident and a behaviour change by drift.
 *
 * What is shared is the LIFECYCLE, not the interpretation. Each route still owns
 * how its own body is read — the snapshot goes through `interpretSnapshot`, the
 * balance through its own `ok:false` envelope — and each still owns what its
 * failures MEAN. Only the guards, the request, the cadence follow, and the
 * teardown are one implementation.
 *
 * Not a hook in its own right: `useRemoteRead` is called FROM a hook, so it obeys
 * that hook's discipline (fixed hook count, fixed order, one call site per
 * reader). Its `route` argument MUST be stable — a fresh object each render would
 * rebuild `load` on every render and restart the loop with it.
 * @module dsh-connect-sensenova-token-plan/use-remote-read
 */
import { useCallback, useEffect, useRef, useState } from "./runtime.ts";
import { usePollingInterval } from "./use-polling-interval.ts";
import { errorText, statedCadenceMs } from "./format.ts";

/**
 * How one route's body becomes a reading.
 *
 * `value` and `failure` are independent on purpose: a route may declare a value
 * that only partially answers (the Raccoon state arrives while `balance` is
 * absent), which is not a failure, and a read that times out keeps the PREVIOUS
 * value on screen alongside the failure — the reading a surface shows is never
 * worse than the one it already had.
 *
 * `F` is the failure's type parameter rather than a fixed string because the
 * snapshot's failure is structured (`{ message, code, auth }`) and the panel
 * renders those fields, while the pill's is plain text. The core stays agnostic
 * and carries whatever the route produces.
 */
export interface RemoteRead<T, F = string> {
  /** What this body says, or `null` when it says nothing usable. */
  value: T | null;
  /** The failure this body means, or `null` when it means "here is the reading". */
  failure: F | null;
  /**
   * The rate the body states, in seconds; omitted when it states none.
   *
   * Typed `| undefined` on purpose: a route's honest answer is usually a body
   * field forwarded as-is (`pollSeconds` is declared optional upstream), and
   * this project compiles with `exactOptionalPropertyTypes`, where writing that
   * property at all would otherwise demand a conditional spread at every such
   * site. Absent and "stated as undefined" are the same answer here — the core
   * keeps its current cadence in both cases.
   */
  cadenceSeconds?: number | undefined;
}

/** Where a read goes and what it does with what comes back. */
export interface RemoteRoute<T, F = string> {
  /** The plugin route to GET. */
  path: string;
  /**
   * Read the body into a {@link RemoteRead}. MUST be pure: it runs inside the
   * core's load callback, and a reader that kept state here would write state
   * during another hook's callback.
   */
  parse: (body: unknown, status: number) => RemoteRead<T, F>;
}

/** What every reader renders from. */
export interface RemoteReadState<T, F = string> {
  /** The newest body that meant something — kept across a failed read. */
  data: T | null;
  /**
   * The newest failure, or `null` when the last attempt means something.
   *
   * Always `F | string`, never just `F`: a thrown fetch has no structure to
   * read, so its wording can only be text (`errorText`) — including for a route
   * whose own failures are structured. That union is the honest shape, and it is
   * the one `viewOf` has always accepted.
   */
  error: F | string | null;
  /**
   * Whether the FIRST attempt reached any conclusion — success or failure.
   *
   * The snapshot panel needs this to keep "loading" apart from "needs setup":
   * `viewOf` reads a null/null pair as "nothing says you are configured", and
   * the setup form would then flash for a frame on every mount. The pill needs
   * it to tell "not answered yet" (… ) apart from "answered, and the answer was
   * nothing" (—).
   */
  loadedOnce: boolean;
  /** Epoch ms of the newest successful read. */
  updatedAt: number;
  /**
   * The live poll interval in ms — the stated one once a body has stated it,
   * the caller's default until then. Exposed because the panel quotes its own
   * freshness ("每 N 秒") and that number has to be the one actually in use.
   */
  cadenceMs: number;
  /** The manual refresher. */
  load: () => Promise<void>;
}

/**
 * Poll one Host route on the cadence its own answers state.
 *
 * @param route - The route to read and how to read it. MUST be stable across
 *   renders — module scope or a `useMemo`, never a fresh literal, because the
 *   loop is built from `load` and a rebuilt `load` restarts the interval.
 * @param defaultCadenceMs - The interval before any body has stated one.
 */
export function useRemoteRead<T, F = string>(
  route: RemoteRoute<T, F>,
  defaultCadenceMs: number
): RemoteReadState<T, F> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<F | string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  // How often to ask again, in ms. Every body that states a rate owns it; this
  // default only covers the first load, before any answer arrives.
  const [cadenceMs, setCadenceMs] = useState(defaultCadenceMs);

  // Only the newest load may write state: the interval can start a second load
  // before the first returns, and without this the slower response lands last
  // and the on-screen number moves backwards — the usage bar visibly moves back.
  // The generation is bumped when a load STARTS, which is also what lets a
  // manual refresh supersede the scheduled one already on its way.
  const generation = useRef(0);
  const inFlight = useRef<{ abort?: () => void } | null>(null);

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const isCurrent = () => generation.current === mine;
    // Cancel the superseded read, not merely ignore it: a stale request keeps
    // the Host's connection open for nothing.
    inFlight.current?.abort?.();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlight.current = controller;
    try {
      const response = await fetch(route.path, {
        headers: { accept: "application/json" },
        cache: "no-store",
        // Spread rather than `signal: controller?.signal`: this project compiles
        // with `exactOptionalPropertyTypes`, where an explicit `undefined` is
        // not assignable (`AbortSignal | null`).
        ...(controller ? { signal: controller.signal } : null)
      });
      if (!isCurrent()) return;
      // The Host answers 200 with `ok:false` for every EXPECTED failure, so a
      // non-2xx is a transport fact — but the route's `parse` still sees it,
      // because only the route knows what a 401 means for it (the panel keeps
      // its sign-in form on screen; a balance route has no such story).
      const body = response.ok ? await response.json().catch(() => null) : null;
      if (!isCurrent()) return;
      const outcome = route.parse(body, response.status);
      // A failure KEEPS the previous reading: the last known state is still
      // true until something contradicts it, and a read that times out is not a
      // contradiction — it is a gap, which is what the stale mark is for.
      if (outcome.value !== null) setData(outcome.value);
      setError(outcome.failure);
      if (outcome.failure === null && outcome.value !== null) setUpdatedAt(Date.now());
      // Follow the stated cadence instead of assuming one: the Host states it in
      // every answer, and the two would otherwise disagree about how fresh this
      // surface is. The Host clamps the value at its source, so it is not
      // clamped again here — a client-side floor was a second opinion that
      // silently overrode the stated number (the raccoon tab's 2 s scan cadence
      // is below the old 5 s floor).
      if (typeof outcome.cadenceSeconds === "number" && Number.isFinite(outcome.cadenceSeconds)) {
        setCadenceMs(statedCadenceMs(outcome.cadenceSeconds, cadenceMs));
      }
    } catch (reason) {
      // An abort is our own supersession, not a network failure.
      if (!isCurrent()) return;
      setError(errorText(reason));
    } finally {
      // The attempt is over one way or another — even where the early
      // `return`s above skipped their state writes (a missing `ok`, a body that
      // failed to parse). Only the CURRENT load gets to say so: an aborted,
      // superseded attempt must not flip the gate while its replacement is still
      // in flight.
      if (isCurrent()) setLoadedOnce(true);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [route, cadenceMs]);

  // One effect owns the whole polling cycle, and the loop itself is the shared
  // one (see `use-polling-interval.ts`): stop while the tab is hidden, back off
  // to a minute while the last answer was a failure. Re-running on `cadenceMs`
  // is what lets a changed rate take effect without a reload.
  //
  // The `failed` back-off is the read-side half of a discipline the Host already
  // keeps on the write side (its throttle store backs off after a refusal, per
  // PITFALLS §6): without it, a Host that is down is re-asked at full cadence
  // every 30 s until the surface closes, and the error line is the only thing
  // telling the user anything went wrong.
  const failed = error !== null;
  usePollingInterval(load, cadenceMs, { failed });

  // Unmount ONLY, and deliberately separate from the loop above: that hook's
  // cleanup also runs on every cadence rebuild (a changed `pollSeconds`, an
  // error flipping the back-off on), where this hook is still mounted and its
  // request is perfectly valid. Bumping the generation here — rather than in the
  // loop's cleanup — means only a real unmount supersedes an in-flight poll: a
  // completing load then reads `isCurrent() === false` and skips its state
  // writes, and aborting releases the Host connection instead of leaving an
  // already-sent fetch to settle on a hook nobody is rendering.
  //
  // Empty dependency list on purpose: it must fire exactly once, on unmount.
  useEffect(() => () => {
    generation.current += 1;
    inFlight.current?.abort?.();
  }, []);

  return { data, error, loadedOnce, updatedAt, cadenceMs, load };
}

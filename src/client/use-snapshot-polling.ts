/**
 * The quota snapshot polling hook — the stateful half of `PanelPage`.
 *
 * Extracted from `panel-page.ts` so the ~120 lines of polling machinery (the
 * generation-guarded `load`, the cadence-following `useEffect`, the
 * visibility-aware interval) live in one testable seam instead of inside the
 * 438-line component. The hook returns exactly the five values the rest of the
 * panel renders from; it owns no JSX.
 *
 * The correctness notes below are WHY, not WHAT: each guards a real failure
 * mode that is invisible in the code alone.
 * @module dsh-connect-sensenova-token-plan/use-snapshot-polling
 */
import { useEffect, useCallback, useRef, useState } from "./runtime.ts";
import { errorOfStatus, interpretSnapshot, type SnapshotFailure } from "./snapshot.ts";
import { statedCadenceMs } from "./format.ts";
import { SNAPSHOT_PATH } from "./const.ts";
import type { SnapshotData } from "./wire.ts";

/**
 * Poll the Host snapshot, following its stated cadence and pausing when hidden.
 * @param {number} [defaultCadenceMs] - poll interval before the first answer arrives.
 * @returns {{ data: SnapshotData | null, error: SnapshotFailure | string | null, loadedOnce: boolean, updatedAt: number, cadenceMs: number, load: () => Promise<void> }}
 *   `data`/`error` are the latest interpreted snapshot; `loadedOnce` gates the
 *   first-frame "loading" vs "needs setup" decision; `updatedAt` stamps the
 *   last successful read; `cadenceMs` is the live poll interval; `load` is the
 *   manual refresher (also wired to the header's 刷新 button).
 */
export function useSnapshotPolling(defaultCadenceMs = 30_000) {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [error, setError] = useState<SnapshotFailure | string | null>(null);
  // Has the FIRST load attempt reached a conclusion? Until it has, the
  // panel must show "loading", not the account form: `viewOf` reads
  // `data === null, error === null` as "nothing says you are configured",
  // and `needsSetup` then renders the sign-in form for a fraction of a
  // second on every mount — including for users who are configured and
  // about to see their pools. That first-frame form was the unreachable
  // `panel.loading` branch: without this gate the loading line was DEAD
  // CODE, because the null/null state always routed to the form.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  // How often to ask again, in ms. The Host states it in every snapshot;
  // this default only covers the first load, before any answer arrives.
  const [cadenceMs, setCadenceMs] = useState(defaultCadenceMs);

  // A snapshot only writes if it is still the newest one: the interval can
  // start a second load before the first returns, and without this the
  // slower response lands last, replacing fresh numbers with a stale
  // snapshot — the usage bar visibly moves backwards. The generation is
  // bumped when a load STARTS, which is also what lets a manual refresh
  // supersede the scheduled one that is already on its way.
  const generation = useRef(0);
  const inFlight = useRef<{ abort?: () => void } | null>(null);

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    const isCurrent = () => generation.current === mine;
    // Cancel the superseded poll, not just ignore it: a stale request keeps
    // the Host's connection open for nothing.
    inFlight.current?.abort?.();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    inFlight.current = controller;
    try {
      const response = await fetch(SNAPSHOT_PATH, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller ? controller.signal : undefined
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        setError(errorOfStatus(response.status));
        return;
      }
      const body = await response.json();
      if (!isCurrent()) return;
      // The Host answers 200 with `ok:false` for every expected failure, so
      // the code is kept to pick the guidance rather than the message. The
      // reading is a named module-scope function, so the tests exercise
      // exactly what the panel does instead of a copy of it.
      const read = interpretSnapshot(body);
      if (read.data === null) {
        setData(null);
        setError(read.error);
        return;
      }
      setData(read.data);
      setError(null);
      setUpdatedAt(Date.now());
      // Follow the Host's cadence instead of assuming one: the two would
      // otherwise disagree about how fresh this screen is, and the panel
      // would go on polling at the old rate after the operator changed it.
      // The Host clamps the value at its source (`clampInt(..., 5)`), so the
      // panel does not clamp it a second time — a client-side floor/ceiling
      // was a second opinion that silently overrode the stated number (the
      // raccoon tab's 2 s scan cadence is below the old 5 s floor). The
      // conversion is shared with that tab.
      const stated = (read.data as { pollSeconds?: unknown })?.pollSeconds;
      if (typeof stated === "number" && Number.isFinite(stated)) {
        setCadenceMs(statedCadenceMs(stated, cadenceMs));
      }
    } catch (reason) {
      // An abort is our own supersession, not a network failure.
      if (!isCurrent()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // The attempt is over one way or another — even where the early
      // `return`s above skipped their state writes (a missing `ok`, a
      // body that failed to parse). Only the CURRENT load gets to say so:
      // an aborted, superseded attempt must not flip the gate while
      // its replacement is still in flight.
      if (isCurrent()) setLoadedOnce(true);
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, [cadenceMs]);

  // One effect owns the whole polling cycle: an immediate load on mount,
  // then the cadence the Host last stated. Re-running on `cadenceMs` is
  // what lets a changed rate take effect without a reload.
  //
  // The interval is stopped while the tab is hidden — nobody is watching
  // the screen, and every poll keeps a Host connection open — and a single
  // load fires on the way back, which also gives a stale "更新于" line
  // something fresh to say.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (alive) void load();
    };
    const start = () => {
      if (timer === null) timer = setInterval(run, cadenceMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    run();
    start();
    const onVisibility = () => {
      if (!alive) return;
      if (document.visibilityState === "hidden") stop();
      else {
        run();
        start();
      }
    };
    if (typeof document !== "undefined" && "addEventListener" in document) {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      alive = false;
      stop();
      if (typeof document !== "undefined" && "addEventListener" in document) {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [load, cadenceMs]);

  return { data, error, loadedOnce, updatedAt, cadenceMs, load };
}

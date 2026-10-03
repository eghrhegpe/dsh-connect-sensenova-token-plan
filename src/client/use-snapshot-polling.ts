/**
 * The quota snapshot polling hook — the stateful half of `PanelPage`.
 *
 * Extracted from `panel-page.ts` so the polling machinery (the
 * generation-guarded `load`, the cadence the Host states, the unmount teardown)
 * lives in one testable seam instead of inside the 438-line component. The loop
 * itself — the interval, the hidden-tab pause, the error back-off — is the
 * shared one in `use-polling-interval.ts`, which the Raccoon tab drives too.
 * The hook returns exactly the five values the rest of the panel renders from;
 * it owns no JSX.
 *
 * The correctness notes below are WHY, not WHAT: each guards a real failure
 * mode that is invisible in the code alone.
 * @module dsh-connect-sensenova-token-plan/use-snapshot-polling
 */
import { useEffect, useCallback, useRef, useState } from "./runtime.ts";
import { errorOfStatus, interpretSnapshot, type SnapshotFailure } from "./snapshot.ts";
import { statedCadenceMs, errorText } from "./format.ts";
import { usePollingInterval } from "./use-polling-interval.ts";
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
        ...(controller ? { signal: controller.signal } : {})
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
      setError(errorText(reason));
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

  // One effect owns the whole polling cycle, and the loop itself is the shared
  // one (see `use-polling-interval.ts`): stop while the tab is hidden, back off
  // to a minute while the last answer was a failure. Re-running on `cadenceMs`
  // is what lets a changed rate take effect without a reload.
  //
  // The `failed` back-off is the read-side half of a discipline the Host already
  // keeps on the write side (its throttle store backs off after a refusal, per
  // PITFALLS §6): without it, a Host that is down is re-asked at full cadence
  // every 30 s until the panel closes, and the error line it shows is the only
  // thing telling the user anything went wrong.
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

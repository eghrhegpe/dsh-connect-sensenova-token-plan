/**
 * The quota snapshot polling hook — the stateful half of `PanelPage`.
 *
 * Extracted from `panel-page.ts` so the polling machinery (the
 * generation-guarded `load`, the cadence the Host states, the unmount teardown)
 * lives in one testable seam instead of inside the `PanelPage` component. That
 * machinery lives one level down, in `use-remote-read.ts`: the generation guard,
 * the abort handle, the request, the stated cadence and the teardown are shared
 * with the composer pill's Raccoon balance reader, because a hand-kept second
 * copy of that body is exactly the drift `duplication-gate.mjs` exists to refuse.
 * The loop
 * itself — the interval, the hidden-tab pause, the error back-off — is the
 * shared one in `use-polling-interval.ts`, which the Raccoon tab drives too.
 * The hook returns exactly the five values the rest of the panel renders from;
 * it owns no JSX.
 *
 * What stays HERE is the snapshot's own reading: `interpretSnapshot` and
 * `errorOfStatus` decide what a body means, and the STRUCTURED failure they
 * produce travels straight out through the core rather than through a string —
 * the panel is the only consumer of `{ message, code, auth }`, and the guidance
 * line and the auth prompt both read those fields. That is why `F` here is
 * `SnapshotFailure | string`: the core carries whatever a route produces, and
 * only a thrown fetch (which has no structure) ever contributes the string.
 *
 * The correctness notes below are WHY, not WHAT: each guards a real failure
 * mode that is invisible in the code alone.
 * @module dsh-connect-sensenova-token-plan/use-snapshot-polling
 */
import { errorOfStatus, interpretSnapshot, type SnapshotFailure } from "./snapshot.ts";
import { useRemoteRead, type RemoteRoute, type RemoteRead } from "./use-remote-read.ts";
import { SNAPSHOT_PATH } from "./const.ts";
import type { SnapshotData } from "./wire.ts";

/**
 * The snapshot route, read through the shared polling core.
 *
 * Module scope on purpose: the core's `load` closes over this route, so a fresh
 * literal per render would rebuild the callback on every render and restart the
 * poll interval with it. The same reason the Raccoon pill's route is
 * module-scoped.
 *
 * `parse` is PURE — it runs inside the core's load, and a reader that keeps
 * state here would write state during another hook's callback. The structured
 * failure it produces is therefore returned, not stored.
 */
const SNAPSHOT_ROUTE: RemoteRoute<SnapshotData, SnapshotFailure | string> = {
  path: SNAPSHOT_PATH,
  parse: (body, status): RemoteRead<SnapshotData, SnapshotFailure | string> => {
    // A non-2xx carries no body, so the status is the only clue, and the Host's
    // own reading of it (`errorOfStatus`) is the one that keeps the sign-in
    // form on screen for 401/403 instead of leaving a bare status code.
    if (status < 200 || status >= 300) {
      return { value: null, failure: errorOfStatus(status) };
    }
    const read = interpretSnapshot(body);
    if (read.data === null) {
      return { value: null, failure: read.error };
    }
    return {
      value: read.data,
      failure: null,
      // The Host states the rate on every snapshot; the panel follows it so it
      // never runs at a cadence that contradicts the freshness it displays.
      cadenceSeconds: read.data.pollSeconds
    };
  }
};

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
  // `error` is read on the SAME state that carries `data`, so the two can never
  // disagree about which attempt they describe — the panel's guidance line and
  // the numbers beside it come from one answer or from the previous one, never
  // from a mix. That is also why the core keeps `data` on a failure instead of
  // clearing it: a panel whose read times out must keep the last pools it
  // actually received rather than flashing the setup form.
  const { data, error, loadedOnce, updatedAt, cadenceMs, load } =
    useRemoteRead<SnapshotData, SnapshotFailure | string>(SNAPSHOT_ROUTE, defaultCadenceMs);
  return { data, error, loadedOnce, updatedAt, cadenceMs, load };
}

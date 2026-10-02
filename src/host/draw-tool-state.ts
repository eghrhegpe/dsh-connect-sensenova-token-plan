/**
 * The draw tool's mount-time absence note, in memory only.
 *
 * `registerDrawTool` (lifecycle.ts) is the single place that decides whether
 * the opt-in draw tool actually got registered. Three of its bail-outs are
 * "the tool is absent" with the switch visibly on:
 *
 *   - the Host exposes no `tools` service (or its `register` is not a
 *     function) — a NORMAL absence, nothing is broken, but the panel's copy
 *     already has a line for it (`draw.noTools`) that was never wired to any
 *     signal;
 *   - the tools peer module failed to load — already logged via `degrade`;
 *   - the registry refused the registration — already logged via `degrade`.
 *
 * Only the FIRST is a normal fact the panel should state (the other two are
 * Host bugs, and their traces belong in the log, not the copy). This module
 * holds exactly that one bit.
 *
 * It is the WRITER's home: `registerDrawTool` sets it, and the snapshot route
 * (`routes/snapshot.ts`) injects `() => drawToolAbsent()` into
 * `buildSnapshotBody`, so the aggregator itself never imports this module and
 * stays pure — the same closure-injection pattern as `drawSwitch`. If the full
 * three-reason version ever lands, the holder widens from a boolean to a note
 * code and nothing else moves.
 *
 * In memory and NOT profile-scoped on purpose: it is a per-mount diagnostic,
 * recomputed on every Host (re)mount by `registerDrawTool`, never persisted.
 * Same in-memory discipline as `providerState.error`.
 * @module dsh-connect-sensenova-token-plan/draw-tool-state
 */

let absent = false;

/** Clear the note — called at the top of every registration attempt. */
export function resetDrawToolState(): void {
  absent = false;
}

/** Record that the draw switch is on but no tools service could be found. */
export function markDrawToolAbsent(): void {
  absent = true;
}

/** The snapshot's draw block reads this once per poll. */
export function drawToolAbsent(): boolean {
  return absent;
}
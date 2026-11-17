/**
 * The Raccoon **desktop direct-read** switch — this plugin's OWN state file,
 * exactly like `raccoon-web-store.ts`.
 *
 * What it gates is one question: may the Host look at the official App's
 * `auth.json` at all? OFF by default (invariant 1: every module opt-in), and
 * the panel holds the single saved answer. It is NOT a source selector: the
 * precedence rule lives in `raccoon-store.ts` (fresh desktop file → else the
 * QR credential), so flipping this switch never destroys anything — with it on,
 * the scanned credential keeps sitting in its own slot untouched, and turning
 * it off hands control straight back to that scan without a re-login.
 *
 * Payload shape and integrity discipline are the shared
 * {@link createBooleanSwitchStore}'s (see `switch-store.ts`, ADR-006); this
 * file is the switch's identity only.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-desktop-store
 */
import { createBooleanSwitchStore } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_DESKTOP_SWITCH_VERSION = 1;

/** Every persisted shape THIS build can read (current + history). */
export const KNOWN_RACCOON_DESKTOP_SWITCH_VERSIONS: readonly number[] = [1];

/**
 * The file-backed switch.
 * @param {object} [options] - {@link StoreOptions}.
 * @returns {object} the store (`enabled` / `isSet` / `save` / `forget`).
 */
export function createFileRaccoonDesktopStore(options: StoreOptions = {}) {
  return createBooleanSwitchStore({
    label: "raccoon-desktop-switch",
    refusalLabel: "the raccoon desktop switch",
    file: "raccoon-desktop.json",
    version: RACCOON_DESKTOP_SWITCH_VERSION,
  }, options);
}

/**
 * The Raccoon `web_search` provider switch — this plugin's OWN state file, like
 * `raccoon-desktop-store.ts`. Opt-in independently: registering a second
 * `ctx.web` search provider changes DSH's `web_search` routing, so the switch
 * is OFF by default and the panel holds the one saved answer.
 *
 * The payload shape, the atomic write, the owner-only modes, and the
 * "anything unrecognised reads as not set" rule are shared with every other
 * boolean switch — they live in `switch-store.ts`'s
 * {@link createBooleanSwitchStore}; this file is the switch's identity only.
 *
 * No legacy inheritance here: this switch post-dates the profile segmentation,
 * so there is no shared-directory value to adopt.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-web-store
 */
import { createBooleanSwitchStore } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_WEB_SWITCH_VERSION = 1;

/** Every persisted shape THIS build can read (current + history). */
export const KNOWN_RACCOON_WEB_SWITCH_VERSIONS: readonly number[] = [1];

/**
 * The file-backed switch.
 * @param {object} [options] - {@link StoreOptions}.
 * @returns {object} the store (`enabled` / `isSet` / `save` / `forget`).
 */
export function createFileRaccoonWebStore(options: StoreOptions = {}) {
  return createBooleanSwitchStore({
    label: "raccoon-web-switch",
    refusalLabel: "the raccoon web-search switch",
    file: "raccoon-web-search.json",
    version: RACCOON_WEB_SWITCH_VERSION,
  }, options);
}

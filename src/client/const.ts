/** Ids and same-origin routes the client half talks to. */

/** Dictionary namespace this plugin owns. */
export const NS = "dsh-connect-sensenova-token-plan";

/**
 * The plugin slug. Carried by the coin glyph's `data-dsh-panel-entry` marker
 * (see `cards.ts`) so the card's icon stays tied to this plugin. It is NOT a
 * sidebar row id or a slot key — the card registers under `key: NS`.
 */
export const PANEL_ID = "dsh-connect-sensenova-token-plan";

/** The Host snapshot route. Relative, same-origin. */
export const SNAPSHOT_PATH = "/api/dsh-connect-sensenova-token-plan/snapshot";

/** The account route: lets the panel configure itself, no `.env` editing. */
export const ACCOUNT_PATH = "/api/dsh-connect-sensenova-token-plan/account";

/** The inference API-key route: saves the `sk-` key the provider uses. */
export const API_KEY_PATH = "/api/dsh-connect-sensenova-token-plan/api-key";

/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
export const PROVIDER_PATH = "/api/dsh-connect-sensenova-token-plan/provider";

/** The model-roster route: which of this key's models get pushed to DSH. */
export const MODELS_PATH = "/api/dsh-connect-sensenova-token-plan/models";

/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
export const DRAW_PATH = "/api/dsh-connect-sensenova-token-plan/draw";

/** The Raccoon provider route (second upstream provider, ROADMAP §6.1). */
export const RACCOON_PATH = "/api/dsh-connect-sensenova-token-plan/raccoon";

/**
 * The official sign-up / Token Plan console entry. The panel points new
 * users here to register and obtain their free quota (account + API key).
 * A plain public URL — the client only ever opens it in a new tab, never
 * sends it in a credentialed request.
 */
export const SENSENOVA_SIGNUP_URL = "https://www.sensenova.cn/token-plan";

/**
 * The Raccoon gateway's own site (desktop client download / limited-time
 * credits). Same discipline as {@link SENSENOVA_SIGNUP_URL}: a plain public
 * URL, opened in a new tab only, never used in a credentialed request.
 */
export const RACCOON_SITE_URL = "https://xiaohuanxiong.com/";

/**
 * The Raccoon read operations: normalize a catalogue row, fetch the live
 * catalogue, and read the credit balance.
 *
 * What binds these three together is not a call site but a decision they share:
 * a gateway read that comes back unusable degrades to `null` (the caller falls
 * back to the static roster / shows nothing) rather than throwing, and a
 * *successful* read that simply lists nothing is NOT a failure — the `onFail`
 * split is what lets the panel say "the gateway offered nothing" instead of
 * "the gateway is down".
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-catalog
 */

import { obj, num, str } from "./util.ts";
import { RACCOON_API_BASE, RACCOON_LLM_PREFIX, RACCOON_POINTS_PREFIX, RACCOON_REQUEST_TIMEOUT_MS } from "./raccoon-consts.ts";
import { raccoonHeaders, parseRaccoonEnvelope } from "./raccoon-http.ts";

/**
 * Where a row's vision verdict came from — surfaced so the panel never states
 * a capability more confidently than it was established.
 *
 * - `measured` — a probe saw this id read the probe image.
 * - `declared` — the gateway's own tags (or the legacy booleans) say so.
 * - `assumed`  — nothing was established: the row is offered as image-capable
 *   by default (see `raccoonRowVision`), and the panel labels it as unverified.
 * - `denied`   — a probe saw this id answer "cannot see the image".
 */
export type RaccoonVisionSource = "measured" | "declared" | "assumed" | "denied";

/**
 * Raccoon models that ARE image-capable on the gateway even though the
 * catalogue does not say so.
 *
 * The gateway's `tags` array is the current authority for vision ability, but
 * it is not exhaustive: `sn-deepseek-v4-1-flash` carries no vision tag and yet
 * answered a `chat/completions` request carrying an `image_url` part with
 * HTTP 200 on 2026-10-04 (it described the picture correctly), and
 * `sn-glm-5-3-flash` did the same on 2026-10-06 (it named all four stripes of
 * the probe image). This set holds the models whose image support was PROBED
 * rather than declared.
 *
 * Since 2026-10-22 an unprobed row defaults to image-capable, so membership is
 * no longer what grants the flag — it is the provenance the panel prints
 * (`visionSource: "measured"`): these rows were checked, the others are only
 * assumed. The distinction still earns its keep, because a model that was
 * probed and then started refusing images has to be moveable into the denylist
 * without being confused with the rows nobody ever looked at.
 *
 * `sn-deepseek-v4-1-flash-1017` is the dated build the gateway lists BESIDE
 * the untagged original (both rows are visible today; the 1017 row is the one
 * on promotion). Its tags are the same vision-less set
 * (`general` / `code` / `html` / `analysis` / `reasoning` / `auto`), and it
 * named all four stripes on 2026-10-22 — a probe of its OWN, because the
 * suffix is a build id: a future `-1103` (or a renamed sibling) is a different
 * wire id and must be measured again rather than inferred from this entry. A
 * name-prefix rule here would be exactly the "belief" this set exists to
 * refuse.
 * @type {ReadonlySet<string>}
 */
export const RACCOON_VISION_WHITELIST: ReadonlySet<string> = Object.freeze(new Set([
  "sn-deepseek-v4-1-flash",
  "sn-deepseek-v4-1-flash-1017",
  "sn-glm-5-3-flash"
]));

/**
 * Raccoon models the catalogue TAGS as image-capable that a probe found blind
 * — the reason a tag is not a declaration of capability but a claim about it.
 *
 * The two directions cost differently: a missing flag hides a capability from
 * the picker (silently — 2026-10-22: a newly added `-1017` build lost its image
 * entry with no signal at all), while a WRONG flag sends the user's image to a
 * model that cannot look at it and the model answers **HTTP 200** and then says
 * it cannot see the picture, so no layer reports an error and the user reads it
 * as their own mistake (2026-10-06 report: "glm-5.3 不能看图却显示可以看图").
 *
 * That second failure is why the flag still has a denylist even though the
 * default is now "assume capable": the default makes the silent loss
 * impossible, and this set is the only thing standing between a blind model
 * and the user's image. Which is also why the panel labels an unprobed row as
 * unverified instead of printing a plain "vision" chip.
 *
 * `sn-glm-5-3` is the measured case: its row carries `vision` among its tags,
 * yet a `chat/completions` request with an `image_url` part answered
 * 「无法查看图片（当前环境不支持图像识别）」in all three shapes tried — sync,
 * image-part-first, and `stream: true`. The SAME payload was read correctly in
 * the same run by `sn-glm-5-3-flash`, `sn-kimi-k3` and
 * `sn-deepseek-v4-1-flash`, which is what rules out the payload as the cause.
 *
 * Membership is a MEASUREMENT with a date, not a verdict about the model: a
 * denial is as load-bearing as an addition, so it needs a real probe too, and
 * the day the gateway routes this id to a seeing backend the live harness
 * (`test/live-raccoon.mjs`, L2e) turns red and the entry comes out.
 * @type {ReadonlySet<string>}
 */
export const RACCOON_VISION_DENYLIST: ReadonlySet<string> = Object.freeze(new Set([
  "sn-glm-5-3"
]));

/**
 * The vision verdict AND its provenance for a raw catalogue row.
 *
 * Precedence is measured first, then declared, then a permissive default:
 *
 * 1. the probe DENYLIST — a measured "cannot see" (the only rung that says no);
 * 2. the probe WHITELIST — a measured "can see";
 * 3. the row's own declaration — `tags` (`vision` / `image` /
 *    `image-understanding`), then the legacy `vision` boolean and
 *    `input_modalities`;
 * 4. nothing at all — **assume capable** (`assumed`).
 *
 * Rung 4 used to be "assume blind", and that is the change of 2026-10-22: the
 * gateway's tag set is not reliable in either direction (it misses real vision
 * models and it tags a blind one), so an untagged row says nothing about the
 * model. Assuming blind made every gateway addition fake a missing feature —
 * the user sees no image entry and no reason why, and only a report fixes it.
 * Assuming capable moves the cost to where the signal exists: if the model
 * really cannot see, it says so in its reply (HTTP 200, model-level refusal),
 * the user reads it as a capability gap rather than a broken plugin, and the
 * row is moved into the denylist. Provenance is reported alongside so the
 * panel can say "unverified" instead of asserting the capability.
 *
 * The declaration rung's own field order is measured too: the gateway's
 * current `/api/web/llm/v2/model_catalog` carries NO `vision` boolean and NO
 * `input_modalities` array at all — the ability lives in `tags` (the client
 * normalises `image` / `image-understanding` into `vision` the same way, see
 * the desktop App bundle). The legacy branches stay as a defensive ladder in
 * case the catalogue drifts back to the older shape. `tags` is read
 * case-sensitively — the gateway spells it lowercase, and a case-insensitive
 * read would paper over a shape drift instead of flagging it.
 * @param {object} model - a raw `categories[].models[]` entry.
 * @returns {{vision: boolean, source: RaccoonVisionSource}} the verdict.
 */
export function raccoonVisionVerdict(model: any): { vision: boolean; source: RaccoonVisionSource } {
  const id = str(model.model_name, "") || str(model.id, "") || str(model.name, "");
  if (RACCOON_VISION_DENYLIST.has(id)) return { vision: false, source: "denied" };
  if (RACCOON_VISION_WHITELIST.has(id)) return { vision: true, source: "measured" };
  const tags = Array.isArray(model.tags) ? model.tags : [];
  if (tags.some((tag: unknown) => tag === "vision" || tag === "image" || tag === "image-understanding")) {
    return { vision: true, source: "declared" };
  }
  if (model.vision === true) return { vision: true, source: "declared" };
  if (Array.isArray(model.input_modalities) && model.input_modalities.includes("image")) {
    return { vision: true, source: "declared" };
  }
  return { vision: true, source: "assumed" };
}

/**
 * Whether a raw catalogue row reads as image-capable.
 * @param {object} model - a raw `categories[].models[]` entry.
 * @returns {boolean} true when the model may be offered image input.
 */
export function raccoonRowVision(model: any): boolean {
  return raccoonVisionVerdict(model).vision;
}

/**
 * The gateway's credit multiplier for one catalogue row, promotion-aware.
 *
 * The gateway ships BOTH a list price and an effective price, and the desktop
 * client renders the two together (the effective price, with the list price
 * struck through) rather than the list price alone — a `limited_free` model
 * carries `billing_multiplier: 0.5` beside `billing_effective_multiplier: 0`,
 * and quoting 0.5 to the user would misstate what a turn actually costs.
 * Quoting 0 would misstate the other way once the promotion lapses, so the
 * LIST price is carried alongside as `original` for the panel to show.
 *
 * The status set is the one the desktop client accepts (`normal` /
 * `discount` / `limited_free`); anything else is treated as undeclared. The
 * promotion fields are emitted ONLY for the two promotion states, so a
 * `normal` row keeps the pre-existing row shape.
 * @param {object} model - a raw `categories[].models[]` entry.
 * @returns {{multiplier?: number, original?: number, status?: "discount"|"limited_free", note?: string}}
 */
export function raccoonEffectiveMultiplier(model: any): { multiplier?: number; original?: number; status?: "discount" | "limited_free"; note?: string } {
  const base =
    typeof model.billing_multiplier === "number" ? model.billing_multiplier
      : typeof model.multiplier === "number" ? model.multiplier
        : undefined;
  const rawStatus = model.billing_status;
  const status = rawStatus === "discount" || rawStatus === "limited_free" ? rawStatus : undefined;
  const effective = typeof model.billing_effective_multiplier === "number" ? model.billing_effective_multiplier : undefined;
  const promoted = status !== undefined && effective !== undefined;
  const note = typeof model.billing_status_note === "string" ? model.billing_status_note.trim() : "";
  return {
    multiplier: promoted ? effective : base,
    ...(promoted && base !== undefined ? { original: base } : {}),
    ...(promoted ? { status } : {}),
    ...(promoted && note !== "" ? { note } : {})
  };
}

/**
 * Fetch the live model catalogue, or `null` when it cannot be read OR when it
 * read fine but lists no visible model.
 *
 * The adapter falls back to a static roster in both cases, so a transient
 * catalogue outage degrades to the known-good models instead of breaking the
 * provider — the silent-fallback discipline of `console-client`. The two cases
 * are still distinguishable to the caller: `onFail` fires ONLY on a genuine
 * read failure (network / HTTP / envelope error), NOT on a successful read
 * that simply has no visible model — that split is what lets the panel say
 * "the gateway offered nothing" instead of "the gateway is down".
 * @param {object} credential - `{ access_token }`.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @param {(why: string) => void} [onFail] - fired on a genuine read failure.
 * @returns {Promise<object[]|null>} the normalized `[{id, name, multiplier, vision, contextWindow, maxOutputLength}]`, or `null`.
 */
export async function fetchRaccoonCatalog(credential: any, fetcher?: typeof fetch, onFail?: (why: string) => void) {
  const effective = fetcher ?? globalThis.fetch;
  try {
    const response = await effective(
      `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}/model_catalog`,
      { headers: raccoonHeaders(credential), signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
      onFail?.(`HTTP ${response.status}`);
      return null;
    }
    const envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
    if (envelope.code !== 0 || envelope.data === null) {
      onFail?.(`envelope code=${envelope.code} message=${envelope.message}`);
      return null;
    }
    const categories = Array.isArray(envelope.data.categories) ? envelope.data.categories : [];
    for (const category of categories) {
      if (obj(category).type !== "chat") continue;
      const models = Array.isArray(obj(category).models) ? obj(category).models : [];
      const seen = new Set();
      const out: object[] = [];
      for (const raw of models) {
        const model = obj(raw);
        if (model.visible === false) continue;
        // The id must be the machine id, never the display name: the gateway spells
        // it `model_name` today, the older catalogue shape used `id`, and `name`
        // is the weakest candidate precisely because it can be a display string
        // ("DeepSeek-V4.1-Flash") rather than the wire id (`sn-deepseek-v4-1-flash`).
        const id = str(model.model_name, "") || str(model.id, "") || str(model.name, "");
        if (id === "" || seen.has(id)) continue;
        seen.add(id);
        const params = obj(model.params);
        const billing = raccoonEffectiveMultiplier(model);
        const verdict = raccoonVisionVerdict(model);
        out.push({
          id,
          name: str(model.name, id),
          multiplier: billing.multiplier,
          ...(billing.original !== undefined ? { originalMultiplier: billing.original } : {}),
          ...(billing.status !== undefined ? { billingStatus: billing.status } : {}),
          ...(billing.note !== undefined ? { billingStatusNote: billing.note } : {}),
          vision: verdict.vision,
          // Always reported: an "assumed" row is the one the panel must not
          // badge as a known capability, so the absence of this field can only
          // mean "older producer", never "verified".
          visionSource: verdict.source,
          contextWindow: num(params.context_window ?? model.context_window ?? model.context_length),
          maxOutputLength: num(params.max_tokens ?? params.max_output_tokens ?? model.max_output_tokens ?? model.max_output_length)
        });
      }
      if (out.length > 0) return out;
    }
    // A successful read that lists no visible model is NOT a failure — the
    // gateway deliberately hid its catalog; the panel must not read it as an
    // outage. Fall through to `null` without firing `onFail`.
    return null;
  } catch (why) {
    onFail?.(why instanceof Error ? `${why.name}: ${why.message}` : String(why));
    return null;
  }
}

/**
 * Read the account's credit balance. Read-only: the gateway has NO endpoint
 * for the daily 300-point grant (the server awards it automatically as
 * `daily_grant`), so the panel must not offer a check-in button.
 *
 * The read carries the gateway's own breakdown of that total (the live
 * envelope declares `available_points` beside `daily_points`,
 * `reward_points`, `monthly_points`, `topup_points`): a part is reported
 * only when the gateway declared it — a zero is a fact, so it is reported
 * too, and the panel decides what to show.
 * @param {object} credential - `{ access_token }` (or the parsed store shape).
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object|null>} `{ total, daily?, reward?, monthly?, topup? }` or `null` when unreadable.
 */
export async function fetchRaccoonBalance(credential: any, fetcher?: typeof fetch, onFail?: (why: string) => void) {
  const effective = fetcher ?? globalThis.fetch;
  try {
    const response = await effective(
      `${RACCOON_API_BASE}${RACCOON_POINTS_PREFIX}/balance`,
      { headers: raccoonHeaders(credential), signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      // A 401 body distinguishes "the gateway never saw our Authorization"
      // (`authorization_empty_error`) from "it saw one and rejected it"
      // (`invalid_token` / a JWT reason). That split decides whether the fault
      // is in the transport (a header-stripping fetch) or the token itself.
      onFail?.(`HTTP ${response.status} ${bodyText.slice(0, 160)}`);
      return null;
    }
    const envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
    if (envelope.code !== 0 || envelope.data === null) {
      onFail?.(`envelope code=${envelope.code} message=${envelope.message}`);
      return null;
    }
    const total = numOrNullSafe(envelope.data.available_points ?? envelope.data.balance ?? envelope.data.available ?? envelope.data.amount);
    // The returned shape is declared, not inferred from `{ total }`: a part is
    // added only when the gateway declared it, so the fields must stay optional
    // (reading them off a `{ total }` literal is a type error, and widening the
    // literal afterwards would type them as always-present non-optional).
    const read: { total: number | null; daily?: number; reward?: number; monthly?: number; topup?: number } = { total };
    const daily = numOrNullSafe(envelope.data.daily_points);
    const reward = numOrNullSafe(envelope.data.reward_points);
    const monthly = numOrNullSafe(envelope.data.monthly_points);
    const topup = numOrNullSafe(envelope.data.topup_points);
    if (daily !== null) read.daily = daily;
    if (reward !== null) read.reward = reward;
    if (monthly !== null) read.monthly = monthly;
    if (topup !== null) read.topup = topup;
    return read;
  } catch (why) {
    onFail?.(why instanceof Error ? `${why.name}: ${why.message}` : String(why));
    return null;
  }
}

/** Read a finite number (0 counts), else `null`. */
function numOrNullSafe(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

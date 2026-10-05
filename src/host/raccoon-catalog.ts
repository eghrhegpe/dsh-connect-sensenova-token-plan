/**
 * The Raccoon read operations: normalize a catalogue row, fetch the live
 * catalogue, and read the credit balance.
 *
 * Split out of the former single `raccoon.ts` (2026-10-05). What binds these
 * three together is not a call site but a decision they share: a gateway read
 * that comes back unusable degrades to `null` (the caller falls back to the
 * static roster / shows nothing) rather than throwing, and a *successful* read
 * that simply lists nothing is NOT a failure — the `onFail` split is what lets
 * the panel say "the gateway offered nothing" instead of "the gateway is down".
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-catalog
 */

import { obj, num, str } from "./util.ts";
import { RACCOON_API_BASE, RACCOON_LLM_PREFIX, RACCOON_POINTS_PREFIX } from "./raccoon-consts.ts";
import { raccoonHeaders, parseRaccoonEnvelope } from "./raccoon-http.ts";

/**
 * Raccoon models that ARE image-capable on the gateway even though the
 * catalogue does not say so.
 *
 * The gateway's `tags` array is the current authority for vision ability, but
 * it is not exhaustive: `sn-deepseek-v4-1-flash` carries no vision tag and yet
 * answered a `chat/completions` request carrying an `image_url` part with
 * HTTP 200 on 2026-10-04 (it described the picture correctly). This set holds
 * the models whose image support was PROBED rather than declared, so the
 * picker keeps offering them pictures instead of silently dropping the
 * attachment. Adding a model here requires a real probe, not a belief.
 * @type {ReadonlySet<string>}
 */
export const RACCOON_VISION_WHITELIST: ReadonlySet<string> = Object.freeze(new Set([
  "sn-deepseek-v4-1-flash"
]));

/**
 * Whether a raw catalogue row reads as image-capable.
 *
 * Field precedence is measured, not guessed: the gateway's current
 * `/api/web/llm/v2/model_catalog` carries NO `vision` boolean and NO
 * `input_modalities` array at all — the ability lives in `tags` (the client
 * normalises `image` / `image-understanding` into `vision` the same way, see
 * the desktop App bundle). The whitelist is checked FIRST because a probe
 * beats a declaration; the legacy branches stay as a defensive ladder in case
 * the catalogue drifts back to the older shape. `tags` is read case-sensitively
 * — the gateway spells it lowercase, and a case-insensitive read would paper
 * over a shape drift instead of flagging it.
 * @param {object} model - a raw `categories[].models[]` entry.
 * @returns {boolean} true when the model may be offered image input.
 */
export function raccoonRowVision(model: any): boolean {
  const id = str(model.model_name, "") || str(model.id, "") || str(model.name, "");
  if (RACCOON_VISION_WHITELIST.has(id)) return true;
  const tags = Array.isArray(model.tags) ? model.tags : [];
  if (tags.some((tag: unknown) => tag === "vision" || tag === "image" || tag === "image-understanding")) return true;
  if (model.vision === true) return true;
  return Array.isArray(model.input_modalities) ? model.input_modalities.includes("image") : false;
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
      { headers: raccoonHeaders(credential), signal: AbortSignal.timeout(30_000) }
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
        out.push({
          id,
          name: str(model.name, id),
          multiplier: billing.multiplier,
          ...(billing.original !== undefined ? { originalMultiplier: billing.original } : {}),
          ...(billing.status !== undefined ? { billingStatus: billing.status } : {}),
          ...(billing.note !== undefined ? { billingStatusNote: billing.note } : {}),
          vision: raccoonRowVision(model),
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
      { headers: raccoonHeaders(credential), signal: AbortSignal.timeout(30_000) }
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

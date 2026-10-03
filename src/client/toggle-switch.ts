/**
 * The shared on/off control: a sliding toggle with a short label and a
 * tooltip that carries the explanation.
 *
 * WHY this exists rather than a native checkbox: the plugin's three
 * registration switches (provider, draw tool, Raccoon) each rendered a bare
 * `<input type="checkbox">` followed by a parenthetical sentence — `启用小浣熊
 * 提供方（向 DSH 注册模型）`. That label is the length of a footnote, so the
 * control read as a line of prose with a box in front of it, not as a switch:
 * nothing on screen said "toggle", and the explanation lived inside the label
 * instead of doing its job as one. The sibling Qoder plugin solved exactly this
 * with a real sliding toggle plus a short label plus a `title` tooltip; this is
 * the same shape, drawn with this plugin's own brand accent.
 *
 * The hidden `<input type="checkbox">` is NOT decoration — it is load-bearing
 * in three ways, and every one is why it stays rather than a `role="switch"`
 * div being invented:
 *   - it is the real control: keyboard focus, Space to flip, and the browser's
 *     own checked semantics come from it, not from a re-implementation;
 *   - the implicit label (the input sits inside the `<label>`) is the
 *     accessible name, so the input carries NO `aria-label` — which is the
 *     contract `test/render.test.mjs` relies on to tell the switch apart from
 *     the roster's own checkboxes (the switch is the only `type="checkbox"`
 *     with no `aria-label`);
 *   - the render suite and the DOM tests match `props.type === "checkbox"`, so
 *     the element must stay a checkbox for those pins to keep meaning anything.
 *
 * The track/thumb are drawn with absolutely-positioned spans over the input
 * (pointer-events: none, so every click lands on the input underneath). This
 * plugin injects no stylesheet, so the toggle cannot be a CSS `::before` like
 * Qoder's — inline styles are the only surface, and a conditional style per
 * state is the honest equivalent.
 * @module dsh-connect-sensenova-token-plan/client/toggle-switch
 */

import { h } from "./runtime.ts";

/** The track is 30×17 with a 12px thumb that travels 13px — the Qoder shape. */
const TRACK_W = 30;
const TRACK_H = 17;
const THUMB = 12;
const TRAVEL = 13;

/** Props for {@link ToggleSwitch}. */
export interface ToggleSwitchProps {
  /** Whether the switch is on. */
  checked: boolean;
  /** Flip it. The input's own change handler calls this; the caller owns the write. */
  onChange: () => void;
  /** The short label beside the toggle — a few words, never a sentence. */
  label: string;
  /** A busy label that replaces `label` while `busy` (e.g. "切换中…"). */
  busyLabel?: string;
  /** Disables the control and dims it; the cursor reads as wait. */
  busy?: boolean;
  /** The tooltip that carries the explanation the label no longer has room for. */
  title?: string;
}

/**
 * A sliding toggle with a short label and a tooltip.
 * @param props - see {@link ToggleSwitchProps}.
 * @returns the `<label>` tree wrapping the real checkbox input.
 */
export function ToggleSwitch({ checked, onChange, label, busyLabel, busy = false, title }: ToggleSwitchProps): unknown {
  const on = checked === true;
  const text = busy && busyLabel !== undefined ? busyLabel : label;
  return h(
    "label",
    {
      style: {
        display: "inline-flex", alignItems: "center", gap: 8, position: "relative",
        cursor: busy ? "wait" : "pointer", opacity: busy ? 0.55 : 1, verticalAlign: "middle"
      },
      ...(title !== undefined && title !== "" ? { title } : {})
    },
    h(
      "span",
      { style: { position: "relative", display: "inline-block", width: TRACK_W, height: TRACK_H, flex: "none" } },
      // The real control, invisible but live: it fills the track so a click or
      // a keyboard focus lands on it, and the drawn track sits on top with
      // pointer-events: none. No aria-label — the wrapping label names it.
      h("input", {
        type: "checkbox",
        checked: on,
        disabled: busy,
        onChange,
        style: { position: "absolute", inset: 0, width: TRACK_W, height: TRACK_H, margin: 0, opacity: 0, cursor: busy ? "wait" : "pointer" }
      }),
      h(
        "span",
        {
          "aria-hidden": "true",
          style: {
            position: "absolute", inset: 0, borderRadius: 999, pointerEvents: "none",
            border: `1px solid ${on ? "var(--sensenova-brand, #6C5CE7)" : "var(--dsw-alias-border-l2, #36373b)"}`,
            background: on ? "var(--sensenova-brand, #6C5CE7)" : "var(--dsw-alias-bg-layer-2, #2a2b31)",
            transition: "background .15s, border-color .15s"
          }
        },
        h("span", {
          style: {
            position: "absolute", top: 1.5, left: 1.5, width: THUMB, height: THUMB, borderRadius: "50%",
            background: on ? "#fff" : "var(--dsw-alias-label-tertiary, #999)",
            transform: on ? `translateX(${TRAVEL}px)` : "translateX(0)",
            transition: "transform .15s, background .15s"
          }
        })
      )
    ),
    h("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-primary, #e6e6e6)" } }, text)
  );
}

/** Time and number formatters. */

/** `HH:MM` for one epoch second. */
export function clock(epoch: unknown): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `MM-DD HH:mm` for one epoch second. */
export function clockLong(epoch: unknown): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A date-aware reset clock: `HH:MM` when the instant lands on today's local
 * date, `MM-DD HH:mm` once it crosses into another day.
 *
 * Why this exists: `clock` was the one shared formatter, so the weekly
 * (`window_7d`) reset — an absolute instant days away — read as "重置 18:10"
 * and looked like it fired later TODAY. A bare time is honest only for the
 * 5-hour window; a reset that crosses midnight must carry its day.
 */
export function when(epoch: unknown): string {
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
  const date = new Date(epoch * 1000);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? clock(epoch) : clockLong(epoch);
}

/**
 * A credit figure as text: 2-decimal precision under 10 000, whole with
 * thousands separators at or above it. The switch is deliberate — a pool
 * limit of 60 000 reads as "60,000", a live balance of 47.5 as "47.5".
 */
export function count(value: unknown): string {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (number >= 10000) return Math.round(number).toLocaleString();
  return String(Math.round(number * 100) / 100);
}

/** Fill a `{token}` template from a dictionary entry. */
export function format(template: string, vars?: Record<string, unknown> | null): string {
  let text = template;
  for (const [key, value] of Object.entries(vars || {})) {
    text = text.split(`{${key}}`).join(String(value));
  }
  return text;
}

/**
 * A token count the way the platform names it: 1048576 → "1M", 65536 → "64K",
 * 128000 → "128K". Returns "" for a figure that is not a positive number, so
 * an unknown value draws no segment instead of a zero.
 *
 * Why two bases: the catalogue mixes them — windows and ceilings arrive as
 * powers of two (1048576), while the plugin's own 128k fallback is the round
 * decimal 128 000. A flat /1000 rounding once printed "1049k" for the 1M
 * window and it read like a placeholder bug; so figures divisible by 1000 keep
 * the decimal reading they were written with, binary-only figures (262144 →
 * 256K, 65536 → 64K) get the binary one, and anything ≥ 1M goes to M.
 */
export function tokenSize(value: unknown): string {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  if (number <= 0) return "";
  if (number >= 1_000_000) return `${Math.round(number / 100_000) / 10}M`;
  if (number % 1000 === 0) return `${number / 1000}K`;
  if (number % 1024 === 0) return `${number / 1024}K`;
  return `${Math.round(number / 1000)}K`;
}
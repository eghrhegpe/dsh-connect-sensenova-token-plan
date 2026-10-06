/**
 * The switch-precedence adjudicator — the ONE dialect for "panel-saved value
 * vs config default" across every opt-in switch.
 *
 * Before this module existed the rule was hand-copied at three call sites in
 * two look-alike dialects (boolean switch vs string preference) plus the
 * source label; a new caller copying the shape was the fourth copy and
 * nothing could see them drift. This suite pins the dialect so a caller
 * inventing its own `?? settings.x` precedence is the odd one out — and now
 * pins the no-config-default dialect too: {@link resolveSwitchOff} serves the
 * Raccoon switch (a never-saved `null` falls to `off` with no fallback), so
 * that read is a named call rather than a caller's bare comparison.
 */
import { resolveSwitchEnabled, resolveSwitchValue, switchSource, resolveSwitchOff } from "../src/host/switch-precedence.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

try {
  // The boolean dialect: panel wins, else config rules, strict boolean out.
  check("no saved panel value falls back to the config default (true)",
    resolveSwitchEnabled(null, true) === true, "null panel + true config");
  check("no saved panel value falls back to the config default (false)",
    resolveSwitchEnabled(null, false) === false, "null panel + false config");
  check("a saved panel value overrides the config default (false wins)",
    resolveSwitchEnabled(false, true) === false, "false panel + true config");
  check("a saved panel value overrides the config default (true wins)",
    resolveSwitchEnabled(true, false) === true, "true panel + false config");
  check("the answer is a strict boolean, never the raw input",
    typeof resolveSwitchEnabled(null, true) === "boolean" &&
      typeof resolveSwitchEnabled(true, false) === "boolean", "");

  // The no-config-default dialect (Raccoon switch): bare panel read, no fallback.
  check("no-default switch: null panel stays off",
    resolveSwitchOff(null) === false, "null panel, no config default");
  check("no-default switch: false panel stays off",
    resolveSwitchOff(false) === false, "false panel, no config default");
  check("no-default switch: true panel turns on",
    resolveSwitchOff(true) === true, "true panel, no config default");

  // The string preference dialect: same precedence, config may be absent.
  check("string preference falls back to the config default",
    resolveSwitchValue(null, "glm-5.2") === "glm-5.2", "null panel + config");
  check("string preference falls back to undefined when config states none",
    resolveSwitchValue(null, undefined) === undefined, "null panel + no config");
  check("string preference panel value wins",
    resolveSwitchValue("kimi-k3", "glm-5.2") === "kimi-k3", "panel over config");

  // The source label rides with every answer.
  check("source is config when the panel never saved",
    switchSource(null) === "config", "");
  check("source is panel when the panel saved a boolean",
    switchSource(false) === "panel", "");
  check("source is panel when the panel saved a string",
    switchSource("glm-5.2") === "panel", "");
} catch (error) {
  fail("switch-precedence", error);
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

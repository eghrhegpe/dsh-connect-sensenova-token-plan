/**
 * The Host-facing mount: dictionary registration and the plugin config card.
 *
 * The panel lives inside the Plugins page (`plugins.bundle.config` slot) —
 * it appears as an inline card between the bundle description and the Loader
 * row, always expanded (`view: "page"` only, no summary state). There is no
 * sidebar entry and no standalone `main` page; the user reaches it by
 * opening the Plugins panel and navigating to this bundle.
 */
import { NS } from "./const.ts";
import { en, zh } from "./i18n.ts";
import { PanelPage } from "./panel-page.ts";
import { ComposerUsagePill } from "./composer-usage-pill.ts";
import type { Tt } from "./runtime.ts";

/** Required services: the slot system, the locale registry. */
export const inject = ["slots", "locale"];

/** The minimal client-root face `apply` touches; the rest of ctx is opaque. */
export interface ClientCtx {
  effect: (fn: () => unknown, name?: string) => unknown;
  locale: {
    register: (ns: string, dicts: { zh: typeof zh; en: typeof en }) => unknown;
    bind: (ns: string) => (key: string) => string;
    subscribe: (fn: () => void) => unknown;
  };
  slots: {
    inject: (slot: string, register: () => unknown) => unknown;
    register: (declaration: Record<string, unknown>, component: unknown) => unknown;
  };
}

/**
 * Register the dictionaries and the plugin config card.
 *
 * The card is rendered inside the Plugins page by the Host's
 * `renderSlot("plugins.bundle.config", …)` call. No `onClose` is passed —
 * the Plugins page owns navigation; the card has no close button.
 */
export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en });
    } catch {
      return () => {};
    }
  }, `${NS}: dictionaries`);

  let translate: Tt = (key) => key;
  try {
    translate = ctx.locale.bind(NS);
  } catch {
    // A shell without the locale service still renders the keys.
  }
  const tt: Tt = (key) => {
    try {
      return translate(key);
    } catch {
      return key;
    }
  };

  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: NS,
            locale: NS,
            inject: () => ({ tt, localeSubscribe: ctx.locale.subscribe.bind(ctx.locale) })
          },
          PanelPage
        )
      ) as () => void
    );
  } catch (error) {
    console.warn(`[${NS}] config card registration failed:`, error);
  }

  // 对话框用量胶囊（ROADMAP §6.3）：`conversation.input.right` 座席。`useProjection`
  // 由 slot 系统自动物化注入（session 作用域严格必需，见 composer-slot-gate.mjs），
  // 这里的 inject 只补插件自己的字典翻译 `tt`。注册失败照 §5 不变量 2 降级：面板
  // 照常用、该模块缺席。
  try {
    disposers.push(
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: `${NS}-composer-pill`,
            locale: NS,
            order: 4,
            inject: () => ({ tt })
          },
          ComposerUsagePill
        )
      ) as () => void
    );
  } catch (error) {
    console.warn(`[${NS}] composer pill registration failed:`, error);
  }

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Already released with its owning declaration.
      }
    }
  }, `${NS}: ui mounts`);
}

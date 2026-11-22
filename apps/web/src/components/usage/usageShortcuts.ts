import { msg } from "gt-react";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageChartMetric } from "./UsageProviderChart";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export type UsageMetric = UsageChartMetric | "limits" | "accounts" | "antigravity";
export const METRIC_OPTIONS = [
  { value: "cost", label: msg("Cost"), command: "usage.cost" },
  { value: "tokens", label: msg("Tokens"), command: "usage.tokens" },
  { value: "limits", label: msg("Limits"), command: "usage.limits" },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

export const USAGE_VIEW_OPTIONS = [
  { value: "cost", label: msg("Cost"), command: "usage.cost", translated: true },
  { value: "tokens", label: msg("Tokens"), command: "usage.tokens", translated: true },
  { value: "limits", label: msg("Limits"), command: "usage.limits", translated: true },
  // oxlint-disable-next-line t3code/no-untranslated-copy -- custom extension tab label stays untranslated to avoid diverging upstream locale files
  { value: "accounts", label: "Accounts", translated: false },
  { value: "antigravity", label: "Antigravity", translated: false },
] as const satisfies readonly {
  value: UsageMetric;
  label: string;
  command?: KeybindingCommand;
  translated: boolean;
}[];

export const WINDOW_OPTIONS = [
  { days: 1, label: msg("Past 24h"), command: "usage.period.day" },
  { days: 7, label: msg("7 days"), command: "usage.period.week" },
  { days: 30, label: msg("30 days"), command: "usage.period.month" },
  { days: 90, label: msg("90 days"), command: "usage.period.quarter" },
] as const;

export function resolveUsageShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
) {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest(
        '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal])',
      ))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}

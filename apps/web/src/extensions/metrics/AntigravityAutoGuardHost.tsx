import { useEffect, useRef } from "react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { extractAntigravityAccounts, findActivationTargets } from "./antigravityQuota.logic";
import {
  readAntigravityActivationLog,
  readAntigravityGuardConfig,
  useAntigravityGuardConfig,
} from "./antigravityConfig";
import { activateAntigravityAccountFamily } from "./antigravityActivator";

export function AntigravityAutoGuardHost(): null {
  const [config] = useAntigravityGuardConfig();
  const isActivatingRef = useRef(false);

  const hasAnyAccountAutoActivate = Object.values(config.accounts).some(
    (account) => account.autoActivate,
  );
  const shouldRun = config.globalAutoActivate && hasAnyAccountAutoActivate;
  const intervalMs = Math.max(1, config.checkIntervalMinutes) * 60 * 1000;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs background timer and wake listeners for automatic Antigravity quota activation
  useEffect(() => {
    if (!shouldRun) return;

    const performCheck = async () => {
      if (isActivatingRef.current) return;
      isActivatingRef.current = true;

      try {
        const currentConfig = readAntigravityGuardConfig();
        const active =
          currentConfig.globalAutoActivate &&
          Object.values(currentConfig.accounts).some((acc) => acc.autoActivate);
        if (!active) return;

        const initialPresentations = appAtomRegistry.get(
          environmentPresentations.presentationsWithProvidersAtom,
        );
        const initialAccounts = extractAntigravityAccounts(initialPresentations, Date.now());

        const readyEnvIds = new Set(
          initialAccounts
            .filter((a) => !a.isHubOnly && a.status === "ready" && a.enabled)
            .map((a) => a.environmentId),
        );

        for (const envId of readyEnvIds) {
          try {
            await runAtomCommand(appAtomRegistry, serverEnvironment.refreshProviders, {
              environmentId: envId,
              input: {},
            });
          } catch {
            // Ignore individual environment refresh errors
          }
        }

        const refreshedPresentations = appAtomRegistry.get(
          environmentPresentations.presentationsWithProvidersAtom,
        );
        const accounts = extractAntigravityAccounts(refreshedPresentations, Date.now());
        const history = readAntigravityActivationLog();
        const targets = findActivationTargets(accounts, currentConfig, history, Date.now());

        for (const target of targets) {
          if (!target.account.instanceId) continue;
          await activateAntigravityAccountFamily({
            environmentId: target.account.environmentId,
            instanceId: target.account.instanceId,
            accountLabel: target.account.displayName,
            familyKey: target.familyKey,
            model: target.model,
            trigger: "auto",
            warmupPrompt: currentConfig.warmupPrompt,
            autoArchiveWarmupThread: currentConfig.autoArchiveWarmupThread,
          });
        }
      } catch {
        // Ignore background guard failures to keep host robust
      } finally {
        isActivatingRef.current = false;
      }
    };

    void performCheck();

    const timer = setInterval(() => {
      void performCheck();
    }, intervalMs);

    const onOnline = () => {
      void performCheck();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void performCheck();
      }
    };

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(timer);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [shouldRun, intervalMs]);

  return null;
}

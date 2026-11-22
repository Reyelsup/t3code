import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTask,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment, environmentProjects } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { newMessageId, newThreadId } from "~/lib/utils";
import { buildNasKeepaliveScheduleInput } from "./antigravityQuota.logic";
import { appendActivationLog } from "./antigravityConfig";

/* oxlint-disable t3code/no-untranslated-copy -- internal activator errors stay in English */

export interface ActivateAccountFamilyParams {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly accountLabel: string;
  readonly familyKey: string;
  readonly model: string;
  readonly trigger: "manual" | "auto";
  readonly warmupPrompt?: string | undefined;
  readonly autoArchiveWarmupThread?: boolean | undefined;
}

export interface ActivationResult {
  readonly success: boolean;
  readonly threadId?: ThreadId | undefined;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

async function resolveActivationProjectId(environmentId: EnvironmentId): Promise<ProjectId> {
  try {
    const scratchResult = await runAtomCommand(appAtomRegistry, projectEnvironment.openScratch, {
      environmentId,
      input: {},
    });
    if (scratchResult._tag === "Success" && scratchResult.value?.id) {
      return scratchResult.value.id;
    }
  } catch {
    // Fall back to first available project if scratch cannot be opened.
  }

  const allProjects = appAtomRegistry.get(environmentProjects.projectsAtom);
  const existing = allProjects.find((p) => p.environmentId === environmentId);
  if (existing?.id) {
    return existing.id;
  }

  throw new Error(`No available project on environment ${environmentId} to run warmup turn.`);
}

export async function activateAntigravityAccountFamily(
  params: ActivateAccountFamilyParams,
): Promise<ActivationResult> {
  const startMs = Date.now();
  try {
    const projectId = await resolveActivationProjectId(params.environmentId);
    const threadId = newThreadId();
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    const prompt = params.warmupPrompt ?? "Reply with OK.";
    const title = `[AG Warmup] ${params.familyKey} (${params.accountLabel})`;

    const startTurnResult = await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, {
      environmentId: params.environmentId,
      input: {
        threadId,
        message: {
          messageId,
          role: "user",
          text: prompt,
          attachments: [],
        },
        modelSelection: {
          instanceId: params.instanceId,
          model: params.model,
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title,
            modelSelection: {
              instanceId: params.instanceId,
              model: params.model,
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });

    if (startTurnResult._tag === "Failure") {
      throw new Error("Failed to dispatch warmup turn to server.");
    }

    if (params.autoArchiveWarmupThread !== false) {
      try {
        await runAtomCommand(appAtomRegistry, threadEnvironment.archive, {
          environmentId: params.environmentId,
          input: { threadId },
        });
      } catch {
        // Non-fatal if archiving fails.
      }
    }

    try {
      await runAtomCommand(appAtomRegistry, serverEnvironment.refreshProviders, {
        environmentId: params.environmentId,
        input: { instanceId: params.instanceId },
      });
    } catch {
      // Non-fatal if refresh fails.
    }

    // Re-probe once the 1-token warmup turn has likely metered so the new resetsAt countdown appears.
    setTimeout(() => {
      void runAtomCommand(appAtomRegistry, serverEnvironment.refreshProviders, {
        environmentId: params.environmentId,
        input: { instanceId: params.instanceId },
      }).catch(() => {});
    }, 6_000);

    const durationMs = Date.now() - startMs;
    appendActivationLog({
      environmentId: params.environmentId,
      instanceId: params.instanceId,
      accountLabel: params.accountLabel,
      familyKey: params.familyKey,
      model: params.model,
      trigger: params.trigger,
      outcome: "success",
      durationMs,
      threadId,
    });

    return {
      success: true,
      threadId,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMessage = err instanceof Error ? err.message : String(err);
    appendActivationLog({
      environmentId: params.environmentId,
      instanceId: params.instanceId,
      accountLabel: params.accountLabel,
      familyKey: params.familyKey,
      model: params.model,
      trigger: params.trigger,
      outcome: "error",
      error: errorMessage,
      durationMs,
    });

    return {
      success: false,
      durationMs,
      error: errorMessage,
    };
  }
}

export async function syncNasKeepaliveSchedule(params: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly accountLabel: string;
  readonly familyKey: string;
  readonly existingTaskId?: ScheduledTaskId | undefined;
  readonly nextResetAtMs?: number | undefined;
}): Promise<{
  readonly success: boolean;
  readonly task?: ScheduledTask | undefined;
  readonly error?: string | undefined;
}> {
  try {
    const projectId = await resolveActivationProjectId(params.environmentId);
    const input = buildNasKeepaliveScheduleInput({
      instanceId: params.instanceId,
      model: params.model,
      projectId,
      accountLabel: params.accountLabel,
      familyKey: params.familyKey,
      existingTaskId: params.existingTaskId,
      nextResetAtMs: params.nextResetAtMs,
    });

    const result = await runAtomCommand(appAtomRegistry, serverEnvironment.upsertScheduledTask, {
      environmentId: params.environmentId,
      input,
    });

    if (result._tag === "Failure") {
      return { success: false, error: "Failed to upsert keepalive task on server." };
    }

    return { success: true, task: result.value.task };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function removeNasKeepaliveSchedule(params: {
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId;
}): Promise<{ readonly success: boolean; readonly error?: string | undefined }> {
  try {
    const result = await runAtomCommand(appAtomRegistry, serverEnvironment.deleteScheduledTask, {
      environmentId: params.environmentId,
      input: { id: params.taskId },
    });

    if (result._tag === "Failure") {
      return { success: false, error: "Failed to delete keepalive task on server." };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

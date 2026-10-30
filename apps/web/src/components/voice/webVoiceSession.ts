import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultProviderLabel } from "@t3tools/client-runtime/voice/context";
import {
  connectVoiceThreads,
  createVoiceThreadActions,
  createVoiceThreadSubscriber,
  selectVoiceEnvironment,
} from "@t3tools/client-runtime/voice/host";
import { VoiceSession } from "@t3tools/client-runtime/voice/session";
import type { VoiceCallToken, VoiceStartThreadInput } from "@t3tools/client-runtime/voice/types";
import { DEFAULT_SERVER_SETTINGS, VoiceAgentError, type ScopedThreadRef } from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { getClientSettings } from "../../hooks/useSettings";
import { resolveNewThreadModelDefaults } from "../../lib/chatThreadActions";
import { readT3ProjectFile } from "../../lib/t3ProjectFileDefaults";
import { newMessageId, newThreadId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShells } from "../../state/entities";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { environmentPresentations, environmentSummaries } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { voiceCallCandidatesAtom, voiceEnvironment } from "../../state/voice";
import { buildThreadRouteParams } from "../../threadRoutes";
import { createWebVoiceTransport } from "./webVoiceTransport";

function unwrap<A>(result: AtomCommandResult<A, unknown>): A {
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new Error("the request was cancelled");
  const error = squashAtomCommandFailure(result);
  throw error instanceof Error ? error : new Error(String(error));
}

/** Mints the call token on the primary environment if it holds the ElevenLabs key, else the first connected one that does. */
async function createCallToken(): Promise<VoiceCallToken> {
  const environmentId = selectVoiceEnvironment(appAtomRegistry.get(voiceCallCandidatesAtom));
  if (environmentId === null) {
    throw new VoiceAgentError({
      reason: "notConfigured",
      detail: "Add an ElevenLabs API key in Settings › Voice.",
    });
  }
  const result = await voiceEnvironment.createCallToken.run(appAtomRegistry, {
    environmentId,
    input: {},
  });
  return { token: unwrap(result).token, environmentId };
}

/**
 * A new thread with the project's defaults, as New thread picks them: its model (or the
 * composer's last pick), permission mode and workspace mode. A new worktree branches from the
 * checkout's current branch.
 */
async function startThread({
  project,
  prompt,
  summary,
}: VoiceStartThreadInput): Promise<ScopedThreadRef> {
  const { environmentId } = project;
  // Environment reads wait for a connection; an offline project would hang the tool call.
  if (
    !appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom).includes(environmentId)
  ) {
    throw new Error(`the environment of ${project.title} is not connected`);
  }
  const serverConfig = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const settings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = serverConfig?.providers ?? [];
  const projectFile =
    project.workspaceRoot === ""
      ? null
      : await readT3ProjectFile(environmentId, project.workspaceRoot);
  const projectSettings = resolveProjectSettings(settings, project.id, project, projectFile);
  const { stickyActiveProvider, stickyModelSelectionByProvider } = useComposerDraftStore.getState();
  const { selection } = resolveNewThreadModelDefaults({
    projectDefault: projectSettings.settings.defaultModelSelection ?? null,
    composerPick: stickyActiveProvider
      ? (stickyModelSelectionByProvider[stickyActiveProvider] ?? null)
      : null,
    providers,
    settings,
    projectId: project.id,
    now: Date.now(),
  });
  if (selection === null) throw new Error(`no provider is ready to work in ${project.title}`);
  const runtimeMode = projectSettings.settings.defaultRuntimeMode;
  const envMode =
    project.workspaceRoot === "" || isScratchProject(project, serverConfig?.scratchWorkspaceRoot)
      ? "local"
      : resolveNewThreadEnvMode({
          projectSettings,
          workspaceRoot: project.workspaceRoot,
          newProjectsRoot: serverConfig?.newProjectsRoot,
          projectHasThreads:
            readThreadShells().some(
              (thread) => thread.environmentId === environmentId && thread.projectId === project.id,
            ) || readUnloadedThreadCount([{ environmentId, id: project.id }], []) > 0,
        });
  let worktree: { readonly baseBranch: string; readonly startFromOrigin: boolean } | null = null;
  if (envMode === "worktree") {
    const status = unwrap(
      await vcsEnvironment.refreshStatus.run(appAtomRegistry, {
        environmentId,
        input: { cwd: project.workspaceRoot, localOnly: true },
      }),
    );
    if (status.isRepo) {
      worktree = {
        baseBranch: status.refName ?? "HEAD",
        startFromOrigin:
          status.refName !== null && projectSettings.settings.newWorktreesStartFromOrigin,
      };
    }
  }
  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  unwrap(
    await threadEnvironment.startTurn.run(appAtomRegistry, {
      environmentId,
      input: {
        threadId,
        creationSource: "web",
        message: { messageId: newMessageId(), role: "user", text: prompt, attachments: [] },
        modelSelection: selection,
        titleSeed: summary,
        runtimeMode,
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: project.id,
            title: summary,
            modelSelection: selection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
          ...(worktree === null
            ? {}
            : {
                prepareWorktree: {
                  projectCwd: project.workspaceRoot,
                  baseBranch: worktree.baseBranch,
                  ...(worktree.startFromOrigin ? { startFromOrigin: true } : {}),
                },
                runSetupScript: true,
              }),
        },
        createdAt,
      },
    }),
  );
  return scopeThreadRef(environmentId, threadId);
}

/** The one voice session of this window, wired to the app's threads, commands and router. */
export function createWebVoiceSession(router: AnyRouter): {
  readonly session: VoiceSession;
  /** Feeds the session every listed thread until the returned function is called. */
  readonly connect: () => () => void;
} {
  const session = new VoiceSession({
    transport: createWebVoiceTransport(),
    createCallToken,
    actions: {
      ...createVoiceThreadActions({
        registry: appAtomRegistry,
        commands: threadEnvironment,
        newMessageId,
        creationSource: "web",
      }),
      openThread: (ref) =>
        router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) }),
      startThread,
    },
    subscribeThread: createVoiceThreadSubscriber(
      appAtomRegistry,
      environmentThreadDetails.threadAtom,
    ),
    childRequests: (ref) => appAtomRegistry.get(environmentThreadShells.childThreadInputsAtom(ref)),
    speakMode: getClientSettings().wolfBudSpeaks,
    providerLabel: (thread) => {
      const provider = appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(thread.environmentId)
        ?.providers.find((candidate) => candidate.instanceId === thread.providerInstanceId);
      return provider ? resolveProviderInstanceDisplayName(provider) : defaultProviderLabel(thread);
    },
    environmentLabel: (environmentId) =>
      appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.entry.target
        .label ?? null,
    reportError: (message, cause) => console.warn(`[wolfbud] ${message}`, cause),
  });
  return {
    session,
    connect: () =>
      connectVoiceThreads(session, {
        registry: appAtomRegistry,
        threadsAtom: environmentThreadShells.navigationThreadShellsAtom,
        projectsAtom: environmentProjects.projectsAtom,
      }),
  };
}

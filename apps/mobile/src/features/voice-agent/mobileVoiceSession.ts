import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { defaultProviderLabel } from "@t3tools/client-runtime/voice/context";
import {
  connectVoiceThreads,
  createVoiceThreadActions,
  createVoiceThreadSubscriber,
  selectVoiceEnvironment,
} from "@t3tools/client-runtime/voice/host";
import { VoiceSession } from "@t3tools/client-runtime/voice/session";
import type { VoiceCallToken, VoiceTransport } from "@t3tools/client-runtime/voice/types";
import {
  MessageId,
  VoiceAgentError,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { voiceCallCandidatesAtom, voiceEnvironment } from "../../state/voice";
import { voiceOpenThreadAtom } from "./voiceOpenThread";
import { startVoiceThread } from "./voiceStartThread";

/** Mints the call token on the connected environment `selectVoiceEnvironment` picks. */
async function createCallToken(): Promise<VoiceCallToken> {
  const candidates = appAtomRegistry.get(voiceCallCandidatesAtom);
  if (candidates.length === 0) throw new Error("Connect to an environment to call T3Bud.");
  const environmentId = selectVoiceEnvironment(candidates);
  if (environmentId === null) {
    throw new VoiceAgentError({
      reason: "notConfigured",
      detail: "Add an ElevenLabs API key in Settings › Voice.",
    });
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    voiceEnvironment.createCallToken,
    { environmentId, input: {} },
    { reportFailure: false },
  );
  if (result._tag === "Success") return { token: result.value.token, environmentId };
  if (isAtomCommandInterrupted(result)) throw new Error("The call was cancelled.");
  throw squashAtomCommandFailure(result);
}

function threadHref(ref: ScopedThreadRef): string {
  return `/threads/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}

function providerLabel(thread: EnvironmentThreadShell): string {
  const provider = appAtomRegistry
    .get(environmentServerConfigsAtom)
    .get(thread.environmentId)
    ?.providers.find((candidate) => candidate.instanceId === thread.providerInstanceId);
  return provider ? resolveProviderInstanceDisplayName(provider) : defaultProviderLabel(thread);
}

function environmentLabel(environmentId: EnvironmentId): string | null {
  return (
    appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.entry.target
      .label ?? null
  );
}

export function createMobileVoiceSession(input: {
  readonly transport: VoiceTransport;
  readonly navigate: (href: string) => void;
}): VoiceSession {
  return new VoiceSession({
    transport: input.transport,
    createCallToken,
    actions: {
      ...createVoiceThreadActions({
        registry: appAtomRegistry,
        commands: threadEnvironment,
        newMessageId: () => MessageId.make(uuidv4()),
        creationSource: "mobile",
      }),
      openThread: (ref) => input.navigate(threadHref(ref)),
      startThread: startVoiceThread,
    },
    animal: () => {
      const preferences = appAtomRegistry.get(mobilePreferencesAtom);
      return (
        (AsyncResult.isSuccess(preferences) ? preferences.value.t3BudAnimal : undefined) ?? "wolf"
      );
    },
    subscribeThread: createVoiceThreadSubscriber(
      appAtomRegistry,
      environmentThreadDetails.threadAtom,
    ),
    childRequests: (ref) => appAtomRegistry.get(environmentThreadShells.childThreadInputsAtom(ref)),
    providerLabel,
    environmentLabel,
    reportError: (message, cause) => console.warn(`[voice-agent] ${message}`, cause),
  });
}

/** Feeds the session the app's threads, the open thread and the speak mode; ends it on cleanup. */
export function connectMobileVoiceSession(session: VoiceSession): () => void {
  const stopThreads = connectVoiceThreads(session, {
    registry: appAtomRegistry,
    threadsAtom: environmentThreadShells.navigationThreadShellsAtom,
    projectsAtom: environmentProjects.projectsAtom,
  });
  const stopOpenThread = appAtomRegistry.subscribe(
    voiceOpenThreadAtom,
    (ref) => session.setOpenThread(ref),
    { immediate: true },
  );
  const stopSpeakMode = appAtomRegistry.subscribe(
    mobilePreferencesAtom,
    (preferences) =>
      session.setSpeakMode(
        (AsyncResult.isSuccess(preferences) ? preferences.value.t3BudSpeaks : undefined) ?? "all",
      ),
    { immediate: true },
  );
  return () => {
    stopThreads();
    stopOpenThread();
    stopSpeakMode();
    session.dispose();
  };
}

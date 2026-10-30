import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type {
  InterruptThreadTurnInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  StartThreadTurnInput,
  ThreadCommandInput,
} from "../operations/commands.ts";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "../state/models.ts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommand,
} from "../state/runtime.ts";
import type {
  VoiceActions,
  VoiceDelivery,
  VoiceDispatchMode,
  VoiceThreadSubscriber,
  VoiceThreadsInput,
} from "./types.ts";

type ThreadCommand<Input, A = unknown> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: Input },
  A,
  unknown
>;

/** The thread commands both clients build with `createThreadEnvironmentAtoms`. */
export interface VoiceThreadCommands {
  readonly startTurn: ThreadCommand<StartThreadTurnInput>;
  readonly interruptTurn: ThreadCommand<InterruptThreadTurnInput>;
  readonly respondToApproval: ThreadCommand<RespondToThreadApprovalInput>;
  readonly respondToUserInput: ThreadCommand<RespondToThreadUserInputInput>;
  readonly readProjection: ThreadCommand<ThreadCommandInput, OrchestrationV2ThreadProjection>;
}

async function runThreadCommand<Input, A>(
  registry: AtomRegistry.AtomRegistry,
  command: ThreadCommand<Input, A>,
  ref: ScopedThreadRef,
  input: Input,
): Promise<A> {
  const result = await command.run(registry, { environmentId: ref.environmentId, input });
  if (result._tag === "Success") return result.value;
  if (isAtomCommandInterrupted(result)) throw new Error("the request was cancelled");
  const error = squashAtomCommandFailure(result);
  throw error instanceof Error ? error : new Error(String(error));
}

const REQUESTED_DELIVERY: Record<VoiceDispatchMode, VoiceDelivery> = {
  auto: "started",
  steer: "steered",
  queue: "queued",
};

/** How the server took a sent message, as its user-message item records it; null when the read failed. */
export function voiceDelivery(
  projection: OrchestrationV2ThreadProjection | null,
  messageId: MessageId,
): VoiceDelivery | null {
  if (projection === null) return null;
  const item = projection.turnItems.find(
    (candidate) => candidate.type === "user_message" && candidate.messageId === messageId,
  );
  // A message queued behind the active run gets its item when it starts.
  if (item?.type !== "user_message" || item.inputIntent === "queued_turn") return "queued";
  return item.inputIntent === "turn_start" ? "started" : "steered";
}

/**
 * The thread actions that work the same on every client. The host adds `openThread` (its
 * navigation) and `startThread` (its new-thread defaults) to make `VoiceActions`.
 */
export function createVoiceThreadActions(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly commands: VoiceThreadCommands;
  readonly newMessageId: () => MessageId;
  readonly creationSource: "web" | "mobile";
}): Omit<VoiceActions, "openThread" | "startThread"> {
  const { registry, commands } = input;
  return {
    send: async ({ ref, text, mode, runtimeMode, interactionMode }) => {
      const messageId = input.newMessageId();
      await runThreadCommand(registry, commands.startTurn, ref, {
        threadId: ref.threadId,
        creationSource: input.creationSource,
        message: { messageId, role: "user", text, attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode: mode,
      });
      // The server can queue a steer (a provider that can't steer, a running /compact). The
      // command has committed, so the read shows what it did.
      const projection = await runThreadCommand(registry, commands.readProjection, ref, {
        threadId: ref.threadId,
      }).catch(() => null);
      return voiceDelivery(projection, messageId) ?? REQUESTED_DELIVERY[mode];
    },
    stop: async (ref) => {
      await runThreadCommand(registry, commands.interruptTurn, ref, { threadId: ref.threadId });
    },
    respondToApproval: async (ref, requestId, decision) => {
      await runThreadCommand(registry, commands.respondToApproval, ref, {
        threadId: ref.threadId,
        requestId,
        decision,
      });
    },
    respondToUserInput: async (ref, requestId, answers) => {
      await runThreadCommand(registry, commands.respondToUserInput, ref, {
        threadId: ref.threadId,
        requestId,
        answers,
      });
    },
    readThread: (ref) =>
      runThreadCommand(registry, commands.readProjection, ref, { threadId: ref.threadId }),
  };
}

/** Streams a thread's projection from the clients' `environmentThreadDetails.threadAtom`. */
export function createVoiceThreadSubscriber(
  registry: AtomRegistry.AtomRegistry,
  threadAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThread | null>,
): VoiceThreadSubscriber {
  return (ref, listener) =>
    registry.subscribe(threadAtom(ref), (thread) => listener(thread?.projection ?? null), {
      immediate: true,
    });
}

/**
 * Feeds the session every listed thread and project until the returned function is called.
 * Pass the clients' `navigationThreadShellsAtom` and `projectsAtom`.
 */
export function connectVoiceThreads(
  session: { readonly setThreads: (input: VoiceThreadsInput) => void },
  input: {
    readonly registry: AtomRegistry.AtomRegistry;
    readonly threadsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
    readonly projectsAtom: Atom.Atom<ReadonlyArray<EnvironmentProject>>;
  },
): () => void {
  const { registry, threadsAtom, projectsAtom } = input;
  const push = () =>
    session.setThreads({
      threads: registry.get(threadsAtom),
      projects: registry.get(projectsAtom),
    });
  const stopThreads = registry.subscribe(threadsAtom, push);
  const stopProjects = registry.subscribe(projectsAtom, push);
  push();
  return () => {
    stopThreads();
    stopProjects();
  };
}

export interface VoiceEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly primary: boolean;
  /** Its server settings hold an ElevenLabs API key (clients see the redacted value). */
  readonly hasKey: boolean;
  /** This client may mint a call token there: `voiceEnvironment.createCallToken.permissionAtom`. */
  readonly canCall: boolean;
}

/**
 * The primary environment when it holds a key, else the first connected one that does, among
 * those this client may call from. When none may, the same order without the permission, so
 * the call fails with the server's missing-scope error rather than a missing-key one.
 */
export function selectVoiceEnvironment(
  candidates: ReadonlyArray<VoiceEnvironmentCandidate>,
): EnvironmentId | null {
  const keyed = candidates.filter((candidate) => candidate.hasKey);
  const pick = (from: ReadonlyArray<VoiceEnvironmentCandidate>) =>
    from.find((candidate) => candidate.primary) ?? from[0];
  return (
    (pick(keyed.filter((candidate) => candidate.canCall)) ?? pick(keyed))?.environmentId ?? null
  );
}

import type {
  EnvironmentId,
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2ThreadProjection,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  VoiceAgentSpeakMode,
} from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "../state/models.ts";
import type { ThreadNotificationState } from "../state/threadNotificationGate.ts";

export type VoiceCallStatus = "idle" | "connecting" | "live" | "error";
export type VoiceMode = "listening" | "speaking";

/** Every listed thread and project across the connected environments, as the host has them now. */
export interface VoiceThreadsInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}

/** One thread as the voice agent sees it. Handles are per call; see `VoiceHandles`. */
export interface VoiceThreadRow extends ThreadNotificationState {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  readonly project: string;
  readonly title: string;
  readonly provider: string;
  /** When the current status began, in epoch ms, if known. */
  readonly since: number | null;
  readonly error: string | null;
  readonly pendingRequest: OrchestrationV2PendingRuntimeRequestSummary["kind"] | null;
  /** The runtime is active, so the thread streams its steps while a call is live. */
  readonly running: boolean;
  /** The latest run was stopped on request, so its completion is not news. */
  readonly quiet: boolean;
  /** Epoch ms of the latest turn activity, for ranking. */
  readonly recency: number;
}

export type VoiceEventKind = "finished" | "approval" | "input" | "request" | "failed" | "limited";

export interface VoiceEvent {
  readonly kind: VoiceEventKind;
  readonly key: string;
  readonly handle: string;
  readonly title: string;
  readonly project: string;
  readonly provider: string;
  /** Finished: its final message. Approval: what it wants to do. Input: its questions. Failed: the error. */
  readonly detail: string | null;
  /** The approval or question `detail` describes. */
  readonly requestId: RuntimeRequestId | null;
}

export interface VoiceFeedEntry {
  readonly id: number;
  readonly tone: "ok" | "attention" | "bad" | "action";
  /** The thread's title. */
  readonly title: string;
  readonly text: string;
  readonly at: number;
}

export interface VoiceCaption {
  readonly text: string;
  /** False while the agent is still drafting the line. */
  readonly final: boolean;
}

/** What a voice UI shows. A new object on every change, for `useSyncExternalStore`. */
export interface VoiceSessionState {
  readonly status: VoiceCallStatus;
  readonly error: string | null;
  readonly mode: VoiceMode;
  readonly muted: boolean;
  readonly agentLine: VoiceCaption | null;
  readonly userLine: string | null;
  readonly userSpeaking: boolean;
  /** Updates waiting to be told. */
  readonly waiting: number;
  readonly feed: ReadonlyArray<VoiceFeedEntry>;
  /** The environment whose ElevenLabs key placed the call, once its token is minted. */
  readonly environmentId: EnvironmentId | null;
}

export type VoiceToolHandler = (parameters: Record<string, unknown>) => Promise<string>;

/** What the session hears from the audio transport. Calls after `end()` are ignored. */
export interface VoiceTransportCallbacks {
  readonly onConnect: () => void;
  /** `error` is null for a normal hang-up by either side. */
  readonly onDisconnect: (error: string | null) => void;
  readonly onModeChange: (mode: VoiceMode) => void;
  readonly onMessage: (role: "user" | "agent", text: string) => void;
  readonly onTentativeAgent: (text: string) => void;
  readonly onAgentCorrection: (text: string) => void;
  readonly onVadScore: (score: number) => void;
}

export interface VoiceTransportStart {
  readonly conversationToken: string;
  readonly dynamicVariables: Readonly<Record<string, string>>;
  /** Keyed by `VOICE_AGENT_TOOL_NAMES`. */
  readonly clientTools: Readonly<Record<string, VoiceToolHandler>>;
  readonly callbacks: VoiceTransportCallbacks;
}

/**
 * The platform's audio session with the ElevenLabs agent. `start` rejects with a user-facing
 * message, such as a denied microphone. `end` can arrive while `start` is still pending, and
 * then closes the session as soon as it exists. Sends only happen after `onConnect`.
 */
export interface VoiceTransport {
  readonly start: (options: VoiceTransportStart) => Promise<void>;
  readonly end: () => Promise<void>;
  /** Quiet context the agent folds in without answering. An id replaces the last update under it. */
  readonly sendContextualUpdate: (text: string, contextId?: string) => void;
  readonly sendUserMessage: (text: string) => void;
  readonly sendUserActivity: () => void;
  readonly setMicMuted: (muted: boolean) => void;
  /** 0..1 */
  readonly inputLevel: () => number;
  /** 0..1 */
  readonly outputLevel: () => number;
}

export type VoiceDispatchMode = "auto" | "steer" | "queue";

/** How the server delivered a message, which can differ from the mode asked for. */
export type VoiceDelivery = "started" | "steered" | "queued";

export interface VoiceSendInput {
  readonly ref: ScopedThreadRef;
  readonly text: string;
  readonly mode: VoiceDispatchMode;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface VoiceStartThreadInput {
  readonly project: EnvironmentProject;
  readonly prompt: string;
  /** A few words naming the request, usable as a title seed. */
  readonly summary: string;
}

/** What the agent's tools do. Each rejects with an error whose message the agent reads back. */
export interface VoiceActions {
  readonly send: (input: VoiceSendInput) => Promise<VoiceDelivery>;
  readonly stop: (ref: ScopedThreadRef) => Promise<void>;
  readonly respondToApproval: (
    ref: ScopedThreadRef,
    requestId: RuntimeRequestId,
    decision: "accept" | "decline",
  ) => Promise<void>;
  readonly respondToUserInput: (
    ref: ScopedThreadRef,
    requestId: RuntimeRequestId,
    answers: ProviderUserInputAnswers,
  ) => Promise<void>;
  readonly readThread: (ref: ScopedThreadRef) => Promise<OrchestrationV2ThreadProjection>;
  readonly openThread: (ref: ScopedThreadRef) => void | Promise<void>;
  /** Starts a thread with the project's defaults, as the new-thread UI does. */
  readonly startThread: (input: VoiceStartThreadInput) => Promise<ScopedThreadRef>;
}

/** Calls `listener` with the thread's live projection (null until loaded) until unsubscribed. */
export type VoiceThreadSubscriber = (
  ref: ScopedThreadRef,
  listener: (projection: OrchestrationV2ThreadProjection | null) => void,
) => () => void;

/**
 * The hidden subagent and delegated children of a thread that wait on the user, across
 * environments. Back it with the clients' `environmentThreadShells.childThreadInputsAtom`.
 */
export type VoiceChildRequests = (ref: ScopedThreadRef) => ReadonlyArray<EnvironmentThreadShell>;

export interface VoiceCallToken {
  readonly token: string;
  /** The environment that minted it, whose ElevenLabs account hears the call. */
  readonly environmentId: EnvironmentId;
}

/** Injectable time, so tests drive the session without timers. */
export interface VoiceClock {
  readonly now: () => number;
  /** Runs `run` after `delayMs`; returns its cancel. */
  readonly schedule: (delayMs: number, run: () => void) => () => void;
}

export interface VoiceSessionOptions {
  readonly transport: VoiceTransport;
  /** Mints a conversation token on the environment that holds the ElevenLabs key. */
  readonly createCallToken: () => Promise<VoiceCallToken>;
  readonly actions: VoiceActions;
  readonly subscribeThread: VoiceThreadSubscriber;
  readonly childRequests: VoiceChildRequests;
  readonly speakMode?: VoiceAgentSpeakMode;
  readonly providerLabel?: (thread: EnvironmentThreadShell) => string;
  /** Tells apart projects with the same title on different environments. */
  readonly environmentLabel?: (
    environmentId: EnvironmentThreadShell["environmentId"],
  ) => string | null;
  readonly clock?: VoiceClock;
  readonly reportError?: (message: string, cause: unknown) => void;
}

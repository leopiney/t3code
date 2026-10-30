import type { DisconnectionDetails, Mode, Role } from "@elevenlabs/client";
import rawAudioProcessorUrl from "@elevenlabs/client/worklets/rawAudioProcessor.js?url";
import type { VoiceToolHandler, VoiceTransport } from "@t3tools/client-runtime/voice/types";

/** The parts of an ElevenLabs conversation the transport drives. */
export interface ElevenLabsConversation {
  readonly endSession: () => Promise<void>;
  readonly sendContextualUpdate: (text: string, options?: { contextId?: string }) => void;
  readonly sendUserMessage: (text: string) => void;
  readonly sendUserActivity: () => void;
  readonly setMicMuted: (muted: boolean) => void;
  readonly getInputVolume: () => number;
  readonly getOutputVolume: () => number;
}

/** What the transport hands `Conversation.startSession`. */
export interface ElevenLabsSessionOptions {
  readonly conversationToken: string;
  readonly connectionType: "webrtc";
  readonly dynamicVariables: Record<string, string>;
  readonly clientTools: Record<string, VoiceToolHandler>;
  readonly onConversationCreated: (conversation: ElevenLabsConversation) => void;
  readonly onConnect: () => void;
  readonly onDisconnect: (details: DisconnectionDetails) => void;
  readonly onModeChange: (event: { readonly mode: Mode }) => void;
  readonly onMessage: (event: { readonly role: Role; readonly message: string }) => void;
  readonly onDebug: (info: unknown) => void;
  readonly onAgentResponseCorrection: (event: {
    readonly corrected_agent_response: string;
  }) => void;
  readonly onVadScore: (event: { readonly vadScore: number }) => void;
}

export interface WebVoiceTransportDeps {
  readonly startSession: (options: ElevenLabsSessionOptions) => Promise<ElevenLabsConversation>;
  /** Resolves once the browser lends the microphone; rejects with a user-facing message. */
  readonly requestMicrophone: () => Promise<void>;
}

function isTentativeResponse(info: unknown): info is { readonly response: string } {
  return (
    typeof info === "object" &&
    info !== null &&
    "type" in info &&
    info.type === "tentative_agent_response" &&
    "response" in info &&
    typeof info.response === "string"
  );
}

async function requestMicrophone(): Promise<void> {
  const devices = globalThis.navigator?.mediaDevices;
  if (devices?.getUserMedia === undefined) {
    throw new Error(
      globalThis.isSecureContext === false
        ? "Browsers lend the microphone only to secure pages. Open T3 Code over https or on localhost to call T3Bud."
        : "This browser has no microphone access.",
    );
  }
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new Error(
      name === "NotAllowedError" || name === "SecurityError"
        ? "T3Bud needs the microphone. Allow it for this page, then call again."
        : name === "NotFoundError"
          ? "No microphone was found."
          : `The microphone did not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  // Only the grant matters: the session opens its own stream.
  for (const track of stream.getTracks()) track.stop();
}

const browserDeps: WebVoiceTransportDeps = {
  startSession: async (options) => {
    const { Conversation } = await import("@elevenlabs/client");
    // Same-origin worklet: the SDK otherwise loads it from blob: or data:, which desktop's CSP blocks.
    return Conversation.startSession({
      ...options,
      workletPaths: { rawAudioProcessor: rawAudioProcessorUrl },
    });
  },
  requestMicrophone,
};

/** The voice session's audio over the ElevenLabs browser SDK, on WebRTC. */
export function createWebVoiceTransport(deps: WebVoiceTransportDeps = browserDeps): VoiceTransport {
  let conversation: ElevenLabsConversation | null = null;
  // Each start and end moves this on, so a start that loses the race closes what it opened.
  let attempt = 0;
  return {
    start: async ({ conversationToken, dynamicVariables, clientTools, callbacks }) => {
      attempt += 1;
      const current = attempt;
      const live = () => current === attempt;
      // The grant has to exist before the WebRTC session is built, or it never hears the user.
      await deps.requestMicrophone();
      if (!live()) return;
      const started = await deps.startSession({
        conversationToken,
        connectionType: "webrtc",
        dynamicVariables: { ...dynamicVariables },
        clientTools: { ...clientTools },
        // The SDK calls onConnect before startSession resolves; the session sends context then.
        onConversationCreated: (created) => {
          if (live()) conversation = created;
        },
        onConnect: () => {
          if (live()) callbacks.onConnect();
        },
        onDisconnect: (details) => {
          if (!live()) return;
          conversation = null;
          callbacks.onDisconnect(details.reason === "error" ? details.message : null);
        },
        onModeChange: ({ mode }) => {
          if (live()) callbacks.onModeChange(mode);
        },
        onMessage: ({ role, message }) => {
          if (live()) callbacks.onMessage(role === "agent" ? "agent" : "user", message);
        },
        onDebug: (info) => {
          if (live() && isTentativeResponse(info)) callbacks.onTentativeAgent(info.response);
        },
        onAgentResponseCorrection: (event) => {
          if (live()) callbacks.onAgentCorrection(event.corrected_agent_response);
        },
        onVadScore: ({ vadScore }) => {
          if (live()) callbacks.onVadScore(vadScore);
        },
      });
      if (!live()) await started.endSession();
    },
    end: async () => {
      attempt += 1;
      const ending = conversation;
      conversation = null;
      await ending?.endSession();
    },
    sendContextualUpdate: (text, contextId) =>
      conversation?.sendContextualUpdate(text, contextId === undefined ? undefined : { contextId }),
    sendUserMessage: (text) => conversation?.sendUserMessage(text),
    sendUserActivity: () => conversation?.sendUserActivity(),
    setMicMuted: (muted) => conversation?.setMicMuted(muted),
    inputLevel: () => conversation?.getInputVolume() ?? 0,
    outputLevel: () => conversation?.getOutputVolume() ?? 0,
  };
}

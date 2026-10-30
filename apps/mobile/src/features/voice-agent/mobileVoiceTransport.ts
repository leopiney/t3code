import type { HookCallbacks } from "@elevenlabs/react-native";
import type {
  VoiceToolHandler,
  VoiceTransport,
  VoiceTransportStart,
} from "@t3tools/client-runtime/voice/types";

type SdkCallbacks = Required<HookCallbacks>;

/** What the transport hands the provider's `startSession`. */
export interface ElevenLabsSessionOptions {
  readonly conversationToken: string;
  readonly connectionType: "webrtc";
  readonly dynamicVariables: Record<string, string>;
  readonly clientTools: Record<string, VoiceToolHandler>;
  readonly onStatusChange: () => void;
  readonly onConversationCreated: (conversation: {
    readonly setMicMuted: (muted: boolean) => void;
  }) => void;
  readonly onConnect: () => void;
  readonly onError: (message: string) => void;
  readonly onDisconnect: SdkCallbacks["onDisconnect"];
  readonly onModeChange: SdkCallbacks["onModeChange"];
  readonly onMessage: (
    event: Pick<Parameters<SdkCallbacks["onMessage"]>[0], "role" | "message">,
  ) => void;
  readonly onDebug: (info: unknown) => void;
  readonly onAgentResponseCorrection: (event: {
    readonly corrected_agent_response: string;
  }) => void;
  readonly onVadScore: SdkCallbacks["onVadScore"];
}

/** The `useConversationControls()` actions the transport drives. */
export interface ElevenLabsControls {
  readonly startSession: (options: ElevenLabsSessionOptions) => void;
  readonly endSession: () => void;
  readonly sendContextualUpdate: (text: string, options?: { readonly contextId?: string }) => void;
  readonly sendUserMessage: (text: string) => void;
  readonly sendUserActivity: () => void;
  readonly getInputVolume: () => number;
  readonly getOutputVolume: () => number;
}

export const STILL_CLOSING = "The last call is still closing. Call again in a moment.";

function tentativeAgentResponse(info: unknown): string | null {
  if (typeof info !== "object" || info === null) return null;
  if (!("type" in info) || info.type !== "tentative_agent_response") return null;
  return "response" in info && typeof info.response === "string" ? info.response : null;
}

/**
 * `VoiceTransport` over the `@elevenlabs/react-native` provider. Its `startSession` only reports
 * through callbacks, so `start` settles on the first of connect, error, hang-up, or `end`.
 */
export function createMobileVoiceTransport(
  controls: ElevenLabsControls,
  /** Resolves once the microphone is allowed; rejects with a user-facing message. */
  requestMicrophone: () => Promise<void>,
): VoiceTransport {
  let setMicMuted: ((muted: boolean) => void) | null = null;
  let resolvePending: (() => void) | null = null;

  const open = ({
    conversationToken,
    dynamicVariables,
    clientTools,
    callbacks,
  }: VoiceTransportStart) =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      let accepted = false;
      const settle = (error: string | null) => {
        if (settled) return;
        settled = true;
        resolvePending = null;
        if (error === null) resolve();
        else reject(new Error(error));
      };
      resolvePending = () => settle(null);
      controls.startSession({
        conversationToken,
        connectionType: "webrtc",
        dynamicVariables: { ...dynamicVariables },
        clientTools: { ...clientTools },
        onStatusChange: () => {
          accepted = true;
        },
        onConversationCreated: (conversation) => {
          setMicMuted = (muted) => conversation.setMicMuted(muted);
        },
        onConnect: () => {
          settle(null);
          callbacks.onConnect();
        },
        // After connect these are recoverable; a fatal one also ends the call through onDisconnect.
        onError: (message) => settle(message),
        onDisconnect: (details) => {
          setMicMuted = null;
          settle(null);
          callbacks.onDisconnect(details.reason === "error" ? details.message : null);
        },
        onModeChange: ({ mode }) => callbacks.onModeChange(mode),
        onMessage: ({ role, message }) => callbacks.onMessage(role, message),
        onDebug: (info) => {
          const text = tentativeAgentResponse(info);
          if (text !== null) callbacks.onTentativeAgent(text);
        },
        onAgentResponseCorrection: ({ corrected_agent_response }) =>
          callbacks.onAgentCorrection(corrected_agent_response),
        onVadScore: ({ vadScore }) => callbacks.onVadScore(vadScore),
      });
      // The provider drops a start, with no callback at all, while its last session still closes.
      if (!accepted) settle(STILL_CLOSING);
    });

  return {
    start: async (options) => {
      let ended = false;
      resolvePending = () => {
        ended = true;
      };
      await requestMicrophone();
      if (!ended) await open(options);
    },
    end: async () => {
      resolvePending?.();
      setMicMuted = null;
      controls.endSession();
    },
    sendContextualUpdate: (text, contextId) =>
      controls.sendContextualUpdate(text, contextId === undefined ? undefined : { contextId }),
    sendUserMessage: (text) => controls.sendUserMessage(text),
    sendUserActivity: () => controls.sendUserActivity(),
    setMicMuted: (muted) => setMicMuted?.(muted),
    inputLevel: () => controls.getInputVolume(),
    outputLevel: () => controls.getOutputVolume(),
  };
}

import type { VoiceTransportStart } from "@t3tools/client-runtime/voice/types";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createMobileVoiceTransport,
  STILL_CLOSING,
  type ElevenLabsControls,
  type ElevenLabsSessionOptions,
} from "./mobileVoiceTransport";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeControls(startSession: ElevenLabsControls["startSession"]) {
  return {
    startSession: vi.fn(startSession),
    endSession: vi.fn(),
    sendContextualUpdate: vi.fn(),
    sendUserMessage: vi.fn(),
    sendUserActivity: vi.fn(),
    getInputVolume: () => 0.25,
    getOutputVolume: () => 0.5,
  } satisfies ElevenLabsControls;
}

function callbacks() {
  return {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onModeChange: vi.fn(),
    onMessage: vi.fn(),
    onTentativeAgent: vi.fn(),
    onAgentCorrection: vi.fn(),
    onVadScore: vi.fn(),
  } satisfies VoiceTransportStart["callbacks"];
}

const start = (session: ReturnType<typeof callbacks>): VoiceTransportStart => ({
  conversationToken: "token",
  dynamicVariables: { open_thread: "none", project_names: "shop", thread_count: "1" },
  clientTools: {},
  callbacks: session,
});

const allowMicrophone = async () => {};

describe("createMobileVoiceTransport", () => {
  it("settles on connect and maps the SDK's events onto the session's callbacks", async () => {
    const called = deferred<ElevenLabsSessionOptions>();
    const conversation = { setMicMuted: vi.fn() };
    const controls = fakeControls((options) => {
      // The provider reports "connecting" synchronously for a start it accepts.
      options.onStatusChange();
      called.resolve(options);
    });
    const session = callbacks();
    const transport = createMobileVoiceTransport(controls, allowMicrophone);

    const starting = transport.start(start(session));
    const options = await called.promise;
    options.onConversationCreated(conversation);
    options.onConnect();
    await starting;

    expect(options).toMatchObject({ conversationToken: "token", connectionType: "webrtc" });
    expect(session.onConnect).toHaveBeenCalledTimes(1);
    options.onModeChange({ mode: "speaking" });
    options.onMessage({ role: "agent", message: "Cart refactor is done." });
    options.onDebug({ type: "tentative_agent_response", response: "Cart ref" });
    options.onDebug({ type: "agent_response", agent_response_event: {} });
    options.onAgentResponseCorrection({ corrected_agent_response: "Cart refactor" });
    options.onVadScore({ vadScore: 0.8 });
    transport.sendContextualUpdate("[t3 snapshot] 1 thread.", "t3-snapshot");
    transport.setMicMuted(true);
    options.onDisconnect({
      reason: "error",
      message: "The agent left.",
      context: { type: "error" },
    });
    transport.setMicMuted(false);

    expect(session.onModeChange).toHaveBeenCalledWith("speaking");
    expect(session.onMessage).toHaveBeenCalledWith("agent", "Cart refactor is done.");
    expect(session.onTentativeAgent.mock.calls).toEqual([["Cart ref"]]);
    expect(session.onAgentCorrection).toHaveBeenCalledWith("Cart refactor");
    expect(session.onVadScore).toHaveBeenCalledWith(0.8);
    expect(controls.sendContextualUpdate).toHaveBeenCalledWith("[t3 snapshot] 1 thread.", {
      contextId: "t3-snapshot",
    });
    // The conversation is gone after the disconnect, so the second mute goes nowhere.
    expect(conversation.setMicMuted.mock.calls).toEqual([[true]]);
    expect(session.onDisconnect).toHaveBeenCalledWith("The agent left.");
    expect(transport.outputLevel()).toBe(0.5);
  });

  it.each([
    {
      name: "a refused microphone",
      startSession: () => {},
      requestMicrophone: async () => {
        throw new Error("T3Bud needs the microphone to hear you.");
      },
      message: "T3Bud needs the microphone to hear you.",
    },
    {
      name: "a start the provider drops while its last session closes",
      startSession: () => {},
      requestMicrophone: allowMicrophone,
      message: STILL_CLOSING,
    },
    {
      name: "an SDK error before connect",
      startSession: (options: ElevenLabsSessionOptions) => {
        options.onStatusChange();
        options.onError("Microphone permission denied");
      },
      requestMicrophone: allowMicrophone,
      message: "Microphone permission denied",
    },
  ])("rejects $name", async ({ startSession, requestMicrophone, message }) => {
    const session = callbacks();
    const transport = createMobileVoiceTransport(fakeControls(startSession), requestMicrophone);

    await expect(transport.start(start(session))).rejects.toThrow(message);
    expect(session.onConnect).not.toHaveBeenCalled();
  });

  it("ends a start that has not connected yet", async () => {
    const microphone = deferred<void>();
    const asking = fakeControls(() => {});
    const askingTransport = createMobileVoiceTransport(asking, () => microphone.promise);
    const askingStart = askingTransport.start(start(callbacks()));
    await askingTransport.end();
    microphone.resolve();
    await askingStart;
    // Hung up during the permission prompt: no session opens afterwards.
    expect(asking.startSession).not.toHaveBeenCalled();

    const called = deferred<void>();
    const connecting = fakeControls((options) => {
      options.onStatusChange();
      called.resolve();
    });
    const connectingTransport = createMobileVoiceTransport(connecting, allowMicrophone);
    const connectingStart = connectingTransport.start(start(callbacks()));
    await called.promise;
    await connectingTransport.end();
    await connectingStart;
    expect(connecting.endSession).toHaveBeenCalledTimes(1);
  });
});

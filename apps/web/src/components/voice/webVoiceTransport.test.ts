import type { VoiceTransportStart } from "@t3tools/client-runtime/voice/types";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWebVoiceTransport,
  type ElevenLabsConversation,
  type ElevenLabsSessionOptions,
} from "./webVoiceTransport";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeConversation() {
  return {
    endSession: vi.fn(async () => {}),
    sendContextualUpdate: vi.fn(),
    sendUserMessage: vi.fn(),
    sendUserActivity: vi.fn(),
    setMicMuted: vi.fn(),
    getInputVolume: () => 0.25,
    getOutputVolume: () => 0.5,
  } satisfies ElevenLabsConversation;
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

describe("createWebVoiceTransport", () => {
  it("delivers what the session sends on connect, before the SDK's start resolves", async () => {
    const conversation = fakeConversation();
    const session = callbacks();
    const transport = createWebVoiceTransport({
      requestMicrophone: async () => {},
      // The SDK creates the conversation, then calls onConnect, then resolves.
      startSession: async (options) => {
        options.onConversationCreated(conversation);
        options.onConnect();
        return conversation;
      },
    });
    session.onConnect.mockImplementation(() => {
      transport.sendContextualUpdate("[t3 snapshot] 1 thread.", "t3-snapshot");
    });

    await transport.start(start(session));

    expect(conversation.sendContextualUpdate).toHaveBeenCalledWith("[t3 snapshot] 1 thread.", {
      contextId: "t3-snapshot",
    });
    expect(transport.outputLevel()).toBe(0.5);
  });

  it("passes on only tentative debug events and goes quiet after a disconnect", async () => {
    const conversation = fakeConversation();
    const session = callbacks();
    const called = deferred<ElevenLabsSessionOptions>();
    const transport = createWebVoiceTransport({
      requestMicrophone: async () => {},
      startSession: async (options) => {
        called.resolve(options);
        options.onConversationCreated(conversation);
        return conversation;
      },
    });
    await transport.start(start(session));
    const sdk = await called.promise;

    sdk.onDebug({ type: "tentative_agent_response", response: "Cart ref" });
    sdk.onDebug({ type: "agent_response", agent_response_event: {} });
    sdk.onDisconnect({ reason: "error", message: "The agent left.", context: { type: "error" } });

    expect(session.onTentativeAgent.mock.calls).toEqual([["Cart ref"]]);
    expect(session.onDisconnect).toHaveBeenCalledWith("The agent left.");
    // The conversation is gone after a disconnect; later sends go nowhere.
    transport.sendUserMessage("[agent event] late");
    expect(conversation.sendUserMessage).not.toHaveBeenCalled();
  });

  it("closes a session that opens after the call ended", async () => {
    const conversation = fakeConversation();
    const session = callbacks();
    const called = deferred<ElevenLabsSessionOptions>();
    const opened = deferred<ElevenLabsConversation>();
    const transport = createWebVoiceTransport({
      requestMicrophone: async () => {},
      startSession: (options) => {
        called.resolve(options);
        return opened.promise;
      },
    });

    const starting = transport.start(start(session));
    const options = await called.promise;
    await transport.end();
    options.onConversationCreated(conversation);
    options.onConnect();
    opened.resolve(conversation);
    await starting;

    expect(conversation.endSession).toHaveBeenCalledTimes(1);
    expect(session.onConnect).not.toHaveBeenCalled();
    transport.sendContextualUpdate("[t3 snapshot] 1 thread.");
    expect(conversation.sendContextualUpdate).not.toHaveBeenCalled();
  });

  it("opens no session when the microphone is refused", async () => {
    const startSession = vi.fn(async () => fakeConversation());
    const transport = createWebVoiceTransport({
      requestMicrophone: async () => {
        throw new Error("T3Bud needs the microphone. Allow it for this page, then call again.");
      },
      startSession,
    });

    await expect(transport.start(start(callbacks()))).rejects.toThrow("T3Bud needs the microphone");
    expect(startSession).not.toHaveBeenCalled();
  });
});

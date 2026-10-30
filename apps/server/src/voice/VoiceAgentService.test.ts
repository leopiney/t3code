import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { VOICE_AGENT_TOOL_NAMES, type VoiceAgentSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse, UrlParams } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { VOICE_AGENT_NAME } from "./voiceAgentDefinition.ts";
import * as VoiceAgentService from "./VoiceAgentService.ts";

const API = "https://api.elevenlabs.io/v1";
const TOOL_NAMES = Object.values(VOICE_AGENT_TOOL_NAMES);

interface SeenRequest {
  readonly line: string;
  readonly method: string;
  readonly path: string;
  readonly params: string;
  readonly apiKey: string | undefined;
  readonly body: unknown;
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeToolBody = Schema.decodeUnknownSync(
  Schema.Struct({ tool_config: Schema.Struct({ name: Schema.String }) }),
);
const toolName = (request: SeenRequest) => decodeToolBody(request.body).tool_config.name;
const SavedAgentFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeSavedAgentFile = Schema.decodeEffect(SavedAgentFile);
const encodeSavedAgentFile = Schema.encodeEffect(SavedAgentFile);
const DEFINITION_TAG = expect.stringMatching(/^t3-definition:[0-9a-f]{12}$/);

/** ElevenLabs as `respond` answers it, recording each request it gets. */
const fakeElevenLabs = (
  respond: (request: SeenRequest) => readonly [status: number, body: unknown],
) => {
  const seen: Array<SeenRequest> = [];
  const client = HttpClient.make((request) => {
    const path = request.url.slice(API.length);
    const params = UrlParams.toString(request.urlParams);
    const seenRequest = {
      line: `${request.method} ${path}${params ? `?${params}` : ""}`,
      method: request.method,
      path,
      params,
      apiKey: request.headers["xi-api-key"],
      body:
        request.body._tag === "Uint8Array"
          ? decodeJson(new TextDecoder().decode(request.body.body))
          : undefined,
    };
    seen.push(seenRequest);
    const [status, body] = respond(seenRequest);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
  });
  return { client, seen };
};

/** An account whose lists stay empty, so every sync creates the tools and the agent. */
const emptyAccount = (agentIds: () => string) => {
  const agents = new Map<string, unknown>();
  return (request: SeenRequest): readonly [number, unknown] => {
    switch (`${request.method} ${request.path}`) {
      case "GET /convai/tools":
        return [200, { tools: [], has_more: false }];
      case "POST /convai/tools":
        return [200, { id: `id-${toolName(request)}` }];
      case "GET /convai/agents":
        return [200, { agents: [], has_more: false }];
      case "POST /convai/agents/create": {
        const agentId = agentIds();
        agents.set(`/convai/agents/${agentId}`, request.body);
        return [200, { agent_id: agentId }];
      }
      case "GET /convai/conversation/token":
        return [200, { token: `token-for-${request.params}` }];
    }
    const agent = request.method === "GET" ? agents.get(request.path) : undefined;
    return agent === undefined ? [404, { detail: "Not found" }] : [200, agent];
  };
};

const layer = (client: HttpClient.HttpClient, voiceAgent: Partial<VoiceAgentSettings>) =>
  VoiceAgentService.layer.pipe(
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest({ voiceAgent })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-agent-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

describe("VoiceAgentService", () => {
  it.effect(
    "sets the agent up once, then mints call tokens until the definition or key changes",
    () => {
      const api = fakeElevenLabs(emptyAccount(() => "agent-1"));
      return Effect.gen(function* () {
        const voice = yield* VoiceAgentService.VoiceAgentService;

        expect(yield* voice.syncAgent()).toEqual({
          agentId: "agent-1",
          agentName: VOICE_AGENT_NAME,
        });
        expect(
          api.seen.filter((request) => request.line === "POST /convai/tools").map(toolName),
        ).toEqual(TOOL_NAMES);
        expect(
          api.seen.find((request) => request.path === "/convai/agents/create")?.body,
        ).toMatchObject({
          name: VOICE_AGENT_NAME,
          conversation_config: {
            agent: { prompt: { tool_ids: TOOL_NAMES.map((name) => `id-${name}`) } },
          },
          platform_settings: { auth: { enable_auth: true } },
          tags: [DEFINITION_TAG],
        });
        expect(new Set(api.seen.map((request) => request.apiKey))).toEqual(new Set(["key-a"]));

        api.seen.length = 0;
        expect(yield* voice.callToken()).toEqual({
          token: "token-for-agent_id=agent-1",
          agentId: "agent-1",
        });
        expect(new Set(api.seen.map((request) => request.line))).toEqual(
          new Set([
            "GET /convai/agents/agent-1",
            "GET /convai/conversation/token?agent_id=agent-1",
          ]),
        );

        // A definition that changed since the last sync is pushed before the next call.
        const fileSystem = yield* FileSystem.FileSystem;
        const stateFile = (yield* Path.Path).join(
          (yield* ServerConfig.ServerConfig).stateDir,
          "voice-agent.json",
        );
        const saved = yield* decodeSavedAgentFile(yield* fileSystem.readFileString(stateFile));
        yield* fileSystem.writeFileString(
          stateFile,
          yield* encodeSavedAgentFile({ ...saved, definitionHash: "stale" }),
        );
        api.seen.length = 0;
        yield* voice.callToken();
        expect(api.seen.map((request) => request.line)).toEqual(
          expect.arrayContaining(["GET /convai/tools?page_size=100", "POST /convai/agents/create"]),
        );

        // Another key is another account, where the saved agent does not exist.
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ voiceAgent: { elevenLabsApiKey: "key-b" } });
        api.seen.length = 0;
        yield* voice.callToken();
        expect(api.seen.map((request) => request.line)).toContain("POST /convai/agents/create");
        expect(new Set(api.seen.map((request) => request.apiKey))).toEqual(new Set(["key-b"]));
      }).pipe(Effect.provide(layer(api.client, { elevenLabsApiKey: "key-a" })));
    },
  );

  it.effect("updates existing tools and agent in place, keeping the agent's client events", () => {
    const api = fakeElevenLabs((request) => {
      switch (request.line) {
        case "GET /convai/tools?page_size=100":
          return [
            200,
            {
              tools: [
                { id: "old-send", tool_config: { name: VOICE_AGENT_TOOL_NAMES.sendToThread } },
                { id: "unrelated", tool_config: { name: "someone_elses_tool" } },
              ],
            },
          ];
        case "POST /convai/tools":
          return [200, { id: `id-${toolName(request)}` }];
        case "GET /convai/agents?page_size=100":
          return [
            200,
            {
              agents: [{ agent_id: "other", name: "Another agent" }],
              has_more: true,
              next_cursor: "page-2",
            },
          ];
        case "GET /convai/agents?page_size=100&cursor=page-2":
          return [200, { agents: [{ agent_id: "agent-9", name: VOICE_AGENT_NAME }] }];
        case "GET /convai/agents/agent-9":
          return [
            200,
            {
              name: VOICE_AGENT_NAME,
              tags: ["team-a", "t3-definition:older"],
              conversation_config: { conversation: { client_events: ["client_tool_call"] } },
            },
          ];
        case "PATCH /convai/tools/old-send":
        case "PATCH /convai/agents/agent-9":
          return [200, {}];
      }
      return [404, { detail: "Not found" }];
    });
    return Effect.gen(function* () {
      const voice = yield* VoiceAgentService.VoiceAgentService;

      expect(yield* voice.syncAgent()).toEqual({ agentId: "agent-9", agentName: VOICE_AGENT_NAME });
      const lines = api.seen.map((request) => request.line);
      expect(lines).toContain("PATCH /convai/tools/old-send");
      expect(lines).not.toContain("POST /convai/agents/create");
      expect(lines.filter((line) => line === "POST /convai/tools")).toHaveLength(
        TOOL_NAMES.length - 1,
      );
      const patch = api.seen.find((request) => request.line === "PATCH /convai/agents/agent-9");
      expect(patch?.body).toMatchObject({
        conversation_config: {
          agent: {
            prompt: { tool_ids: ["old-send", ...TOOL_NAMES.slice(1).map((n) => `id-${n}`)] },
          },
          conversation: { client_events: expect.arrayContaining(["client_tool_call", "audio"]) },
        },
        tags: ["team-a", DEFINITION_TAG],
      });
    }).pipe(Effect.provide(layer(api.client, { elevenLabsApiKey: "key-a" })));
  });

  it.effect.each([
    {
      change: "ElevenLabs deleted it",
      reply: (line: string) =>
        line.endsWith("agent-1") ? ([404, { detail: "Agent not found" }] as const) : undefined,
      agentId: "agent-2",
    },
    {
      // Another T3 server on the same key pushed its own definition.
      change: "another server rewrote it",
      reply: (line: string) =>
        line === "GET /convai/agents/agent-1"
          ? ([200, { name: VOICE_AGENT_NAME, tags: ["t3-definition:other"] }] as const)
          : undefined,
      agentId: "agent-2",
    },
    {
      // The check is best-effort: only a missing agent or another definition sets it up again.
      change: "the definition check fails",
      reply: (line: string) =>
        line === "GET /convai/agents/agent-1"
          ? ([503, { detail: "Service unavailable" }] as const)
          : undefined,
      agentId: "agent-1",
    },
  ])("calls $agentId when $change", ({ reply, agentId }) => {
    let created = 0;
    const account = emptyAccount(() => `agent-${++created}`);
    const api = fakeElevenLabs((request) => reply(request.line) ?? account(request));
    return Effect.gen(function* () {
      const voice = yield* VoiceAgentService.VoiceAgentService;
      yield* voice.syncAgent();
      expect(yield* voice.callToken()).toEqual({
        token: `token-for-agent_id=${agentId}`,
        agentId,
      });
    }).pipe(Effect.provide(layer(api.client, { elevenLabsApiKey: "key-a" })));
  });

  it.effect("creates one agent when two calls start at once", () => {
    let created = 0;
    const api = fakeElevenLabs(emptyAccount(() => `agent-${++created}`));
    return Effect.gen(function* () {
      const voice = yield* VoiceAgentService.VoiceAgentService;
      const tokens = yield* Effect.all([voice.callToken(), voice.callToken()], { concurrency: 2 });
      expect(tokens.map((token) => token.agentId)).toEqual(["agent-1", "agent-1"]);
      expect(
        api.seen.filter((request) => request.line === "POST /convai/agents/create"),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layer(api.client, { elevenLabsApiKey: "key-a" })));
  });

  it.effect("uses an override agent as it is, without syncing", () => {
    const api = fakeElevenLabs((request) =>
      request.line === "GET /convai/agents/my-agent"
        ? [200, { name: "My agent" }]
        : emptyAccount(() => "unused")(request),
    );
    return Effect.gen(function* () {
      const voice = yield* VoiceAgentService.VoiceAgentService;
      expect(yield* voice.syncAgent()).toEqual({ agentId: "my-agent", agentName: "My agent" });
      expect(yield* voice.callToken()).toEqual({
        token: "token-for-agent_id=my-agent",
        agentId: "my-agent",
      });
      expect(api.seen.map((request) => request.line)).toEqual([
        "GET /convai/agents/my-agent",
        "GET /convai/conversation/token?agent_id=my-agent",
      ]);
    }).pipe(
      Effect.provide(layer(api.client, { elevenLabsApiKey: "key-a", agentIdOverride: "my-agent" })),
    );
  });

  it.effect("asks for a key before calling ElevenLabs", () =>
    Effect.gen(function* () {
      const voice = yield* VoiceAgentService.VoiceAgentService;
      const notConfigured = { _tag: "VoiceAgentError", reason: "notConfigured" };
      expect(yield* Effect.flip(voice.syncAgent())).toMatchObject(notConfigured);
      expect(yield* Effect.flip(voice.callToken())).toMatchObject(notConfigured);
    }).pipe(
      Effect.provide(
        layer(
          HttpClient.make(() => Effect.die("must not send a request")),
          { elevenLabsApiKey: "" },
        ),
      ),
    ),
  );

  it.effect.each([
    {
      failure: "a rejected key",
      response: [401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }],
      reason: "invalidKey",
      detail: "ElevenLabs rejected the API key: Invalid API key",
    },
    {
      failure: "a refused request",
      response: [422, { detail: [{ loc: ["body"], msg: "Field required", type: "missing" }] }],
      reason: "elevenLabs",
      detail: "ElevenLabs GET /convai/tools failed (422): Field required",
    },
    {
      failure: "an unreachable API",
      response: undefined,
      reason: "network",
      detail: "Couldn't reach ElevenLabs.",
    },
  ] as const)("reports $failure as $reason", ({ response, reason, detail }) =>
    Effect.gen(function* () {
      const voice = yield* VoiceAgentService.VoiceAgentService;
      expect(yield* voice.syncAgent().pipe(Effect.flip)).toMatchObject({
        _tag: "VoiceAgentError",
        reason,
        detail,
      });
    }).pipe(
      Effect.provide(
        layer(
          response === undefined
            ? HttpClient.make((request) =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request }),
                  }),
                ),
              )
            : fakeElevenLabs(() => response).client,
          { elevenLabsApiKey: "key-a" },
        ),
      ),
    ),
  );
});

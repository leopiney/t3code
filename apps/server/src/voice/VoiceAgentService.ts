import {
  type ServerSettingsError,
  TrimmedNonEmptyString,
  VoiceAgentError,
  type VoiceCreateCallTokenResult,
  type VoiceSyncAgentResult,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { VOICE_AGENT_NAME, VOICE_AGENT_TOOLS, voiceAgentFields } from "./voiceAgentDefinition.ts";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const REQUEST_TIMEOUT = "15 seconds";
const LIST_PAGE_LIMIT = 20;
const STATE_FILE = "voice-agent.json";
const DEFINITION_TAG_PREFIX = "t3-definition:";

/** Which agent the last sync left, so an unchanged definition and key skip the next one. */
const SavedAgent = Schema.Struct({
  agentId: Schema.String,
  definitionHash: Schema.String,
  keyFingerprint: Schema.String,
});
const decodeSavedAgent = Schema.decodeUnknownOption(Schema.fromJsonString(SavedAgent));
const encodeSavedAgent = Schema.encodeSync(Schema.fromJsonString(SavedAgent));
const DEFINITION_JSON = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  tools: VOICE_AGENT_TOOLS,
  agent: voiceAgentFields([]),
});

const PageInfo = {
  has_more: Schema.optional(Schema.Boolean),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
};
const ToolsPage = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      tool_config: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  ...PageInfo,
});
const AgentsPage = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({ agent_id: Schema.String, name: Schema.optional(Schema.NullOr(Schema.String)) }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  ...PageInfo,
});
const SavedTool = Schema.Struct({ id: Schema.String });
const CreatedAgent = Schema.Struct({ agent_id: Schema.String });
const AgentDetail = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  conversation_config: Schema.optional(
    Schema.Struct({
      conversation: Schema.optional(
        Schema.Struct({ client_events: Schema.optional(Schema.Array(Schema.String)) }),
      ),
    }),
  ),
});
const ConversationToken = Schema.Struct({ token: TrimmedNonEmptyString });

const ErrorBody = Schema.Struct({
  detail: Schema.Union([
    Schema.String,
    Schema.Struct({ message: Schema.String }),
    Schema.NonEmptyArray(Schema.Struct({ msg: Schema.String })),
  ]),
});
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

/** The readable part of an ElevenLabs error body: its `detail`, or the detail's message. */
const errorDetail = (text: string) => {
  const body = decodeErrorBody(text);
  if (Option.isNone(body)) return text.trim().slice(0, 200);
  const { detail } = body.value;
  if (typeof detail === "string") return detail.trim().slice(0, 200);
  return ("message" in detail ? detail.message : detail[0].msg).trim().slice(0, 200);
};

const networkError = (cause: unknown) =>
  new VoiceAgentError({
    reason: "network",
    detail: Cause.isTimeoutError(cause)
      ? "ElevenLabs did not answer in time."
      : "Couldn't reach ElevenLabs.",
    cause,
  });

export class VoiceAgentService extends Context.Service<
  VoiceAgentService,
  {
    /** Pushes the agent definition to the key's ElevenLabs account, or checks an override agent. */
    readonly syncAgent: () => Effect.Effect<
      VoiceSyncAgentResult,
      VoiceAgentError | ServerSettingsError
    >;
    /** Mints a short-lived call token, setting the agent up first when needed. */
    readonly callToken: () => Effect.Effect<
      VoiceCreateCallTokenResult,
      VoiceAgentError | ServerSettingsError
    >;
  }
>()("t3/voice/VoiceAgentService") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sha256 = (value: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
  const definitionHash = (yield* sha256(DEFINITION_JSON)).slice(0, 12);
  // The agent is shared by every T3 server on the key, so it carries which definition it holds.
  const definitionTag = `${DEFINITION_TAG_PREFIX}${definitionHash}`;
  const keyFingerprint = (apiKey: string) =>
    sha256(apiKey).pipe(Effect.map((hash) => hash.slice(0, 16)));
  const statePath = path.join(config.stateDir, STATE_FILE);
  // Two clients asking at once must not both create an agent.
  const syncLock = yield* Semaphore.make(1);

  const readVoiceSettings = serverSettings.getSettings.pipe(
    Effect.flatMap(({ voiceAgent }) =>
      voiceAgent.elevenLabsApiKey === ""
        ? Effect.fail(
            new VoiceAgentError({
              reason: "notConfigured",
              detail: "Add an ElevenLabs API key in Settings › Voice.",
            }),
          )
        : Effect.succeed(voiceAgent),
    ),
  );

  const readSavedAgent = fileSystem.readFileString(statePath).pipe(
    Effect.map(decodeSavedAgent),
    Effect.orElseSucceed(() => Option.none()),
  );

  const saveAgent = (saved: typeof SavedAgent.Type) =>
    writeFileStringAtomically({ filePath: statePath, contents: encodeSavedAgent(saved) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to save the voice agent state; the next call syncs again.", {
          cause,
        }),
      ),
    );

  const send = Effect.fn("VoiceAgentService.send")(function* (
    apiKey: string,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    return yield* client
      .execute(request.pipe(HttpClientRequest.setHeader("xi-api-key", apiKey)))
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(networkError));
  });

  const readOk = Effect.fn("VoiceAgentService.readOk")(function* (
    response: HttpClientResponse.HttpClientResponse,
  ) {
    const text = yield* response.text.pipe(
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.mapError(networkError),
    );
    if (response.status >= 200 && response.status < 300) return text;
    const detail = errorDetail(text);
    if (response.status === 401 || response.status === 403) {
      return yield* new VoiceAgentError({
        reason: "invalidKey",
        detail: detail
          ? `ElevenLabs rejected the API key: ${detail}`
          : "ElevenLabs rejected the API key.",
      });
    }
    const { method, url } = response.request;
    return yield* new VoiceAgentError({
      reason: "elevenLabs",
      detail: `ElevenLabs ${method} ${url.slice(ELEVENLABS_API.length)} failed (${response.status})${detail ? `: ${detail}` : "."}`,
    });
  });

  const readJson = <S extends Schema.Top>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
  ) =>
    readOk(response).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new VoiceAgentError({
              reason: "elevenLabs",
              detail: "ElevenLabs sent a response T3 Code does not understand.",
              cause,
            }),
          ),
      }),
    );

  const requestJson = <S extends Schema.Top>(
    apiKey: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ) => send(apiKey, request).pipe(Effect.flatMap((response) => readJson(response, schema)));

  const requestOk = (apiKey: string, request: HttpClientRequest.HttpClientRequest) =>
    send(apiKey, request).pipe(Effect.flatMap(readOk), Effect.asVoid);

  const listAll = Effect.fn("VoiceAgentService.listAll")(function* <
    S extends typeof ToolsPage | typeof AgentsPage,
    Item,
  >(apiKey: string, resource: string, schema: S, items: (page: S["Type"]) => ReadonlyArray<Item>) {
    const all: Array<Item> = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
      const body = yield* requestJson(
        apiKey,
        HttpClientRequest.get(`${ELEVENLABS_API}${resource}`, {
          urlParams: { page_size: "100", ...(cursor === undefined ? {} : { cursor }) },
        }),
        schema,
      );
      all.push(...items(body));
      cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
      if (cursor === undefined) break;
    }
    return all;
  });

  const upsertTools = Effect.fn("VoiceAgentService.upsertTools")(function* (apiKey: string) {
    const existing = yield* listAll(apiKey, "/convai/tools", ToolsPage, (page) => page.tools);
    const idsByName = new Map(existing.map((tool) => [tool.tool_config?.name, tool.id]));
    return yield* Effect.forEach(VOICE_AGENT_TOOLS, (tool) => {
      const body = { tool_config: tool };
      const id = idsByName.get(tool.name);
      return id === undefined
        ? requestJson(
            apiKey,
            HttpClientRequest.post(`${ELEVENLABS_API}/convai/tools`).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
            SavedTool,
          ).pipe(Effect.map((saved) => saved.id))
        : requestOk(
            apiKey,
            HttpClientRequest.patch(
              `${ELEVENLABS_API}/convai/tools/${encodeURIComponent(id)}`,
            ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
          ).pipe(Effect.as(id));
    });
  });

  const agentUrl = (agentId: string) =>
    `${ELEVENLABS_API}/convai/agents/${encodeURIComponent(agentId)}`;

  const getAgent = (apiKey: string, agentId: string) =>
    requestJson(apiKey, HttpClientRequest.get(agentUrl(agentId)), AgentDetail);

  /**
   * False when the agent is gone, or another server on the key pushed its own definition.
   * A check that fails any other way reads as true, so it never costs the call its token.
   */
  const holdsDefinition = Effect.fn("VoiceAgentService.holdsDefinition")(
    function* (apiKey: string, agentId: string) {
      const response = yield* send(apiKey, HttpClientRequest.get(agentUrl(agentId)));
      if (response.status === 404) return false;
      const agent = yield* readJson(response, AgentDetail);
      return agent.tags?.includes(definitionTag) === true;
    },
    Effect.catch((cause) =>
      Effect.logWarning("Couldn't check the voice agent's definition; using the saved agent.", {
        cause,
      }).pipe(Effect.as(true)),
    ),
  );

  /** Upserts the tools by name, finds the agent by name or creates it, and saves which one it is. */
  const pushDefinition = Effect.fn("VoiceAgentService.pushDefinition")(function* (apiKey: string) {
    const toolIds = yield* upsertTools(apiKey);
    const agents = yield* listAll(apiKey, "/convai/agents", AgentsPage, (page) => page.agents);
    const found = agents.find((agent) => agent.name === VOICE_AGENT_NAME)?.agent_id;
    let agentId: string;
    if (found === undefined) {
      const created = yield* requestJson(
        apiKey,
        HttpClientRequest.post(`${ELEVENLABS_API}/convai/agents/create`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ ...voiceAgentFields(toolIds), tags: [definitionTag] }),
        ),
        CreatedAgent,
      );
      agentId = created.agent_id;
    } else {
      const current = yield* getAgent(apiKey, found);
      const clientEvents = current.conversation_config?.conversation?.client_events ?? [];
      const tags = [
        ...(current.tags ?? []).filter((tag) => !tag.startsWith(DEFINITION_TAG_PREFIX)),
        definitionTag,
      ];
      yield* requestOk(
        apiKey,
        HttpClientRequest.patch(agentUrl(found)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ ...voiceAgentFields(toolIds, clientEvents), tags }),
        ),
      );
      agentId = found;
    }
    yield* saveAgent({
      agentId,
      definitionHash,
      keyFingerprint: yield* keyFingerprint(apiKey),
    });
    return agentId;
  });

  const ensureAgent = Effect.fn("VoiceAgentService.ensureAgent")(function* (apiKey: string) {
    const saved = yield* readSavedAgent;
    return Option.isSome(saved) &&
      saved.value.definitionHash === definitionHash &&
      saved.value.keyFingerprint === (yield* keyFingerprint(apiKey))
      ? saved.value.agentId
      : yield* pushDefinition(apiKey);
  });

  const requestToken = (apiKey: string, agentId: string) =>
    send(
      apiKey,
      HttpClientRequest.get(`${ELEVENLABS_API}/convai/conversation/token`, {
        urlParams: { agent_id: agentId },
      }),
    );

  const syncAgent = Effect.fn("VoiceAgentService.syncAgent")(function* () {
    const { elevenLabsApiKey, agentIdOverride } = yield* readVoiceSettings;
    if (agentIdOverride !== "") {
      const agent = yield* getAgent(elevenLabsApiKey, agentIdOverride);
      return { agentId: agentIdOverride, agentName: agent.name?.trim() || VOICE_AGENT_NAME };
    }
    const agentId = yield* syncLock.withPermits(1)(pushDefinition(elevenLabsApiKey));
    return { agentId, agentName: VOICE_AGENT_NAME };
  });

  const callToken = Effect.fn("VoiceAgentService.callToken")(function* () {
    const { elevenLabsApiKey, agentIdOverride } = yield* readVoiceSettings;
    if (agentIdOverride !== "") {
      const response = yield* requestToken(elevenLabsApiKey, agentIdOverride);
      const { token } = yield* readJson(response, ConversationToken);
      return { token, agentId: agentIdOverride };
    }
    const agentId = yield* syncLock.withPermits(1)(ensureAgent(elevenLabsApiKey));
    // Checked in parallel with the mint rather than before it, to keep call start fast.
    const [current, response] = yield* Effect.all(
      [holdsDefinition(elevenLabsApiKey, agentId), requestToken(elevenLabsApiKey, agentId)],
      { concurrency: "unbounded" },
    );
    if (current && response.status !== 404) {
      const { token } = yield* readJson(response, ConversationToken);
      return { token, agentId };
    }
    // Deleted in ElevenLabs, or rewritten by another server on the key: set it up again, once.
    const synced = yield* syncLock.withPermits(1)(pushDefinition(elevenLabsApiKey));
    const retried = yield* requestToken(elevenLabsApiKey, synced);
    const { token } = yield* readJson(retried, ConversationToken);
    return { token, agentId: synced };
  });

  return VoiceAgentService.of({ syncAgent, callToken });
});

export const layer = Layer.effect(VoiceAgentService, make);

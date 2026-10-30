import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2UserMessageInputIntent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectVoiceEnvironment, voiceDelivery, type VoiceEnvironmentCandidate } from "./host.ts";
import { itemBase, projection } from "./voice.testkit.ts";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

describe("selectVoiceEnvironment", () => {
  const candidate = (
    environmentId: EnvironmentId,
    fields: Partial<VoiceEnvironmentCandidate>,
  ): VoiceEnvironmentCandidate => ({
    environmentId,
    primary: environmentId === primary,
    hasKey: true,
    canCall: true,
    ...fields,
  });

  it.each([
    ["prefers the primary", [candidate(remote, {}), candidate(primary, {})], primary],
    [
      "falls back to another keyed environment",
      [candidate(primary, { hasKey: false }), candidate(remote, {})],
      remote,
    ],
    [
      "skips a read-only primary for one that may call",
      [candidate(primary, { canCall: false }), candidate(remote, {})],
      remote,
    ],
    [
      "still picks a keyed one when none may call, so the server names the missing scope",
      [candidate(primary, { canCall: false }), candidate(remote, { canCall: false })],
      primary,
    ],
    ["finds none without a key", [candidate(primary, { hasKey: false })], null],
  ] as const)("%s", (_, candidates, selected) => {
    expect(selectVoiceEnvironment(candidates)).toBe(selected);
  });
});

describe("voiceDelivery", () => {
  const sent = MessageId.make("sent");
  const withIntent = (inputIntent: OrchestrationV2UserMessageInputIntent) =>
    projection({
      turnItems: [
        {
          ...itemBase("user-item"),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          messageId: sent,
          inputIntent,
          text: "Fix the lint too",
          attachments: [],
        },
      ],
    });

  it.each([
    ["turn_start", "started"],
    ["steer", "steered"],
    ["promoted_queued_to_steer", "steered"],
    ["queued_turn", "queued"],
  ] as const)("reads %s as %s", (inputIntent, delivery) => {
    expect(voiceDelivery(withIntent(inputIntent), sent)).toBe(delivery);
  });

  it("reads a message without its item yet as queued, and a failed read as unknown", () => {
    expect(voiceDelivery(projection(), sent)).toBe("queued");
    expect(voiceDelivery(null, sent)).toBeNull();
  });
});

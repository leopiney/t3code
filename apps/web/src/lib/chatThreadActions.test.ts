import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveNewThreadModelDefaults,
  resolveNewThreadModelSelectionOverride,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});

function provider(
  instanceId: string,
  model: string,
  availability: ServerProvider["availability"] = "available",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    availability,
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [{ slug: model, name: model, isCustom: false, isDefault: true, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
}

const CODEX: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" };
const CLAUDE: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
};
const PROJECT_DEFAULT: ModelSelection = { ...CLAUDE, model: "claude-project-default" };

describe("resolveNewThreadModelDefaults", () => {
  it.each([
    [
      "the project default over the composer's pick",
      PROJECT_DEFAULT,
      CODEX,
      "available",
      PROJECT_DEFAULT,
      PROJECT_DEFAULT,
    ],
    ["the composer's pick without a project default", null, CLAUDE, "available", null, CLAUDE],
    ["the first ready provider when the pick can't run", null, CLAUDE, "unavailable", null, CODEX],
    ["the first ready provider without a pick", null, null, "available", null, CODEX],
  ] as const)(
    "starts on %s",
    (_case, projectDefault, composerPick, claudeAvailability, override, selection) => {
      expect(
        resolveNewThreadModelDefaults({
          projectDefault,
          composerPick,
          providers: [
            provider("codex", CODEX.model),
            provider("claudeAgent", CLAUDE.model, claudeAvailability),
          ],
          settings: DEFAULT_SERVER_SETTINGS,
          projectId: ProjectId.make("project-1"),
          now: 0,
        }),
      ).toEqual({ override, selection });
    },
  );
});

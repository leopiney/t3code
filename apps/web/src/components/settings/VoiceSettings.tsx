import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T3BudAnimal, VoiceAgentSpeakMode } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import {
  updateClientSettings,
  useClientSettings,
  useEnvironmentSettings,
} from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceEnvironment } from "../../state/voice";
import { Button, InlineButton } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { selectT3BudAnimal, selectT3BudEnabled, selectT3BudSpeaks } from "../voice/t3BudCall";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const ELEVENLABS_API_KEYS_URL = "https://elevenlabs.io/app/developers/api-keys";

const ANIMAL_LABELS: Record<T3BudAnimal, string> = {
  wolf: "Wolf",
  frog: "Frog",
  capybara: "Capybara",
  axolotl: "Axolotl",
};

const SPEAK_MODE_LABELS: Record<VoiceAgentSpeakMode, string> = {
  all: "Finished work and what needs you",
  needs: "Only what needs you",
  none: "Nothing",
};

type SetupState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "done" | "failed"; readonly message: string };

export function VoiceSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  const t3BudEnabled = useClientSettings(selectT3BudEnabled);
  const speakMode = useClientSettings(selectT3BudSpeaks);
  const animal = useClientSettings(selectT3BudAnimal);

  return (
    <SettingsPageContainer>
      <SettingsSection id="elevenlabs" title="ElevenLabs">
        {environment === null ? (
          <SettingsRow
            {...searchableSetting("voice-elevenlabs-key")}
            description={
              scope.kind === "unavailable"
                ? scope.message
                : scope.kind === "environment"
                  ? `Reconnect ${scope.label} to change its ElevenLabs API key.`
                  : "Connect an environment to keep the ElevenLabs API key on it."
            }
          />
        ) : environment.serverConfig?.environment.capabilities.voiceAgent === true ? (
          <ElevenLabsSettings key={environment.environmentId} environment={environment} />
        ) : (
          <SettingsRow
            {...searchableSetting("voice-elevenlabs-key")}
            description={`Update ${environment.label} to keep an ElevenLabs API key on it.`}
          />
        )}
      </SettingsSection>

      <SettingsSection id="t3bud" title="T3Bud">
        <SettingsRow
          {...searchableSetting("t3bud-enabled")}
          description="A voice buddy in the corner of every screen on this device. Call it to hear what your threads need and tell them what to do."
          control={
            <Switch
              checked={t3BudEnabled}
              onCheckedChange={(checked) =>
                void updateClientSettings({ t3BudEnabled: Boolean(checked) })
              }
              aria-label="Show T3Bud"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("t3bud-animal")}
          description="The animal T3Bud appears as on this device. It plays the same one on calls."
          control={
            <Select
              value={animal}
              onValueChange={(value) => {
                const next = T3BudAnimal.literals.find((candidate) => candidate === value);
                if (next) void updateClientSettings({ t3BudAnimal: next });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="T3Bud's animal">
                <SelectValue>{(value: T3BudAnimal) => ANIMAL_LABELS[value]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {T3BudAnimal.literals.map((option) => (
                  <SelectItem hideIndicator key={option} value={option}>
                    {ANIMAL_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("t3bud-speaks")}
          description="What T3Bud says on a call without a question from you. Approvals, questions, failures and usage limits need you. Everything else still reaches it quietly, so you can ask."
          control={
            <Select
              value={speakMode}
              onValueChange={(value) => {
                const mode = VoiceAgentSpeakMode.literals.find((candidate) => candidate === value);
                if (mode) void updateClientSettings({ t3BudSpeaks: mode });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="Speak updates aloud">
                <SelectValue>
                  {(value: VoiceAgentSpeakMode) => SPEAK_MODE_LABELS[value]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {VoiceAgentSpeakMode.literals.map((mode) => (
                  <SelectItem hideIndicator key={mode} value={mode}>
                    {SPEAK_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ElevenLabsSettings({ environment }: { readonly environment: EnvironmentPresentation }) {
  const { environmentId } = environment;
  // Clients see the redaction marker for a stored key and "" without one.
  const hasKey =
    useEnvironmentSettings(environmentId, (settings) => settings.voiceAgent.elevenLabsApiKey) !==
    "";
  const canSetUp = useAtomValue(voiceEnvironment.syncAgent.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save the ElevenLabs API key",
  });
  const syncAgent = useAtomCommand(voiceEnvironment.syncAgent, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [setup, setSetup] = useState<SetupState>({ status: "idle" });

  const saveKey = async (elevenLabsApiKey: string) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { voiceAgent: { elevenLabsApiKey } } },
    });
    setSaving(false);
    if (result._tag !== "Success") return;
    setDraft("");
    setSetup({ status: "idle" });
  };

  const setUpAgent = async () => {
    setSetup({ status: "running" });
    const result = await syncAgent({ environmentId, input: {} });
    if (result._tag === "Success") {
      setSetup({ status: "done", message: `${result.value.agentName} is ready to call.` });
      return;
    }
    const error = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
    setSetup({
      status: "failed",
      message:
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Setting up the voice agent failed.",
    });
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("voice-elevenlabs-key")}
        serverScoped
        settingKeys={["voiceAgent"]}
        description={
          <>
            Kept on {environment.label}. Calls go through a connected environment that has a key and
            lets this device call, the primary one first. Clients only learn whether it is set. Give
            the key access to ElevenLabs Agents.{" "}
            <InlineButton
              tone="muted"
              render={
                <a href={ELEVENLABS_API_KEYS_URL} target="_blank" rel="noreferrer noopener" />
              }
            >
              Create a key
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>
          </>
        }
        status={hasKey ? "Set." : "Not set."}
        control={
          <form
            className="flex w-full items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== "") void saveKey(draft.trim());
            }}
          >
            <SecretInput
              size="sm"
              className="w-full sm:w-56"
              configured={hasKey}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="ElevenLabs API key"
            />
            <Button type="submit" size="xs" disabled={saving || draft.trim() === ""}>
              {hasKey ? "Replace" : "Save"}
            </Button>
            {hasKey ? (
              <Button
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => void saveKey("")}
              >
                Remove
              </Button>
            ) : null}
          </form>
        }
      />
      <SettingsRow
        {...searchableSetting("voice-agent-setup")}
        description="The first call creates T3Bud in your ElevenLabs account and keeps it up to date. Set it up now to check the key."
        status={
          setup.status === "done" ? (
            setup.message
          ) : setup.status === "failed" ? (
            <span role="alert" className="text-destructive-foreground">
              {setup.message}
            </span>
          ) : null
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!hasKey || !canSetUp || setup.status === "running"}
            onClick={() => void setUpAgent()}
          >
            {setup.status === "running" ? "Setting up…" : "Set up voice agent"}
          </Button>
        }
      />
    </>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_T3BUD_SIZE,
  MAX_T3BUD_SIZE,
  MIN_T3BUD_SIZE,
  T3BudAnimal,
  VoiceAgentSpeakMode,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

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
import { RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  selectT3BudAnimal,
  selectT3BudEnabled,
  selectT3BudSize,
  selectT3BudSpeaks,
  t3BudAssetUrl,
} from "../voice/t3BudCall";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

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
  const size = useClientSettings(selectT3BudSize);
  const sizeRatio = (size - MIN_T3BUD_SIZE) / (MAX_T3BUD_SIZE - MIN_T3BUD_SIZE);
  const sizeSliderStyle = {
    "--settings-slider-progress": `${sizeRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - sizeRatio}rem`,
  } as CSSProperties;

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
        >
          <T3BudAnimalPicker
            value={animal}
            onValueChange={(next) => void updateClientSettings({ t3BudAnimal: next })}
          />
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("t3bud-size")}
          description="How wide T3Bud's circle is on this device. The animal grows and shrinks with it."
          resetAction={
            size !== DEFAULT_T3BUD_SIZE ? (
              <SettingResetButton
                label="T3Bud size"
                onClick={() => void updateClientSettings({ t3BudSize: DEFAULT_T3BUD_SIZE })}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="t3bud-size-slider"
              >
                {size}px
              </output>
              <input
                aria-label="T3Bud size"
                className="settings-slider min-w-0 flex-1"
                id="t3bud-size-slider"
                max={MAX_T3BUD_SIZE}
                min={MIN_T3BUD_SIZE}
                onChange={(event) => {
                  const t3BudSize = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(t3BudSize) &&
                    t3BudSize >= MIN_T3BUD_SIZE &&
                    t3BudSize <= MAX_T3BUD_SIZE
                  ) {
                    void updateClientSettings({ t3BudSize });
                  }
                }}
                step={4}
                style={sizeSliderStyle}
                type="range"
                value={size}
              />
            </div>
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

/** Every animal as its icon; the chosen one is ringed and the rest dim until hovered. */
function T3BudAnimalPicker({
  value,
  onValueChange,
}: {
  readonly value: T3BudAnimal;
  readonly onValueChange: (animal: T3BudAnimal) => void;
}) {
  return (
    <RadioGroup
      aria-label="T3Bud's animal"
      value={value}
      onValueChange={(next) => {
        const animal = T3BudAnimal.literals.find((candidate) => candidate === next);
        if (animal) onValueChange(animal);
      }}
      className="mt-3 mb-2 grid max-w-md grid-cols-4"
    >
      {T3BudAnimal.literals.map((option) => (
        <RadioPrimitive.Root
          key={option}
          value={option}
          className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg p-2 text-muted-foreground opacity-50 outline-none transition-opacity hover:opacity-80 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:opacity-100 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary dark:data-checked:bg-primary/15"
        >
          <img
            src={t3BudAssetUrl(option, "png")}
            alt=""
            draggable={false}
            width={56}
            height={56}
            className="size-14 rounded-full"
          />
          <span className="text-xs font-medium">{ANIMAL_LABELS[option]}</span>
        </RadioPrimitive.Root>
      ))}
    </RadioGroup>
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

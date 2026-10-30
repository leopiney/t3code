import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  DEFAULT_T3BUD_BACKGROUND,
  T3BUD_BACKGROUND_PRESETS,
  T3BudAnimal,
  type T3BudBackground,
  type VoiceAgentSpeakMode,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Image } from "expo-image";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceEnvironment } from "../../state/voice";
import { T3BUD_ANIMAL_IMAGES, T3BUD_ANIMAL_LABELS } from "../voice-agent/t3BudAnimals";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SettingsTarget } from "./settings-environment-filter";

const SPEAK_OPTIONS: ReadonlyArray<{
  readonly mode: VoiceAgentSpeakMode;
  readonly label: string;
  readonly description?: string;
}> = [
  { mode: "all", label: "Finished work and what needs you" },
  {
    mode: "needs",
    label: "Only what needs you",
    description: "Approvals, questions, failures and usage limits.",
  },
  { mode: "none", label: "Nothing", description: "T3Bud speaks only when you ask." },
];

const ELEVENLABS_FOOTER =
  "Use a key with ElevenLabs Agents access. The environment stores it and never sends it back to this device. A call goes through one environment with a key, and that ElevenLabs account hears about your threads on every connected environment.";

export function SettingsVoiceRouteScreen() {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Voice">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <T3BudSettingsSections />
        <ElevenLabsSettingsSections />
      </ScrollView>
    </SettingsScreen>
  );
}

function T3BudSettingsSections() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const stored = AsyncResult.isSuccess(preferences) ? preferences.value : null;
  const speaks = stored?.t3BudSpeaks ?? "all";
  const animal = stored?.t3BudAnimal ?? "wolf";
  const background = stored?.t3BudBackground ?? DEFAULT_T3BUD_BACKGROUND;
  return (
    <>
      <SettingsSection
        title="T3Bud"
        footer="A voice agent that follows your threads, tells you when one finishes or needs you, and acts on them when you ask."
      >
        <SettingsSwitchRow
          icon="waveform"
          label="Show T3Bud"
          value={stored?.t3BudEnabled === true}
          disabled={!ready}
          onValueChange={(value) => savePreferences({ t3BudEnabled: value })}
        />
      </SettingsSection>
      <SettingsSection title="Animal" footer="T3Bud plays the same animal on calls.">
        <T3BudAnimalPicker
          value={animal}
          background={background}
          disabled={!ready}
          onChange={(next) => savePreferences({ t3BudAnimal: next })}
        />
      </SettingsSection>
      <SettingsSection title="Background" footer="The color of T3Bud's circle on this device.">
        <T3BudBackgroundPicker
          value={background}
          disabled={!ready}
          onChange={(next) => savePreferences({ t3BudBackground: next })}
        />
      </SettingsSection>
      <SettingsSection
        title="Speak updates aloud"
        footer="Updates T3Bud doesn't speak still reach it, so you can ask what happened."
      >
        {SPEAK_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.mode}
            label={option.label}
            description={option.description}
            selected={speaks === option.mode}
            separated={index > 0}
            disabled={!ready}
            onPress={() => savePreferences({ t3BudSpeaks: option.mode })}
          />
        ))}
      </SettingsSection>
    </>
  );
}

/** Every animal as its icon, four across; the chosen one is ringed and the rest dimmed. */
function T3BudAnimalPicker(props: {
  readonly value: T3BudAnimal;
  readonly background: T3BudBackground;
  readonly disabled: boolean;
  readonly onChange: (animal: T3BudAnimal) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" className="flex-row bg-grouped-card px-2 py-3">
      {T3BudAnimal.literals.map((option) => {
        const selected = props.value === option;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityLabel={T3BUD_ANIMAL_LABELS[option]}
            accessibilityState={{ checked: selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange(option)}
            className={cn("flex-1 items-center gap-1.5", !selected && "opacity-45")}
          >
            <View
              className={cn(
                "rounded-full border-2 p-0.5",
                selected ? "border-primary" : "border-transparent",
              )}
            >
              <Image
                source={T3BUD_ANIMAL_IMAGES[option]}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: props.background,
                }}
                contentFit="contain"
                accessibilityIgnoresInvertColors
              />
            </View>
            <Text
              textRole="caption"
              className={cn(selected ? "font-t3-medium text-foreground" : "text-foreground-muted")}
            >
              {T3BUD_ANIMAL_LABELS[option]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The preset colors as swatches; the chosen one is ringed. */
function T3BudBackgroundPicker(props: {
  readonly value: T3BudBackground;
  readonly disabled: boolean;
  readonly onChange: (color: T3BudBackground) => void;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      className="flex-row justify-between bg-grouped-card px-4 py-3"
    >
      {T3BUD_BACKGROUND_PRESETS.map((preset) => {
        const selected = props.value.toLowerCase() === preset.color;
        return (
          <Pressable
            key={preset.color}
            accessibilityRole="radio"
            accessibilityLabel={preset.label}
            accessibilityState={{ checked: selected, disabled: props.disabled }}
            disabled={props.disabled}
            hitSlop={4}
            onPress={() => props.onChange(preset.color)}
            className={cn(
              "rounded-full border-2 p-0.5",
              selected ? "border-primary" : "border-transparent",
            )}
          >
            <View
              className="size-[32px] rounded-full border border-border"
              style={{ backgroundColor: preset.color }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function ElevenLabsSettingsSections() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment): environment is SettingsTarget =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const writable = useEnvironmentsWithScope(connected, AuthSettingsWriteScope);
  if (connected.length === 0) {
    return (
      <SettingsSection title="ElevenLabs">
        <Text className="p-4 text-foreground-muted">
          Connect an environment to add an ElevenLabs API key.
        </Text>
      </SettingsSection>
    );
  }
  return connected.map((environment, index) => {
    const title = connected.length > 1 ? `ElevenLabs · ${environment.label}` : "ElevenLabs";
    const footer = index === connected.length - 1 ? ELEVENLABS_FOOTER : undefined;
    // Older servers accept the key patch and silently drop it.
    if (environment.serverConfig.environment.capabilities.voiceAgent !== true) {
      return (
        <SettingsSection key={environment.environmentId} title={title} footer={footer}>
          <Text className="p-4 text-sm text-foreground-muted">
            {`Update ${environment.label} to keep an ElevenLabs key on it.`}
          </Text>
        </SettingsSection>
      );
    }
    return (
      <ElevenLabsKeySection
        key={environment.environmentId}
        environment={environment}
        title={title}
        writable={writable.has(environment.environmentId)}
        footer={footer}
      />
    );
  });
}

function failureText(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

function ElevenLabsKeySection(props: {
  readonly environment: SettingsTarget;
  readonly title: string;
  readonly writable: boolean;
  readonly footer: string | undefined;
}) {
  const { environment } = props;
  const environmentId = environment.environmentId;
  const hasKey = environment.serverConfig.settings.voiceAgent.elevenLabsApiKey !== "";
  const options = { reportFailure: false };
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, options);
  const syncAgent = useAtomCommand(voiceEnvironment.syncAgent, options);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"save" | "setup" | "remove" | null>(null);
  const [outcome, setOutcome] = useState<{ readonly ok: boolean; readonly text: string } | null>(
    null,
  );

  const setUp = async () => {
    setPending("setup");
    setOutcome(null);
    const result = await syncAgent({ environmentId, input: {} });
    setPending(null);
    if (result._tag === "Success") {
      setOutcome({ ok: true, text: `${result.value.agentName} is ready to take calls.` });
      return;
    }
    const error = failureText(result);
    if (error !== null) setOutcome({ ok: false, text: error });
  };
  const writeKey = async (key: string, action: "save" | "remove") => {
    setPending(action);
    setOutcome(null);
    const result = await updateSettings({
      environmentId,
      input: { patch: { voiceAgent: { elevenLabsApiKey: key } } },
    });
    setPending(null);
    const error = failureText(result);
    if (error !== null) setOutcome({ ok: false, text: error });
    return result._tag === "Success";
  };
  const save = async () => {
    const key = draft.trim();
    if (key === "" || pending !== null) return;
    if (!(await writeKey(key, "save"))) return;
    setDraft("");
    // Setting up checks the key at once instead of on the first call.
    await setUp();
  };
  const remove = () =>
    Dialog.confirm({
      title: "Remove the ElevenLabs key?",
      message: `T3Bud can't call through ${environment.label} until a key is added again.`,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void writeKey("", "remove"),
    });

  return (
    <SettingsSection title={props.title} footer={props.footer}>
      <ListRowLayout icon="key" label="API key" detail={hasKey ? "Saved" : "Not set"} />
      {props.writable ? (
        <>
          <View className="gap-3 border-t border-border-subtle p-4">
            <AppTextInput
              accessibilityLabel="ElevenLabs API key"
              placeholder={
                hasKey ? "Paste a new key to replace it" : "Paste your ElevenLabs API key"
              }
              value={draft}
              onChangeText={setDraft}
              editable={pending === null}
              secureTextEntry
              autoCorrect={false}
              autoCapitalize="none"
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              spellCheck={false}
              returnKeyType="done"
              onSubmitEditing={() => void save()}
            />
            <Button
              label={hasKey ? "Replace key" : "Save key"}
              tone="primary"
              fullWidth
              loading={pending === "save"}
              disabled={pending !== null || draft.trim() === ""}
              onPress={() => void save()}
            />
          </View>
          {hasKey ? (
            <>
              <SettingsActionRow
                icon="sparkles"
                label="Set up voice agent"
                description="Checks the key and creates or updates T3Bud in your ElevenLabs account."
                loading={pending === "setup"}
                disabled={pending !== null}
                onPress={() => void setUp()}
              />
              <SettingsActionRow
                icon="trash"
                label="Remove key"
                tone="danger"
                loading={pending === "remove"}
                disabled={pending !== null}
                onPress={remove}
              />
            </>
          ) : null}
        </>
      ) : (
        <Text className="border-t border-border-subtle p-4 text-sm text-foreground-muted">
          {`This session can't change ${environment.label}'s settings.`}
        </Text>
      )}
      {outcome !== null ? (
        <Text
          accessibilityLiveRegion="polite"
          className={cn(
            "border-t border-border-subtle px-4 py-3 text-sm",
            outcome.ok ? "text-foreground" : "text-danger-foreground",
          )}
        >
          {outcome.text}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

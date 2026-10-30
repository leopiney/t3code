import { useAtomValue } from "@effect/atom-react";
import type { VoiceFeedEntry, VoiceSessionState } from "@t3tools/client-runtime/voice/types";
import { DEFAULT_T3BUD_BACKGROUND } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Image } from "expo-image";
import { useState } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom } from "../../state/preferences";
import { T3BUD_ANIMAL_IMAGES } from "./t3BudAnimals";
import {
  DICTATION_PILL_HEIGHT,
  useEdgeControlBottom,
} from "../voice-input/GlobalVoiceInputControl";

const TAB_WIDTH = 60;
const TAB_HEIGHT = 48;
const CARD_MAX_WIDTH = 320;
const FEED_ROWS = 3;

export interface T3BudCallControls {
  readonly call: () => void;
  readonly end: () => void;
  readonly toggleMute: () => void;
}

function inCall(state: VoiceSessionState): boolean {
  return state.status === "connecting" || state.status === "live";
}

function statusLine(state: VoiceSessionState): string {
  switch (state.status) {
    case "idle":
      return "Not in a call";
    case "connecting":
      return "Connecting…";
    case "error":
      return "The call failed";
    case "live": {
      const activity = state.muted
        ? "Muted"
        : state.mode === "speaking"
          ? "Speaking"
          : state.userSpeaking
            ? "Hearing you"
            : "Listening";
      return state.waiting > 0 ? `${activity} · ${state.waiting} waiting` : activity;
    }
  }
}

const FEED_TONE_CLASS: Record<VoiceFeedEntry["tone"], string> = {
  ok: "text-foreground-muted",
  attention: "text-warning-foreground",
  bad: "text-danger-foreground",
  action: "text-primary-text",
};

function BuddyAvatar(props: { readonly state: VoiceSessionState; readonly size: number }) {
  const { state, size } = props;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences) ? preferences.value : null;
  const animal = stored?.t3BudAnimal ?? "wolf";
  const background = stored?.t3BudBackground ?? DEFAULT_T3BUD_BACKGROUND;
  return (
    <View
      className={cn(
        "items-center justify-center rounded-full border-2",
        state.status === "error" || (state.status === "live" && state.muted)
          ? "border-danger"
          : state.status === "live"
            ? "border-primary"
            : "border-transparent",
      )}
      style={{ width: size + 4, height: size + 4, backgroundColor: background }}
    >
      <Image
        source={T3BUD_ANIMAL_IMAGES[animal]}
        style={{ width: size, height: size, opacity: state.status === "connecting" ? 0.5 : 1 }}
        contentFit="contain"
        accessibilityIgnoresInvertColors
      />
      {state.status === "connecting" ? (
        <View className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator size="small" colorClassName="accent-icon" />
        </View>
      ) : null}
    </View>
  );
}

/**
 * T3Bud docked at the screen's right edge above the dictation pill: an animal tab that starts a
 * call, opening into a card with the agent's words, recent events, and the call controls.
 */
export function T3BudButton(props: {
  readonly state: VoiceSessionState;
  /** Why a call can't start, shown instead of calling. */
  readonly blocker: string | null;
  /** The environment whose ElevenLabs account takes the call. */
  readonly via: string | null;
  readonly controls: T3BudCallControls;
}) {
  const { state, blocker, via, controls } = props;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const bottom = useEdgeControlBottom() + DICTATION_PILL_HEIGHT + 12;
  const keyboardVisible = useKeyboardState((keyboard) => keyboard.isVisible);
  const [expanded, setExpanded] = useState(false);
  // It would sit on the composer while typing; the call carries on.
  if (keyboardVisible) return null;

  const content = expanded ? (
    <View
      className="absolute gap-3 rounded-l-3xl border border-r-0 border-border bg-card p-3 shadow-md shadow-black/10"
      style={{
        bottom,
        right: insets.right,
        width: Math.min(width - insets.left - insets.right - 32, CARD_MAX_WIDTH),
      }}
    >
      <View className="flex-row items-center gap-2.5">
        <BuddyAvatar state={state} size={36} />
        <View className="min-w-0 flex-1">
          <Text className="font-t3-bold text-sm text-foreground" numberOfLines={1}>
            T3Bud
            {via !== null ? (
              <Text className="font-sans text-xs text-foreground-muted">{` via ${via}`}</Text>
            ) : null}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {statusLine(state)}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Hide T3Bud"
          accessibilityRole="button"
          className="size-[32px] items-center justify-center active:opacity-70"
          hitSlop={6}
          onPress={() => setExpanded(false)}
        >
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
      {blocker !== null && !inCall(state) ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {blocker}
        </Text>
      ) : state.status === "error" && state.error !== null ? (
        <Text
          accessibilityLiveRegion="polite"
          className="text-sm text-danger-foreground"
          numberOfLines={4}
        >
          {state.error}
        </Text>
      ) : state.agentLine !== null && inCall(state) ? (
        <Text
          accessibilityLiveRegion="polite"
          className={cn(
            "text-sm",
            state.agentLine.final ? "text-foreground" : "text-foreground-muted",
          )}
          numberOfLines={4}
        >
          {state.agentLine.text}
        </Text>
      ) : null}
      {state.feed.length > 0 ? (
        <View className="gap-1">
          {state.feed.slice(-FEED_ROWS).map((entry) => (
            <Text key={entry.id} className="text-xs text-foreground-muted" numberOfLines={1}>
              <Text className="font-t3-medium text-xs text-foreground">{entry.title}</Text>
              <Text className={cn("text-xs", FEED_TONE_CLASS[entry.tone])}>{` ${entry.text}`}</Text>
            </Text>
          ))}
        </View>
      ) : null}
      {inCall(state) ? (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              label={state.muted ? "Unmute" : "Mute"}
              icon={state.muted ? "mic.slash" : "mic"}
              disabled={state.status !== "live"}
              fullWidth
              onPress={controls.toggleMute}
            />
          </View>
          <View className="flex-1">
            <Button
              label="End"
              icon="phone.down.fill"
              tone="danger"
              fullWidth
              onPress={controls.end}
            />
          </View>
        </View>
      ) : (
        <Button
          label="Call"
          icon="phone.fill"
          tone="primary"
          fullWidth
          disabled={blocker !== null}
          onPress={controls.call}
        />
      )}
    </View>
  ) : (
    <Pressable
      accessibilityLabel={`T3Bud, ${statusLine(state)}${via !== null ? `, via ${via}` : ""}`}
      accessibilityHint={
        inCall(state)
          ? "Shows the call controls"
          : blocker !== null
            ? "Shows why T3Bud can't call"
            : "Calls T3Bud"
      }
      accessibilityRole="button"
      className="absolute items-center justify-center rounded-l-full border border-r-0 border-border bg-card shadow-md shadow-black/10 active:opacity-70"
      style={{ bottom, right: insets.right, width: TAB_WIDTH, height: TAB_HEIGHT }}
      onPress={() => {
        if (!inCall(state) && blocker === null) controls.call();
        setExpanded(true);
      }}
    >
      <BuddyAvatar state={state} size={34} />
      {state.waiting > 0 ? (
        <View className="absolute left-1 top-0.5 min-w-[18px] items-center rounded-full bg-primary px-1">
          <Text className="font-t3-bold text-3xs text-primary-foreground">{state.waiting}</Text>
        </View>
      ) : null}
    </Pressable>
  );

  const overlay = (
    <View pointerEvents="box-none" className="absolute inset-0">
      {content}
    </View>
  );
  return Platform.OS === "ios" ? <FullWindowOverlay>{overlay}</FullWindowOverlay> : overlay;
}

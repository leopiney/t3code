import { useAtomValue } from "@effect/atom-react";
import { ConversationProvider, useConversationControls } from "@elevenlabs/react-native";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useEnvironmentPresentation } from "../../state/presentation";
import { voiceCallBlockerAtom } from "../../state/voice";
import { connectMobileVoiceSession, createMobileVoiceSession } from "./mobileVoiceSession";
import { createMobileVoiceTransport } from "./mobileVoiceTransport";
import { T3BudButton } from "./T3BudButton";

interface T3BudCallProps {
  readonly navigate: (href: string) => void;
}

async function requestMicrophone(): Promise<void> {
  const permission = await requestRecordingPermissionsAsync();
  if (permission.granted) return;
  throw new Error(
    permission.canAskAgain
      ? "T3Bud needs the microphone to hear you."
      : "Microphone access is off for T3 Code. Turn it on in Settings, then call again.",
  );
}

function T3BudSession(props: T3BudCallProps) {
  const controls = useConversationControls();
  const [session] = useState(() =>
    createMobileVoiceSession({
      transport: createMobileVoiceTransport(controls, requestMicrophone),
      navigate: props.navigate,
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds the call the app's threads, open thread and speak mode, and ends it when T3Bud turns off
  useEffect(() => connectMobileVoiceSession(session), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const blocker = useAtomValue(voiceCallBlockerAtom);
  const via = useEnvironmentPresentation(state.environmentId).presentation?.entry.target.label;
  return (
    <T3BudButton
      state={state}
      blocker={blocker}
      via={via ?? null}
      controls={{
        call: () => void session.start(),
        end: () => void session.end(),
        toggleMute: () => session.toggleMute(),
      }}
    />
  );
}

/** Loaded only while T3Bud is on: importing the ElevenLabs SDK installs WebRTC globals. */
export default function T3BudCall(props: T3BudCallProps) {
  return (
    <ConversationProvider>
      <T3BudSession navigate={props.navigate} />
    </ConversationProvider>
  );
}

import { createFileRoute } from "@tanstack/react-router";

import { VoiceAgentSettingsPanel } from "../components/settings/VoiceAgentSettings";

export const Route = createFileRoute("/_chat/settings/voice-agent")({
  component: VoiceAgentSettingsPanel,
});

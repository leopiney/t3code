import { lazy, Suspense, useEffect } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { installWolfBudShortcut, selectWolfBudEnabled } from "./wolfBudCall";

// The call code, the ElevenLabs SDK and three.js load only once WolfBud is shown.
const WolfBud = lazy(() => import("./WolfBud").then((module) => ({ default: module.WolfBud })));

export function WolfBudHost() {
  const enabled = useClientSettings(selectWolfBudEnabled);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the call shortcut with the global keydown dispatcher while WolfBud is shown
  useEffect(() => {
    if (!enabled) return;
    return installWolfBudShortcut();
  }, [enabled]);

  if (!enabled) return null;
  return (
    <Suspense fallback={null}>
      <WolfBud />
    </Suspense>
  );
}

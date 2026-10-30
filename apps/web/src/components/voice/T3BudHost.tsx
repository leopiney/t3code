import { lazy, Suspense, useEffect } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { installT3BudShortcut, selectT3BudEnabled } from "./t3BudCall";

// The call code, the ElevenLabs SDK and three.js load only once T3Bud is shown.
const T3Bud = lazy(() => import("./T3Bud").then((module) => ({ default: module.T3Bud })));

export function T3BudHost() {
  const enabled = useClientSettings(selectT3BudEnabled);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the call shortcut with the global keydown dispatcher while T3Bud is shown
  useEffect(() => {
    if (!enabled) return;
    return installT3BudShortcut();
  }, [enabled]);

  if (!enabled) return null;
  return (
    <Suspense fallback={null}>
      <T3Bud />
    </Suspense>
  );
}

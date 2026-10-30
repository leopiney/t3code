import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { lazy, Suspense } from "react";

import { RenderErrorBoundary } from "../../components/RenderErrorBoundary";
import { mobilePreferencesAtom } from "../../state/preferences";

const WolfBudCall = lazy(() => import("./WolfBudCall"));

const renderNothing = () => null;

/** The WolfBud call button, once it is turned on in Settings › Voice. */
export function WolfBudHost(props: { readonly navigate: (href: string) => void }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences) || preferences.value.wolfBudEnabled !== true) {
    return null;
  }
  return (
    // A build without the WebRTC native modules fails the import; it must not take the app down.
    <RenderErrorBoundary renderFallback={renderNothing}>
      <Suspense fallback={null}>
        <WolfBudCall navigate={props.navigate} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

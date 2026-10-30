import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { lazy, Suspense } from "react";

import { RenderErrorBoundary } from "../../components/RenderErrorBoundary";
import { mobilePreferencesAtom } from "../../state/preferences";

const T3BudCall = lazy(() => import("./T3BudCall"));

const renderNothing = () => null;

/** The T3Bud call button, once it is turned on in Settings › Voice. */
export function T3BudHost(props: { readonly navigate: (href: string) => void }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences) || preferences.value.t3BudEnabled !== true) {
    return null;
  }
  return (
    // A build without the WebRTC native modules fails the import; it must not take the app down.
    <RenderErrorBoundary renderFallback={renderNothing}>
      <Suspense fallback={null}>
        <T3BudCall navigate={props.navigate} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

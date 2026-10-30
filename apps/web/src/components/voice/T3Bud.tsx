import { useAtomValue } from "@effect/atom-react";
import type { VoiceSession } from "@t3tools/client-runtime/voice/session";
import type { T3BudAnimal } from "@t3tools/contracts";
import type { VoiceFeedEntry, VoiceSessionState } from "@t3tools/client-runtime/voice/types";
import type { BuddyHead, BuddyMood } from "@t3tools/client-runtime/voice/buddy-head";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleXIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { useEnvironmentPresentation } from "../../state/presentation";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { voiceCallReadinessAtom, type VoiceCallReadiness } from "../../state/voice";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { createWebVoiceSession } from "./webVoiceSession";
import {
  attachT3BudSession,
  selectT3BudAnimal,
  selectT3BudSpeaks,
  t3BudAssetUrl,
} from "./t3BudCall";

/** The head's drawing size in CSS px; its button adds the ring around it. */
const BUDDY_SIZE = 56;
const BUDDY_BUTTON_SIZE = 64;
const DRAG_SLOP = 4;
const FEED_SHOWN = 4;
/** The card's `w-72` and `24rem` cap, its gap from T3Bud, and the margin it keeps from the window's edge. */
const CARD_WIDTH = 288;
const CARD_MAX_HEIGHT = 384;
const CARD_GAP = 8;
const CARD_EDGE = 8;

const WidgetLayout = Schema.Struct({
  right: Schema.Number,
  bottom: Schema.Number,
  open: Schema.Boolean,
});
type WidgetLayout = typeof WidgetLayout.Type;
const WIDGET_LAYOUT_STORAGE_KEY = "t3code:t3bud-widget:v1";
// Clear of the composer and its send button on most layouts; the user can drag it anywhere.
const DEFAULT_WIDGET_LAYOUT: WidgetLayout = { right: 20, bottom: 128, open: true };
const loadBuddyHead = () => import("@t3tools/client-runtime/voice/buddy-head");

export function T3Bud() {
  const router = useRouter();
  const [{ session, connect }] = useState(() => createWebVoiceSession(router));
  const speakMode = useClientSettings(selectT3BudSpeaks);
  const routeTarget = resolveThreadRouteTarget(useParams({ strict: false }));
  const openThread = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds the voice session the thread list and hands it to the palette and shortcut while T3Bud is shown
  useEffect(() => {
    const disconnect = connect();
    const detach = attachT3BudSession(session);
    return () => {
      detach();
      disconnect();
      void session.end();
    };
  }, [session, connect]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the voice session which thread the app shows, for tools that name none
  useEffect(() => {
    session.setOpenThread(openThread);
  }, [session, openThread]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the speak setting into the imperative voice session
  useEffect(() => {
    session.setSpeakMode(speakMode);
  }, [session, speakMode]);

  return <T3BudWidget session={session} state={state} />;
}

function buddyMood(state: VoiceSessionState): BuddyMood {
  if (state.status === "connecting") return "awake";
  if (state.status !== "live") return "asleep";
  if (state.mode === "speaking") return "speaking";
  return state.userSpeaking && !state.muted ? "listening" : "awake";
}

function statusLine(state: VoiceSessionState): string {
  switch (state.status) {
    case "idle":
      return "Not on a call";
    case "connecting":
      return "Calling…";
    case "error":
      return "The call stopped";
    case "live":
      if (state.mode === "speaking") return "Talking";
      if (state.muted) return "Muted";
      return state.userSpeaking ? "Hearing you" : "Listening";
  }
}

const RING_CLASS: Record<VoiceSessionState["status"], string> = {
  idle: "border-border",
  connecting: "border-info",
  live: "border-success",
  error: "border-destructive",
};

function FeedIcon({ tone }: { tone: VoiceFeedEntry["tone"] }) {
  switch (tone) {
    case "ok":
      return <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />;
    case "attention":
      return <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />;
    case "bad":
      return <CircleXIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
    case "action":
      return <ArrowRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info" />;
  }
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}
const readViewportWidth = () => window.innerWidth;
const readViewportHeight = () => window.innerHeight;

/** Where T3Bud is drawn: a spot saved in a larger window still keeps it on screen. */
function clampOffset(offset: number, viewport: number): number {
  return Math.max(0, Math.min(offset, viewport - BUDDY_BUTTON_SIZE));
}

const CALL_BLOCKED_REASON: Record<Exclude<VoiceCallReadiness, "ready">, string> = {
  noKey: "Add an ElevenLabs API key in Settings › Voice to call.",
  noAccess:
    "This device lacks access to start calls on the environments that keep an ElevenLabs key.",
};

function T3BudWidget({ session, state }: { session: VoiceSession; state: VoiceSessionState }) {
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const callShortcut = shortcutLabelForCommand(keybindings, "voice.toggleCall");
  const animal = useClientSettings(selectT3BudAnimal);
  // Mounted here so the permission reads stay warm for the palette, the shortcut and the call.
  const readiness = useAtomValue(voiceCallReadinessAtom);
  const viewportWidth = useSyncExternalStore(subscribeResize, readViewportWidth);
  const viewportHeight = useSyncExternalStore(subscribeResize, readViewportHeight);
  const [layout, setLayout] = useLocalStorage(
    WIDGET_LAYOUT_STORAGE_KEY,
    DEFAULT_WIDGET_LAYOUT,
    WidgetLayout,
  );
  const [dragPosition, setDragPosition] = useState<{ right: number; bottom: number } | null>(null);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly right: number;
    readonly bottom: number;
    moved: boolean;
  } | null>(null);
  const draggedRef = useRef(false);
  const headRef = useRef<BuddyHead | null>(null);
  const stored = dragPosition ?? layout;
  const right = clampOffset(stored.right, viewportWidth);
  const bottom = clampOffset(stored.bottom, viewportHeight);
  const onCall = state.status === "connecting" || state.status === "live";
  const callBlocked = !onCall && readiness !== "ready";
  const via = useEnvironmentPresentation(onCall ? state.environmentId : null).presentation?.entry
    .target.label;
  const feed = state.feed.slice(-FEED_SHOWN);

  // The card opens toward the roomier half and never past an edge, wherever T3Bud sits.
  const buddyTop = viewportHeight - bottom - BUDDY_BUTTON_SIZE;
  const buddyLeft = viewportWidth - right - BUDDY_BUTTON_SIZE;
  const cardBelow = buddyTop + BUDDY_BUTTON_SIZE / 2 < viewportHeight / 2;
  const cardLeft = Math.max(
    0,
    Math.min(buddyLeft + BUDDY_BUTTON_SIZE - CARD_WIDTH, viewportWidth - CARD_WIDTH),
  );
  const cardRoom = cardBelow
    ? viewportHeight - buddyTop - BUDDY_BUTTON_SIZE - CARD_GAP - CARD_EDGE
    : buddyTop - CARD_GAP - CARD_EDGE;

  const dragTo = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = dragRef.current;
    if (start === null || start.pointerId !== event.pointerId) return null;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < DRAG_SLOP) return null;
    start.moved = true;
    return {
      right: Math.round(clampOffset(start.right - dx, window.innerWidth)),
      bottom: Math.round(clampOffset(start.bottom - dy, window.innerHeight)),
    };
  };

  return (
    <div className="pointer-events-none fixed z-40 size-16" style={{ right, bottom }}>
      {layout.open ? (
        <section
          aria-label="T3Bud"
          className="pointer-events-auto absolute flex w-72 flex-col gap-2 overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg [-webkit-app-region:no-drag]"
          style={{
            left: cardLeft - buddyLeft,
            ...(cardBelow
              ? { top: BUDDY_BUTTON_SIZE + CARD_GAP }
              : { bottom: BUDDY_BUTTON_SIZE + CARD_GAP }),
            maxHeight: Math.max(0, Math.min(CARD_MAX_HEIGHT, cardRoom)),
          }}
        >
          <header className="flex items-center gap-2">
            <h2 className="text-sm font-medium">T3Bud</h2>
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {statusLine(state)}
              {via ? ` · via ${via}` : null}
            </p>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className="ms-auto"
              aria-label="Hide T3Bud's card"
              onClick={() => setLayout((current) => ({ ...current, open: false }))}
            >
              <ChevronDownIcon />
            </Button>
          </header>

          {state.status === "error" && state.error !== null ? (
            <div className="flex flex-col items-start gap-1 text-xs">
              <p role="alert" className="text-sm text-destructive-foreground">
                {state.error}
              </p>
              <InlineButton tone="muted" onClick={() => void navigate({ to: "/settings/voice" })}>
                Voice settings
              </InlineButton>
            </div>
          ) : callBlocked ? (
            <div className="flex flex-col items-start gap-1 text-xs">
              <p className="text-muted-foreground">{CALL_BLOCKED_REASON[readiness]}</p>
              {readiness === "noKey" ? (
                <InlineButton tone="muted" onClick={() => void navigate({ to: "/settings/voice" })}>
                  Voice settings
                </InlineButton>
              ) : null}
            </div>
          ) : null}

          {state.agentLine !== null || state.userLine !== null ? (
            <div className="flex flex-col gap-1">
              {state.agentLine !== null ? (
                <p
                  className={cn(
                    "text-sm leading-snug",
                    !state.agentLine.final && "text-muted-foreground",
                  )}
                >
                  {state.agentLine.text}
                </p>
              ) : null}
              {state.userLine !== null ? (
                <p className="text-xs text-muted-foreground">You: {state.userLine}</p>
              ) : null}
            </div>
          ) : null}

          {feed.length > 0 ? (
            <ul className="flex flex-col gap-1 border-t pt-2">
              {feed.map((entry) => (
                <li key={entry.id} className="flex items-start gap-1.5 text-xs">
                  <FeedIcon tone={entry.tone} />
                  <span className="min-w-0">
                    <span className="font-medium">{entry.title}</span>
                    <span className="text-muted-foreground"> · {entry.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : state.status === "idle" && !callBlocked ? (
            <p className="text-xs text-muted-foreground">
              Call to hear what your threads need and tell them what to do next.
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            {onCall ? (
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={(event) => {
                  // The second click of a double-click on Call lands here once the button swaps.
                  if (event.detail > 1) return;
                  void session.end();
                }}
              >
                <PhoneOffIcon />
                End call
              </Button>
            ) : (
              <Button size="xs" disabled={callBlocked} onClick={() => void session.start()}>
                <PhoneIcon />
                Call T3Bud
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="outline"
              disabled={state.status !== "live"}
              aria-pressed={state.muted}
              aria-label={state.muted ? "Unmute microphone" : "Mute microphone"}
              onClick={() => session.toggleMute()}
            >
              {state.muted ? <MicOffIcon /> : <MicIcon />}
            </Button>
            {callShortcut ? <Kbd className="ms-auto">{callShortcut}</Kbd> : null}
          </div>
        </section>
      ) : null}

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={layout.open ? "Pet T3Bud" : "Show T3Bud's card"}
              className={cn(
                "pointer-events-auto relative flex size-16 touch-none items-center justify-center rounded-full border-2 bg-t3bud shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [-webkit-app-region:no-drag]",
                RING_CLASS[state.status],
              )}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragRef.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  right,
                  bottom,
                  moved: false,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const next = dragTo(event);
                if (next !== null) setDragPosition(next);
              }}
              onPointerUp={(event) => {
                const next = dragTo(event);
                const moved = dragRef.current?.moved ?? false;
                dragRef.current = null;
                draggedRef.current = moved;
                if (!moved) return;
                const final = next ?? dragPosition;
                setDragPosition(null);
                if (final !== null) setLayout((current) => ({ ...current, ...final }));
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setDragPosition(null);
              }}
              onClick={() => {
                if (draggedRef.current) {
                  draggedRef.current = false;
                  return;
                }
                headRef.current?.pet();
                if (!layout.open) setLayout((current) => ({ ...current, open: true }));
              }}
            />
          }
        >
          <BuddyAvatar
            key={animal}
            animal={animal}
            session={session}
            mood={buddyMood(state)}
            headRef={headRef}
          />
          {state.waiting > 0 ? (
            <Badge size="sm" className="absolute -top-1 -left-1">
              {state.waiting}
            </Badge>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">
          {onCall ? statusLine(state) : "T3Bud. Drag to move."}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function BuddyAvatar({
  animal,
  session,
  mood,
  headRef,
}: {
  animal: T3BudAnimal;
  session: VoiceSession;
  mood: BuddyMood;
  headRef: { current: BuddyHead | null };
}) {
  const [flat, setFlat] = useState(false);
  const moodRef = useRef(mood);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the call's mood into the imperative three.js head
  useEffect(() => {
    moodRef.current = mood;
    headRef.current?.setMood(mood);
  }, [mood, headRef]);

  // The head lives as long as its canvas; three.js loads with the first one.
  const mountHead = (canvas: HTMLCanvasElement | null) => {
    if (canvas === null) return;
    let head: BuddyHead | null = null;
    let unmounted = false;
    void loadBuddyHead().then(
      ({ createBuddyHead }) => {
        if (unmounted) return;
        head = createBuddyHead({
          canvas,
          modelUrl: t3BudAssetUrl(animal, "glb"),
          levels: { output: () => session.outputLevel(), input: () => session.inputLevel() },
          onUnavailable: () => setFlat(true),
        });
        if (head === null) {
          setFlat(true);
          return;
        }
        head.resize(BUDDY_SIZE, window.devicePixelRatio || 1);
        head.setMood(moodRef.current);
        headRef.current = head;
      },
      () => setFlat(true),
    );
    return () => {
      unmounted = true;
      if (headRef.current === head) headRef.current = null;
      head?.dispose();
    };
  };

  return flat ? (
    <img
      src={t3BudAssetUrl(animal, "png")}
      alt=""
      draggable={false}
      className="size-14 rounded-full"
      width={BUDDY_SIZE}
      height={BUDDY_SIZE}
    />
  ) : (
    <canvas ref={mountHead} aria-hidden className="size-14" />
  );
}

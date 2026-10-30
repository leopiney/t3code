import { VOICE_AGENT_TOOL_NAMES, type RuntimeRequestId } from "@t3tools/contracts";

import type { VoiceEventKind } from "./types.ts";

/*
 * What the voice agent says aloud about threads, and when. An event reaches the agent twice:
 * at once as quiet context, and later as an "[agent event]" user message it answers aloud.
 * A user message starts a new turn and cuts off whatever the agent is saying, so this queue
 * speaks only once the agent's turn is over and the conversation has been quiet for a moment.
 */

/** After the agent goes quiet, the user gets this long to answer before the app says anything. */
export const AFTER_AGENT_MS = 2500;
/** A pause this long in the conversation on a topic is when the rest are offered. */
export const OFFER_AFTER_MS = 5000;
/** A topic nobody has talked about for this long is over: the next one is announced, not offered. */
const TOPIC_IDLE_MS = 20_000;
/** An offer nobody took up lapses after this much silence. */
export const OFFER_HOLD_MS = 120_000;
/** A reply the agent owes but never gives stops holding the queue after this long. */
export const REPLY_WAIT_MS = 15_000;

export interface Announcement {
  /** The "[agent event]" message the agent answers aloud. */
  readonly text: string;
  /** A few words for the waiting list ("t3 Cart refactor finished"). */
  readonly label: string;
  /** A newer one of the same kind replaces a waiting one. */
  readonly kind: string;
  /** What happened, so a changed speak mode can drop what it no longer speaks. */
  readonly event: VoiceEventKind;
  /** The approval or question it tells of. Telling it is how the user hears of the request. */
  readonly requestId: RuntimeRequestId | null;
  readonly at: number;
}

/** An announcement as the agent gets it. */
export interface ToldAnnouncement {
  readonly text: string;
  readonly requestId: RuntimeRequestId | null;
}

/** What the call should send now, if anything. */
export type AnnouncementTurn =
  | ({ readonly type: "announce" } & ToldAnnouncement)
  | { readonly type: "offer"; readonly text: string };

const NEXT_UPDATE = VOICE_AGENT_TOOL_NAMES.nextUpdate;

export class AnnouncementQueue {
  private items: Announcement[] = [];
  private isSpeaking = false;
  /** The last sign of the agent's turn: its audio starting or stopping, a draft, a line. */
  private agentAt = 0;
  private userAt = 0;
  /** Set while the agent owes a reply. */
  private owedSince: number | null = null;
  /** The announcement being talked about. */
  private topic: Announcement | null = null;
  /** When the rest were offered for the current topic. */
  private offeredAt: number | null = null;

  get size(): number {
    return this.items.length;
  }

  /** A newer one of the same kind replaces a waiting one and goes to the back. */
  push(item: Omit<Announcement, "at">, now: number): void {
    this.items = this.items.filter((waiting) => waiting.kind !== item.kind);
    this.items.push({ ...item, at: now });
  }

  /** Drops waiting items that no longer hold, such as a request answered elsewhere. Says whether any went. */
  retain(keep: (item: Announcement) => boolean): boolean {
    const before = this.items.length;
    this.items = this.items.filter(keep);
    // An offer of items that are gone must not hold back the next one.
    if (this.items.length === 0) this.offeredAt = null;
    return this.items.length !== before;
  }

  agentSpeaking(isSpeaking: boolean, now: number): void {
    this.isSpeaking = isSpeaking;
    this.agentAt = now;
  }

  agentDrafting(now: number): void {
    this.agentAt = now;
  }

  /** The agent finished a line: what it owed is given. */
  agentReplied(now: number): void {
    this.owedSince = null;
    this.agentAt = now;
  }

  /** The agent has a reply to give: the user spoke, a tool ran, or the app sent it a message. */
  replyOwed(now: number): void {
    this.owedSince = now;
  }

  /** The user's voice, heard or transcribed. */
  userSpoke(now: number): void {
    this.userAt = now;
  }

  /** Whether the agent's turn is over, so a user message would cut nothing off. */
  isFloorFree(now: number): boolean {
    if (this.isSpeaking) return false;
    if (this.owedSince !== null && now - this.owedSince < REPLY_WAIT_MS) return false;
    return now - this.agentAt >= AFTER_AGENT_MS;
  }

  /**
   * The oldest event when no topic is going, or the offer of the rest once the talk on the
   * current one pauses. Either means a reply is owed.
   */
  take(now: number, isUserSpeaking: boolean): AnnouncementTurn | null {
    if (this.items.length === 0 || isUserSpeaking || !this.isFloorFree(now)) return null;
    const quiet = now - Math.max(this.agentAt, this.userAt);
    if (this.offeredAt !== null) {
      if (quiet < OFFER_HOLD_MS) return null;
      this.offeredAt = null;
      this.topic = null;
    }
    if (this.topic !== null && quiet < TOPIC_IDLE_MS) {
      if (quiet < OFFER_AFTER_MS) return null;
      this.offeredAt = now;
      this.replyOwed(now);
      return { type: "offer", text: this.offer(this.topic) };
    }
    const next = this.next(now);
    if (next === null) return null;
    this.replyOwed(now);
    return { type: "announce", ...next };
  }

  /** The oldest waiting event, now the topic, with its age and what is still waiting. */
  next(now: number): ToldAnnouncement | null {
    const item = this.items.shift();
    if (item === undefined) return null;
    this.topic = item;
    this.offeredAt = null;
    const minutes = Math.floor((now - item.at) / 60_000);
    const age =
      minutes >= 1
        ? ` (This happened ${minutes === 1 ? "a minute" : `${minutes} minutes`} ago.)`
        : "";
    const rest = this.items.length;
    const after =
      rest === 0
        ? ""
        : ` ${count(rest)} waiting after this one. Don't bring ${them(rest)} up yet: the app will tell you when to offer ${them(rest)}.`;
    return { text: `${item.text}${age}${after}`, requestId: item.requestId };
  }

  /** What is waiting, as quiet context the agent keeps current under one id. */
  pendingNote(): string {
    if (this.items.length === 0) return "[agent activity] No updates are waiting to be told.";
    return (
      `[agent activity] ${count(this.items.length)} waiting to be told: ${this.labels()}. ` +
      `Don't read them out on your own. When the user wants the next one, call ${NEXT_UPDATE}.`
    );
  }

  clear(): void {
    this.items = [];
    this.isSpeaking = false;
    this.agentAt = 0;
    this.userAt = 0;
    this.owedSince = null;
    this.topic = null;
    this.offeredAt = null;
  }

  private labels(): string {
    return this.items.map((item) => item.label).join("; ");
  }

  private offer(topic: Announcement): string {
    const rest = this.items.length;
    return (
      `[pending updates] ${count(rest)} waiting: ${this.labels()}. ` +
      `Ask the user in one short sentence whether to go through ${them(rest)} now or stay on ${topic.label} first. ` +
      `Don't read ${them(rest)} out yet. If they want ${them(rest)}, call ${NEXT_UPDATE}.`
    );
  }
}

function count(n: number): string {
  return n === 1 ? "One more update is" : `${n} more updates are`;
}

function them(n: number): string {
  return n === 1 ? "it" : "them";
}

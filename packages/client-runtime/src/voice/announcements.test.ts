import { describe, expect, it } from "vite-plus/test";

import {
  AFTER_AGENT_MS,
  AnnouncementQueue,
  OFFER_AFTER_MS,
  OFFER_HOLD_MS,
  REPLY_WAIT_MS,
} from "./announcements.ts";

const event = (kind: string, text = `[agent event] ${kind}`) => ({
  kind,
  text,
  label: kind,
  event: "finished" as const,
  requestId: null,
});

describe("AnnouncementQueue", () => {
  it("speaks only once the agent's turn is over and the user is quiet", () => {
    const queue = new AnnouncementQueue();
    queue.push(event("a"), 0);
    queue.agentSpeaking(true, 0);
    expect(queue.take(10_000, false)).toBeNull();

    queue.agentSpeaking(false, 10_000);
    expect(queue.take(10_000 + AFTER_AGENT_MS - 1, false)).toBeNull();
    expect(queue.take(10_000 + AFTER_AGENT_MS, true)).toBeNull();

    queue.replyOwed(10_000);
    expect(queue.take(10_000 + AFTER_AGENT_MS, false)).toBeNull();
    expect(queue.take(10_000 + REPLY_WAIT_MS, false)).toEqual({
      type: "announce",
      text: "[agent event] a",
      requestId: null,
    });
  });

  it("names how many wait, offers them after a pause, then hands them out one by one", () => {
    const queue = new AnnouncementQueue();
    queue.push(event("a"), 0);
    queue.push(event("b"), 0);
    queue.push(event("c"), 0);

    expect(queue.take(AFTER_AGENT_MS, false)?.text).toBe(
      "[agent event] a 2 more updates are waiting after this one. Don't bring them up yet: the app will tell you when to offer them.",
    );
    queue.agentReplied(AFTER_AGENT_MS + 1000);
    const replied = AFTER_AGENT_MS + 1000;
    expect(queue.take(replied + OFFER_AFTER_MS - 1, false)).toBeNull();

    const offer = queue.take(replied + OFFER_AFTER_MS, false);
    expect(offer?.type).toBe("offer");
    expect(offer?.text).toMatch(/^\[pending updates\] 2 more updates are waiting: b; c\./);
    // An offer stands until the agent pulls the next one or the silence runs long.
    queue.agentReplied(replied + OFFER_AFTER_MS + 1000);
    expect(queue.take(replied + OFFER_AFTER_MS + 60_000, false)).toBeNull();

    expect(queue.next(replied + 2 * 60_000)?.text).toBe(
      "[agent event] b (This happened 2 minutes ago.) One more update is waiting after this one. Don't bring it up yet: the app will tell you when to offer it.",
    );
    expect(queue.size).toBe(1);
  });

  it("lets a lapsed offer go and announces the next one plainly", () => {
    const queue = new AnnouncementQueue();
    queue.push(event("a"), 0);
    queue.push(event("b"), 0);
    expect(queue.take(AFTER_AGENT_MS, false)?.type).toBe("announce");
    queue.agentReplied(AFTER_AGENT_MS);
    expect(queue.take(AFTER_AGENT_MS + OFFER_AFTER_MS, false)?.type).toBe("offer");
    queue.agentReplied(AFTER_AGENT_MS + OFFER_AFTER_MS);

    expect(queue.take(AFTER_AGENT_MS + OFFER_AFTER_MS + OFFER_HOLD_MS, false)?.type).toBe(
      "announce",
    );
  });

  it("replaces a waiting update with a newer one of the same kind, at the back", () => {
    const queue = new AnnouncementQueue();
    queue.push(event("thread-1", "first"), 0);
    queue.push(event("thread-2", "second"), 0);
    queue.push(event("thread-1", "newer"), 0);

    expect(queue.size).toBe(2);
    expect(queue.pendingNote()).toBe(
      "[agent activity] 2 more updates are waiting to be told: thread-2; thread-1. Don't read them out on your own. When the user wants the next one, call t3_next_update.",
    );
    expect(queue.next(0)?.text).toMatch(/^second /);
    expect(queue.next(0)?.text).toBe("newer");
  });
});

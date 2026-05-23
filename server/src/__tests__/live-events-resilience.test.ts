import { describe, expect, it } from "vitest";
import {
  publishGlobalLiveEvent,
  publishLiveEvent,
  subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents,
} from "../services/live-events.ts";

// PLA-12 generalises PLA-9: post-commit observability primitives must never
// throw past the success boundary of a mutating request. publishLiveEvent is
// a synchronous Node EventEmitter, so a listener that throws (e.g. a buggy
// WebSocket subscriber, JSON.stringify on a circular payload) would surface
// as a 5xx for a request whose work already committed and trigger duplicate
// retries. The publisher must absorb listener failures.

describe("publishLiveEvent post-commit resilience (PLA-12)", () => {
  it("does not throw when a company listener throws synchronously", () => {
    const companyId = "company-throws";
    const unsubscribe = subscribeCompanyLiveEvents(companyId, () => {
      throw new Error("buggy subscriber");
    });

    try {
      expect(() =>
        publishLiveEvent({
          companyId,
          type: "activity.logged",
          payload: { action: "test.regression.pla12" },
        }),
      ).not.toThrow();
    } finally {
      unsubscribe();
    }
  });

  it("does not throw when a global listener throws synchronously", () => {
    const unsubscribe = subscribeGlobalLiveEvents(() => {
      throw new Error("buggy global subscriber");
    });

    try {
      expect(() =>
        publishGlobalLiveEvent({
          type: "heartbeat.run.status",
          payload: { stage: "test.regression.pla12" },
        }),
      ).not.toThrow();
    } finally {
      unsubscribe();
    }
  });

});

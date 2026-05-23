import { describe, expect, it } from "vitest";
import { TelemetryClient } from "./client.js";
import type { TelemetryConfig } from "./types.js";

// PLA-12: TelemetryClient.track is called by routes AFTER the irreversible
// side effect commits (e.g. agent created, issue inserted). If track() throws
// — most plausibly because the install-id state file cannot be read/written
// on first use, but also from any future regression in the queueing logic —
// the route would surface a 500 to a client whose request already succeeded
// and trigger a duplicate-create retry loop (see PLA-9 root cause analysis).
//
// track() is best-effort observability and must absorb its own failures.

describe("TelemetryClient.track post-commit resilience (PLA-12)", () => {
  it("does not throw when the state factory throws on first call", () => {
    const config: TelemetryConfig = { enabled: true };
    const client = new TelemetryClient(
      config,
      () => {
        throw new Error("install-id state file unreadable");
      },
      "1.2.3",
    );

    expect(() => client.track("agent.created", { agent_role: "engineer" })).not.toThrow();
  });

  it("is a no-op when telemetry is disabled (no state factory call)", () => {
    let stateFactoryCalls = 0;
    const config: TelemetryConfig = { enabled: false };
    const client = new TelemetryClient(
      config,
      () => {
        stateFactoryCalls += 1;
        throw new Error("should never be called when disabled");
      },
      "1.2.3",
    );

    expect(() => client.track("agent.created", { agent_role: "engineer" })).not.toThrow();
    expect(stateFactoryCalls).toBe(0);
  });
});

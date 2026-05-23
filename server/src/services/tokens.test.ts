import { describe, expect, it } from "vitest";
import { rollupRuns, type TokenRunRow } from "./tokens.js";

function makeRun(overrides: Partial<TokenRunRow>): TokenRunRow {
  return {
    runId: "run-id",
    agentId: "agent-1",
    agentName: "Engineer",
    agentRole: "engineer",
    issueId: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    startedAt: "2026-05-23T00:00:00.000Z",
    endedAt: "2026-05-23T00:01:00.000Z",
    ...overrides,
  };
}

describe("rollupRuns", () => {
  it("sums per-run totals correctly across multi-run windows", () => {
    const runs: TokenRunRow[] = [
      makeRun({ runId: "r1", inputTokens: 100, outputTokens: 50, cachedInputTokens: 1000, cacheCreationTokens: 200 }),
      makeRun({ runId: "r2", inputTokens: 300, outputTokens: 80, cachedInputTokens: 5000, cacheCreationTokens: 500 }),
      makeRun({ runId: "r3", inputTokens: 250, outputTokens: 60, cachedInputTokens: 0, cacheCreationTokens: 0 }),
    ];

    const { totals } = rollupRuns(runs);
    expect(totals).toEqual({
      inputTokens: 650,
      outputTokens: 190,
      cachedInputTokens: 6000,
      cacheCreationTokens: 700,
      heartbeatCount: 3,
    });
  });

  it("keeps cache hit tokens and cache write tokens in separate fields", () => {
    const runs: TokenRunRow[] = [
      makeRun({ runId: "r1", inputTokens: 10, cachedInputTokens: 9000, cacheCreationTokens: 1500 }),
      makeRun({ runId: "r2", inputTokens: 20, cachedInputTokens: 4000, cacheCreationTokens: 800 }),
    ];

    const { totals, byAgent, byRole } = rollupRuns(runs);
    expect(totals.cachedInputTokens).toBe(13_000);
    expect(totals.cacheCreationTokens).toBe(2_300);
    expect(totals.inputTokens).toBe(30);
    // Collapsing would produce 15300 — we explicitly do not do that.
    expect(totals.inputTokens).not.toBe(totals.cachedInputTokens);

    expect(byAgent[0]?.cachedInputTokens).toBe(13_000);
    expect(byAgent[0]?.cacheCreationTokens).toBe(2_300);
    expect(byRole[0]?.cachedInputTokens).toBe(13_000);
    expect(byRole[0]?.cacheCreationTokens).toBe(2_300);
  });

  it("matches hand-computed per-agent and per-role rollup math", () => {
    const runs: TokenRunRow[] = [
      makeRun({ runId: "a1", agentId: "a", agentName: "A", agentRole: "engineer", inputTokens: 100, outputTokens: 10, cachedInputTokens: 500, cacheCreationTokens: 50 }),
      makeRun({ runId: "a2", agentId: "a", agentName: "A", agentRole: "engineer", inputTokens: 200, outputTokens: 20, cachedInputTokens: 1000, cacheCreationTokens: 100 }),
      makeRun({ runId: "b1", agentId: "b", agentName: "B", agentRole: "qa", inputTokens: 50, outputTokens: 5, cachedInputTokens: 250, cacheCreationTokens: 25 }),
    ];

    const { byAgent, byRole } = rollupRuns(runs);

    // Per-agent: agent "a" sorted first by inputTokens
    expect(byAgent.map((a) => a.agentId)).toEqual(["a", "b"]);
    const agentA = byAgent[0]!;
    expect(agentA).toMatchObject({
      agentId: "a",
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 1500,
      cacheCreationTokens: 150,
      heartbeatCount: 2,
    });
    // mean of [100, 200] = 150
    expect(agentA.meanInputPerHeartbeat).toBe(150);
    // p50 nearest-rank of [100, 200] = ceil(0.5*2)=1 → idx 0 → 100
    expect(agentA.p50InputPerHeartbeat).toBe(100);
    // p95 = ceil(0.95*2)=2 → idx 1 → 200
    expect(agentA.p95InputPerHeartbeat).toBe(200);

    const agentB = byAgent[1]!;
    expect(agentB.meanInputPerHeartbeat).toBe(50);
    expect(agentB.p50InputPerHeartbeat).toBe(50);
    expect(agentB.p95InputPerHeartbeat).toBe(50);

    // Per-role rollups
    const engineerRole = byRole.find((r) => r.agentRole === "engineer");
    const qaRole = byRole.find((r) => r.agentRole === "qa");
    expect(engineerRole).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 1500,
      cacheCreationTokens: 150,
      heartbeatCount: 2,
    });
    expect(qaRole).toMatchObject({
      inputTokens: 50,
      outputTokens: 5,
      cachedInputTokens: 250,
      cacheCreationTokens: 25,
      heartbeatCount: 1,
    });
  });

  it("returns empty totals on an empty input", () => {
    const { totals, byAgent, byRole } = rollupRuns([]);
    expect(totals.heartbeatCount).toBe(0);
    expect(totals.inputTokens).toBe(0);
    expect(byAgent).toHaveLength(0);
    expect(byRole).toHaveLength(0);
  });
});

import { Command } from "commander";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface TokenSnapshotOptions extends BaseClientOptions {
  companyId?: string;
  from?: string;
  to?: string;
  days?: string;
  agentId?: string;
  weekOverWeek?: boolean;
  format?: "json" | "csv" | "summary";
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  heartbeatCount: number;
}

interface TokenRun {
  runId: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  issueId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  startedAt: string | null;
  endedAt: string | null;
}

interface AgentRollup extends TokenTotals {
  agentId: string;
  agentName: string;
  agentRole: string;
  meanInputPerHeartbeat: number;
  p50InputPerHeartbeat: number;
  p95InputPerHeartbeat: number;
}

interface RoleRollup extends TokenTotals {
  agentRole: string;
}

interface TokenSnapshot {
  window: { from: string; to: string };
  previousWindow: { from: string; to: string } | null;
  totals: TokenTotals;
  previousTotals: TokenTotals | null;
  byAgent: AgentRollup[];
  byRole: RoleRollup[];
  previousByAgent: Record<string, TokenTotals>;
  previousByRole: Record<string, TokenTotals>;
  runs: TokenRun[];
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDelta(curr: number, prev: number | undefined): string {
  if (prev === undefined || prev === 0) return prev === 0 && curr === 0 ? "" : ` (Δ +${formatNumber(curr)})`;
  const diff = curr - prev;
  const pct = (diff / prev) * 100;
  const sign = diff >= 0 ? "+" : "";
  return ` (Δ ${sign}${formatNumber(diff)}, ${sign}${pct.toFixed(1)}%)`;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function emitCsv(snapshot: TokenSnapshot): void {
  const header = [
    "runId",
    "agentId",
    "agentName",
    "agentRole",
    "issueId",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
    "startedAt",
    "endedAt",
  ];
  console.log(header.join(","));
  for (const r of snapshot.runs) {
    console.log([
      r.runId,
      r.agentId,
      r.agentName,
      r.agentRole,
      r.issueId ?? "",
      String(r.inputTokens),
      String(r.outputTokens),
      String(r.cachedInputTokens),
      String(r.cacheCreationTokens),
      r.startedAt ?? "",
      r.endedAt ?? "",
    ].map(csvEscape).join(","));
  }
}

function emitSummary(snapshot: TokenSnapshot): void {
  const { window, totals, byAgent, byRole, previousTotals, previousByAgent, previousByRole } = snapshot;
  console.log(`Token snapshot ${window.from} → ${window.to}`);
  console.log("");
  console.log(`Heartbeats: ${formatNumber(totals.heartbeatCount)}${formatDelta(totals.heartbeatCount, previousTotals?.heartbeatCount)}`);
  console.log(`Input tokens (billed): ${formatNumber(totals.inputTokens)}${formatDelta(totals.inputTokens, previousTotals?.inputTokens)}`);
  console.log(`Cached input tokens (cache reads): ${formatNumber(totals.cachedInputTokens)}${formatDelta(totals.cachedInputTokens, previousTotals?.cachedInputTokens)}`);
  console.log(`Cache creation tokens (cache writes): ${formatNumber(totals.cacheCreationTokens)}${formatDelta(totals.cacheCreationTokens, previousTotals?.cacheCreationTokens)}`);
  console.log(`Output tokens: ${formatNumber(totals.outputTokens)}${formatDelta(totals.outputTokens, previousTotals?.outputTokens)}`);
  console.log("");

  console.log("Per agent:");
  for (const a of byAgent) {
    const prev = previousByAgent[a.agentId];
    console.log(`  ${a.agentName || a.agentId} [${a.agentRole}]`);
    console.log(`    heartbeats: ${formatNumber(a.heartbeatCount)}${formatDelta(a.heartbeatCount, prev?.heartbeatCount)}`);
    console.log(`    input: ${formatNumber(a.inputTokens)}${formatDelta(a.inputTokens, prev?.inputTokens)}`);
    console.log(`    cached: ${formatNumber(a.cachedInputTokens)}${formatDelta(a.cachedInputTokens, prev?.cachedInputTokens)}`);
    console.log(`    cache_creation: ${formatNumber(a.cacheCreationTokens)}${formatDelta(a.cacheCreationTokens, prev?.cacheCreationTokens)}`);
    console.log(`    output: ${formatNumber(a.outputTokens)}${formatDelta(a.outputTokens, prev?.outputTokens)}`);
    console.log(`    input/hb mean=${formatNumber(Math.round(a.meanInputPerHeartbeat))} p50=${formatNumber(Math.round(a.p50InputPerHeartbeat))} p95=${formatNumber(Math.round(a.p95InputPerHeartbeat))}`);
  }
  console.log("");

  console.log("Per role:");
  for (const r of byRole) {
    const prev = previousByRole[r.agentRole];
    console.log(`  ${r.agentRole}: heartbeats=${formatNumber(r.heartbeatCount)} input=${formatNumber(r.inputTokens)}${formatDelta(r.inputTokens, prev?.inputTokens)} cached=${formatNumber(r.cachedInputTokens)} cache_creation=${formatNumber(r.cacheCreationTokens)} output=${formatNumber(r.outputTokens)}`);
  }
}

export function registerTokenCommands(program: Command): void {
  const tokens = program.command("tokens").description("Per-heartbeat token telemetry");

  addCommonClientOptions(
    tokens
      .command("snapshot")
      .description("Per-agent / per-role token rollup for a time window")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--from <iso>", "Window start (ISO timestamp). Defaults to 7d ago.")
      .option("--to <iso>", "Window end (ISO timestamp). Defaults to now.")
      .option("--days <n>", "Convenience: window = last N days ending at --to (or now)")
      .option("--agent-id <id>", "Filter to a single agent")
      .option("--week-over-week", "Include previous-window totals for delta math", false)
      .option("--format <mode>", "Output format: summary | json | csv", "summary"),
  ).action(async (opts: TokenSnapshotOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        const params = new URLSearchParams();
        const now = new Date();
        let to = opts.to ? new Date(opts.to) : now;
        let from: Date;
        if (opts.from) {
          from = new Date(opts.from);
        } else if (opts.days) {
          const days = Number.parseInt(opts.days, 10);
          if (!Number.isFinite(days) || days <= 0) {
            throw new Error("--days must be a positive integer");
          }
          from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
        } else {
          from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
        }
        params.set("from", from.toISOString());
        params.set("to", to.toISOString());
        if (opts.weekOverWeek) params.set("weekOverWeek", "true");
        if (opts.agentId) params.set("agentId", opts.agentId);

        const path = `/api/companies/${ctx.companyId}/tokens/snapshot?${params.toString()}`;
        const snapshot = await ctx.api.get<TokenSnapshot>(path);
        if (!snapshot) {
          console.error("No snapshot returned");
          process.exitCode = 1;
          return;
        }

        const format = opts.format ?? (ctx.json ? "json" : "summary");
        if (format === "json" || ctx.json) {
          printOutput(snapshot, { json: true });
          return;
        }
        if (format === "csv") {
          emitCsv(snapshot);
          return;
        }
        emitSummary(snapshot);
      } catch (err) {
        handleCommandError(err);
      }
    });
}

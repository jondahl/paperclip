import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

/**
 * Per-run token telemetry row (Tier 1).
 *
 * Cache fields are surfaced separately from billed input so consumers can see
 * cache hit/write volume without it being collapsed into `inputTokens`.
 */
export interface TokenRunRow {
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

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  heartbeatCount: number;
}

export interface TokenAgentRollup extends TokenTotals {
  agentId: string;
  agentName: string;
  agentRole: string;
  meanInputPerHeartbeat: number;
  p50InputPerHeartbeat: number;
  p95InputPerHeartbeat: number;
}

export interface TokenRoleRollup extends TokenTotals {
  agentRole: string;
}

export interface TokenSnapshotWindow {
  from: string;
  to: string;
}

export interface TokenSnapshot {
  window: TokenSnapshotWindow;
  previousWindow: TokenSnapshotWindow | null;
  totals: TokenTotals;
  previousTotals: TokenTotals | null;
  byAgent: TokenAgentRollup[];
  byRole: TokenRoleRollup[];
  previousByAgent: Record<string, TokenTotals>;
  previousByRole: Record<string, TokenTotals>;
  runs: TokenRunRow[];
}

export function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    heartbeatCount: 0,
  };
}

function addToTotals(target: TokenTotals, row: TokenRunRow): void {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cachedInputTokens += row.cachedInputTokens;
  target.cacheCreationTokens += row.cacheCreationTokens;
  target.heartbeatCount += 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const clamped = Math.max(0, Math.min(100, p));
  // Nearest-rank, which is fine for small N and avoids interpolation surprises.
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx] ?? 0;
}

/**
 * Pure rollup math: given a flat list of per-run rows, compute Tier 2
 * aggregations. Exposed for unit testing without touching the DB.
 */
export function rollupRuns(runs: TokenRunRow[]): {
  totals: TokenTotals;
  byAgent: TokenAgentRollup[];
  byRole: TokenRoleRollup[];
} {
  const totals = emptyTotals();
  const perAgent = new Map<string, { meta: { agentId: string; agentName: string; agentRole: string }; totals: TokenTotals; inputs: number[] }>();
  const perRole = new Map<string, TokenTotals>();

  for (const row of runs) {
    addToTotals(totals, row);

    const agentEntry = perAgent.get(row.agentId) ?? {
      meta: { agentId: row.agentId, agentName: row.agentName, agentRole: row.agentRole },
      totals: emptyTotals(),
      inputs: [] as number[],
    };
    addToTotals(agentEntry.totals, row);
    agentEntry.inputs.push(row.inputTokens);
    perAgent.set(row.agentId, agentEntry);

    const roleKey = row.agentRole || "unknown";
    const roleTotals = perRole.get(roleKey) ?? emptyTotals();
    addToTotals(roleTotals, row);
    perRole.set(roleKey, roleTotals);
  }

  const byAgent: TokenAgentRollup[] = Array.from(perAgent.values()).map((entry) => {
    const sorted = [...entry.inputs].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, n) => acc + n, 0);
    const mean = sorted.length > 0 ? sum / sorted.length : 0;
    return {
      ...entry.meta,
      ...entry.totals,
      meanInputPerHeartbeat: mean,
      p50InputPerHeartbeat: percentile(sorted, 50),
      p95InputPerHeartbeat: percentile(sorted, 95),
    };
  });

  byAgent.sort((a, b) => b.inputTokens - a.inputTokens);

  const byRole: TokenRoleRollup[] = Array.from(perRole.entries()).map(([agentRole, t]) => ({
    agentRole,
    ...t,
  }));
  byRole.sort((a, b) => b.inputTokens - a.inputTokens);

  return { totals, byAgent, byRole };
}

function readNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

interface RawRunRow {
  runId: string;
  agentId: string;
  agentName: string | null;
  agentRole: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  usageJson: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown> | null;
}

function rowToTokenRow(row: RawRunRow): TokenRunRow {
  const usage = row.usageJson ?? {};
  const ctx = row.contextSnapshot ?? {};
  const issueIdRaw = (ctx as Record<string, unknown>).issueId ?? (ctx as Record<string, unknown>).taskId;
  const issueId = typeof issueIdRaw === "string" && issueIdRaw.length > 0 ? issueIdRaw : null;
  return {
    runId: row.runId,
    agentId: row.agentId,
    agentName: row.agentName ?? "",
    agentRole: row.agentRole ?? "unknown",
    issueId,
    inputTokens: readNumber(usage.inputTokens ?? usage.rawInputTokens),
    outputTokens: readNumber(usage.outputTokens ?? usage.rawOutputTokens),
    cachedInputTokens: readNumber(usage.cachedInputTokens ?? usage.rawCachedInputTokens),
    cacheCreationTokens: readNumber(usage.cacheCreationTokens ?? usage.rawCacheCreationTokens),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

interface FetchOptions {
  companyId: string;
  from: Date;
  to: Date;
  agentId?: string;
}

async function fetchRunsInWindow(db: Db, opts: FetchOptions): Promise<TokenRunRow[]> {
  const filters: SQL[] = [
    eq(heartbeatRuns.companyId, opts.companyId),
    gte(heartbeatRuns.startedAt, opts.from),
    lte(heartbeatRuns.startedAt, opts.to),
    sql`${heartbeatRuns.usageJson} is not null`,
  ];
  if (opts.agentId) {
    filters.push(eq(heartbeatRuns.agentId, opts.agentId));
  }

  const rows = await db
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      agentRole: agents.role,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      usageJson: heartbeatRuns.usageJson,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(and(...filters));

  return rows.map(rowToTokenRow);
}

export interface SnapshotOptions {
  companyId: string;
  from: Date;
  to: Date;
  agentId?: string;
  weekOverWeek?: boolean;
}

/**
 * Tier 2 rollup query: per-run rows plus per-agent and per-role aggregations
 * over [from, to]. Cache hits and cache-write tokens stay in separate fields
 * so downstream consumers cannot accidentally collapse them.
 */
export async function getTokenSnapshot(db: Db, opts: SnapshotOptions): Promise<TokenSnapshot> {
  const runs = await fetchRunsInWindow(db, opts);
  const { totals, byAgent, byRole } = rollupRuns(runs);

  let previousTotals: TokenTotals | null = null;
  let previousByAgent: Record<string, TokenTotals> = {};
  let previousByRole: Record<string, TokenTotals> = {};
  let previousWindow: TokenSnapshotWindow | null = null;

  if (opts.weekOverWeek) {
    const span = opts.to.getTime() - opts.from.getTime();
    if (span > 0) {
      const prevTo = new Date(opts.from.getTime());
      const prevFrom = new Date(opts.from.getTime() - span);
      const prevRuns = await fetchRunsInWindow(db, {
        companyId: opts.companyId,
        from: prevFrom,
        to: prevTo,
        agentId: opts.agentId,
      });
      const prev = rollupRuns(prevRuns);
      previousTotals = prev.totals;
      previousByAgent = Object.fromEntries(prev.byAgent.map((a) => {
        const { agentId, agentName: _n, agentRole: _r, meanInputPerHeartbeat: _m, p50InputPerHeartbeat: _p50, p95InputPerHeartbeat: _p95, ...t } = a;
        return [agentId, t];
      }));
      previousByRole = Object.fromEntries(prev.byRole.map((r) => {
        const { agentRole, ...t } = r;
        return [agentRole, t];
      }));
      previousWindow = { from: prevFrom.toISOString(), to: prevTo.toISOString() };
    }
  }

  return {
    window: { from: opts.from.toISOString(), to: opts.to.toISOString() },
    previousWindow,
    totals,
    previousTotals,
    byAgent,
    byRole,
    previousByAgent,
    previousByRole,
    runs,
  };
}

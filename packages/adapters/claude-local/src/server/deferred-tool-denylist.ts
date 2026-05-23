// Config-driven denylist for Claude Code's eager-loaded deferred-tool list.
//
// Paperclip agents inherit the user's claude.ai MCP connectors, which inflates
// every heartbeat's system prompt with hundreds of tool names the agents never
// touch (e.g. Mux Video, NetSuite). We pass these patterns to Claude Code via
// `--disallowedTools` so they no longer appear in the deferred-tool section.
//
// PLA-96 + PLA-94. Default-allow + denylist; one-PR revert if a denied tool
// turns out to be load-bearing. Per-role allowlists are a follow-up cut.
//
// Caveat on Claude Code semantics: `--disallowedTools` removes the tool
// entirely — `ToolSearch select:<name>` will not resolve a denied name back
// either. The intent of denying these namespaces is "agents are not using
// them", so trading off ToolSearch reachability is acceptable.

import { asStringArray, parseObject } from "@paperclipai/adapter-utils/server-utils";

/**
 * Default deny patterns. Each entry is a tool-name glob accepted by
 * `claude --disallowedTools`. Treat `Ramp` and `Ramp_Data` (and similar) as
 * separate entries — they share a prefix but have different roots.
 *
 * Keep this list explicit (no derived globs). When a connector should be
 * un-denied, delete its entry; when one should be denied, add it. Reviewers
 * read the list verbatim, so prefer clarity over compression.
 */
export const DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST: readonly string[] = Object.freeze([
  // PLA-96 original seven
  "mcp__claude_ai_Mux_Video__*",
  "mcp__claude_ai_NetSuite__*",
  "mcp__claude_ai_Ramp__*",
  "mcp__claude_ai_Ramp_Data__*",
  "mcp__claude_ai_Abacum__*",
  "mcp__claude_ai_Hex__*",
  "mcp__claude_ai_Pylon__*",
  "mcp__claude_ai_Notion__*",
  // PLA-94 scope extension (HoE comment on PLA-96)
  "mcp__claude_ai_Mux__*",
  "mcp__claude_ai_Mux_Data__*",
  "mcp__claude_ai_Mux_read-only__*",
  "mcp__claude_ai_Endgame__*",
  "mcp__claude_ai_Lenny_s_Data__*",
  "mcp__claude_ai_Omni__*",
  "mcp__claude_ai_Todoist__*",
  "mcp__claude_ai_Zoom_for_Claude__*",
]);

/**
 * Resolve the effective denylist for a Claude execution. Config overrides:
 *   - `deferredToolDenylist`: replace the default list entirely (use `[]` to
 *     disable the feature for an agent).
 *   - `deferredToolDenylistExtra`: append additional patterns to the default.
 *
 * Unknown/empty values fall back to the default list.
 */
export function resolveDeferredToolDenylist(config: Record<string, unknown>): string[] {
  const override = config.deferredToolDenylist;
  if (Array.isArray(override)) {
    return asStringArray(override).map((entry) => entry.trim()).filter(Boolean);
  }
  const overrideObj = parseObject(override);
  if (Object.keys(overrideObj).length > 0) {
    const fromObj = asStringArray(overrideObj.patterns);
    if (fromObj.length > 0) {
      return fromObj.map((entry) => entry.trim()).filter(Boolean);
    }
  }
  const extra = asStringArray(config.deferredToolDenylistExtra)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const base = [...DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST];
  return extra.length > 0 ? [...base, ...extra] : base;
}

/**
 * Build the `claude --disallowedTools` argv fragment. Returns `[]` when the
 * denylist is empty so callers don't append a dangling flag.
 */
export function buildDeferredToolDenylistArgs(patterns: readonly string[]): string[] {
  const cleaned = patterns.map((entry) => entry.trim()).filter(Boolean);
  if (cleaned.length === 0) return [];
  return ["--disallowedTools", cleaned.join(" ")];
}

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST,
  buildDeferredToolDenylistArgs,
  resolveDeferredToolDenylist,
} from "./deferred-tool-denylist.js";

describe("DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST", () => {
  it("covers the PLA-96 + PLA-94 namespaces", () => {
    // The list is read verbatim by reviewers — every entry must be a literal
    // glob that matches a claude.ai MCP connector prefix.
    const required = [
      // PLA-96 seven
      "mcp__claude_ai_Mux_Video__*",
      "mcp__claude_ai_NetSuite__*",
      "mcp__claude_ai_Ramp__*",
      "mcp__claude_ai_Ramp_Data__*",
      "mcp__claude_ai_Abacum__*",
      "mcp__claude_ai_Hex__*",
      "mcp__claude_ai_Pylon__*",
      "mcp__claude_ai_Notion__*",
      // PLA-94 extension
      "mcp__claude_ai_Mux__*",
      "mcp__claude_ai_Mux_Data__*",
      "mcp__claude_ai_Mux_read-only__*",
      "mcp__claude_ai_Endgame__*",
      "mcp__claude_ai_Lenny_s_Data__*",
      "mcp__claude_ai_Omni__*",
      "mcp__claude_ai_Todoist__*",
      "mcp__claude_ai_Zoom_for_Claude__*",
    ];
    for (const pattern of required) {
      expect(DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST).toContain(pattern);
    }
  });

  it("does NOT deny the explicit keep-list (Linear, Atlassian, Slack, Gmail, Google_*)", () => {
    // From TOE's comment on PLA-96 — these are plausibly used by
    // ops/coordination agents and must stay available.
    const mustNotDeny = [
      "mcp__claude_ai_Linear__*",
      "mcp__claude_ai_Atlassian__*",
      "mcp__claude_ai_Atlassian_2__*",
      "mcp__claude_ai_Slack__*",
      "mcp__claude_ai_Gmail__*",
      "mcp__claude_ai_Google_Calendar__*",
      "mcp__claude_ai_Google_Drive__*",
    ];
    for (const pattern of mustNotDeny) {
      expect(DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST).not.toContain(pattern);
    }
  });
});

describe("resolveDeferredToolDenylist", () => {
  it("returns the default list when config is empty", () => {
    const result = resolveDeferredToolDenylist({});
    expect(result).toEqual([...DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST]);
  });

  it("array override replaces the default list entirely", () => {
    const result = resolveDeferredToolDenylist({
      deferredToolDenylist: ["mcp__claude_ai_OnlyOne__*"],
    });
    expect(result).toEqual(["mcp__claude_ai_OnlyOne__*"]);
  });

  it("empty array override disables the feature", () => {
    const result = resolveDeferredToolDenylist({ deferredToolDenylist: [] });
    expect(result).toEqual([]);
  });

  it("`extra` config appends to the default list without replacing it", () => {
    const result = resolveDeferredToolDenylist({
      deferredToolDenylistExtra: ["mcp__claude_ai_Custom__*"],
    });
    expect(result).toEqual([
      ...DEFAULT_DEFERRED_TOOL_NAMESPACE_DENYLIST,
      "mcp__claude_ai_Custom__*",
    ]);
  });

  it("trims and drops blank entries", () => {
    const result = resolveDeferredToolDenylist({
      deferredToolDenylist: ["  mcp__a__*  ", "", "   ", "mcp__b__*"],
    });
    expect(result).toEqual(["mcp__a__*", "mcp__b__*"]);
  });

  it("object override with patterns array", () => {
    const result = resolveDeferredToolDenylist({
      deferredToolDenylist: { patterns: ["mcp__obj__*"] },
    });
    expect(result).toEqual(["mcp__obj__*"]);
  });
});

describe("buildDeferredToolDenylistArgs", () => {
  it("returns [] for an empty list (no dangling --disallowedTools)", () => {
    expect(buildDeferredToolDenylistArgs([])).toEqual([]);
  });

  it("emits --disallowedTools with a space-separated argument", () => {
    expect(
      buildDeferredToolDenylistArgs([
        "mcp__claude_ai_Mux_Video__*",
        "mcp__claude_ai_NetSuite__*",
      ]),
    ).toEqual([
      "--disallowedTools",
      "mcp__claude_ai_Mux_Video__* mcp__claude_ai_NetSuite__*",
    ]);
  });

  it("trims and drops blanks before emitting", () => {
    expect(
      buildDeferredToolDenylistArgs(["  mcp__a__*  ", "", "mcp__b__*"]),
    ).toEqual(["--disallowedTools", "mcp__a__* mcp__b__*"]);
  });
});

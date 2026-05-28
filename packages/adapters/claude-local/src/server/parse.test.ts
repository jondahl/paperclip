import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });

  // PLA-193: thrown-error transient classification. ConnectionRefused-style
  // failures (and the surrounding family of Node.js socket / DNS errors) used
  // to fall through to `adapter_failed` and strand the agent in `error` until
  // an operator intervened. Treat them as transient_upstream so the heartbeat
  // outer-catch routes them through scheduleBoundedRetryForRun.
  it.each([
    ["ECONNREFUSED", "fetch failed: connect ECONNREFUSED 127.0.0.1:443"],
    ["lowercase 'connection refused'", "Error: connection refused while contacting api.anthropic.com"],
    ["socket hang up", "request to https://api.anthropic.com failed: socket hang up"],
    ["ECONNRESET", "read ECONNRESET"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN api.anthropic.com"],
    ["bare 'getaddrinfo' failure", "getaddrinfo ENOTFOUND api.anthropic.com"],
    ["fetch failed", "TypeError: fetch failed"],
    ["ENETUNREACH", "connect ENETUNREACH 2606:4700::1111:443"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND api.anthropic.com"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.1:443"],
    ["ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443"],
  ])("classifies %s as transient_upstream", (_label, errorMessage) => {
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(true);
  });

  it("does not over-match on benign messages that mention 'refused' alone", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "User refused to grant tool permission",
      }),
    ).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});

describe("parseClaudeStreamJson usage extraction", () => {
  it("captures cache_read and cache_creation tokens separately from billed input", () => {
    const stream = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess_1",
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({
        type: "result",
        session_id: "sess_1",
        result: "done",
        total_cost_usd: 0.012,
        usage: {
          input_tokens: 500,
          output_tokens: 1200,
          cache_read_input_tokens: 18000,
          cache_creation_input_tokens: 3500,
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.usage).toEqual({
      inputTokens: 500,
      cachedInputTokens: 18000,
      cacheCreationTokens: 3500,
      outputTokens: 1200,
    });
  });

  it("defaults cache fields to 0 when the provider omits them", () => {
    const stream = JSON.stringify({
      type: "result",
      result: "ok",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const parsed = parseClaudeStreamJson(stream);
    expect(parsed.usage?.cacheCreationTokens).toBe(0);
    expect(parsed.usage?.cachedInputTokens).toBe(0);
  });
});

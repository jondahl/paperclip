---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm paperclipai issue get <issue-id-or-identifier>

# Create issue
pnpm paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm paperclipai issue release <issue-id>
```

## Company Commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# Apply import
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm paperclipai agent list
pnpm paperclipai agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm paperclipai approval list [--status pending]

# Get approval
pnpm paperclipai approval get <approval-id>

# Create approval
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm paperclipai dashboard get
```

## Heartbeat

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```

## Token Telemetry

Per-agent / per-role token rollup for a time window. Reads the live
`GET /api/companies/:id/tokens/snapshot` route, so the target server must be
running and reachable.

```sh
# Last 7 days, human-readable summary
pnpm paperclipai tokens snapshot --company-id <company-id> --days 7 --format summary

# Explicit window, JSON or CSV, optional single-agent filter and week-over-week deltas
pnpm paperclipai tokens snapshot --company-id <company-id> \
  --from <iso> --to <iso> [--agent-id <id>] [--week-over-week] [--format json|csv|summary]
```

Connection + auth are resolved from `--company-id`/`--api-base`/`--api-key`
flags or the `PAPERCLIP_COMPANY_ID` / `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY`
environment variables (or a stored CLI context profile).

### Supported in-repo invocation

The `paperclipai tokens snapshot` command ships in source. Two equivalent ways
to run it from a checkout (working directory = repo root):

```sh
pnpm install                 # one-time: wires up workspace runtime deps

# (a) Run directly from source via tsx — no build step needed:
pnpm paperclipai tokens snapshot --company-id <company-id> --days 7 --format summary

# (b) Run the bundled CLI exactly as published to npm:
pnpm --filter paperclipai build         # produces cli/dist/index.js
node cli/dist/index.js tokens snapshot --company-id <company-id> --days 7 --format summary
```

The bundled CLI (`cli/dist/index.js`) externalizes `zod`, `postgres`, and `ws`;
these are declared as `paperclipai` dependencies so `pnpm install` makes them
resolvable for invocation (b). A globally-installed `paperclipai` release only
carries this command once it has been published from a commit that includes it.

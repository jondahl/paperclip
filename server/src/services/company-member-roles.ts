import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { AgentRole, HumanCompanyMembershipRole } from "@paperclipai/shared";

const HUMAN_COMPANY_MEMBERSHIP_ROLES: HumanCompanyMembershipRole[] = [
  "owner",
  "admin",
  "operator",
  "viewer",
];

export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "operator"
): HumanCompanyMembershipRole {
  if (value === "member") return "operator";
  return HUMAN_COMPANY_MEMBERSHIP_ROLES.includes(value as HumanCompanyMembershipRole)
    ? (value as HumanCompanyMembershipRole)
    : fallback;
}

export function grantsForHumanRole(
  role: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  switch (role) {
    case "owner":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:pause", scope: null },
        { permissionKey: "agents:terminate", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "users:manage_permissions", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
      ];
    case "admin":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:pause", scope: null },
        { permissionKey: "agents:terminate", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
      ];
    case "operator":
      return [{ permissionKey: "tasks:assign", scope: null }];
    case "viewer":
      return [];
  }
}

type GrantSpec = {
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
};

// Source of truth for default permission grants by agent role. The backfill
// in POST /api/companies/:companyId/agents/resync-role-grants derives the
// desired grant set from this function, so updating defaults here propagates
// to existing agents on the next resync.
export function grantsForAgentRole(role: AgentRole | string): GrantSpec[] {
  switch (role) {
    case "ceo":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:pause", scope: null },
        { permissionKey: "agents:terminate", scope: null },
        { permissionKey: "tasks:assign", scope: null },
      ];
    default:
      return [{ permissionKey: "tasks:assign", scope: null }];
  }
}

// An agent role "qualifies" for the resync if its defaults include any grants
// beyond the universal tasks:assign baseline. Non-qualifying roles are skipped
// to avoid touching IC agents that already have the only grant they should.
export function agentRoleQualifiesForGrantResync(role: AgentRole | string): boolean {
  const desired = grantsForAgentRole(role);
  return desired.some((grant) => grant.permissionKey !== "tasks:assign");
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "operator";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "operator";
  }
  return normalizeHumanRole((scoped as Record<string, unknown>).role, "operator");
}

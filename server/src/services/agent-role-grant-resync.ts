import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import {
  agentRoleQualifiesForGrantResync,
  grantsForAgentRole,
} from "./company-member-roles.js";

export type AgentGrantResyncSummary = {
  companyId: string;
  agentsConsidered: number;
  agentsQualified: number;
  agentsUpdated: number;
  grantsInserted: number;
  perAgent: Array<{
    agentId: string;
    role: string;
    insertedGrants: PermissionKey[];
  }>;
};

// Idempotently insert any missing role-default permission grants for every
// qualifying agent in the given company. Never deletes or rewrites existing
// rows. Skips terminated and pending_approval agents because they have no
// active membership we want to extend.
export async function resyncAgentRoleGrantsForCompany(
  db: Db,
  options: { companyId: string; grantedByUserId: string | null },
): Promise<AgentGrantResyncSummary> {
  const { companyId, grantedByUserId } = options;

  const companyAgents = await db
    .select({ id: agents.id, role: agents.role, status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"), ne(agents.status, "pending_approval")));

  const summary: AgentGrantResyncSummary = {
    companyId,
    agentsConsidered: companyAgents.length,
    agentsQualified: 0,
    agentsUpdated: 0,
    grantsInserted: 0,
    perAgent: [],
  };

  for (const agent of companyAgents) {
    if (!agentRoleQualifiesForGrantResync(agent.role)) continue;
    summary.agentsQualified += 1;

    const desired = grantsForAgentRole(agent.role);

    const existingGrants = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, agent.id),
        ),
      );
    const existingKeys = new Set<string>(existingGrants.map((row) => row.permissionKey));

    const toInsert = desired.filter((grant) => !existingKeys.has(grant.permissionKey));
    if (toInsert.length === 0) continue;

    await db.transaction(async (tx) => {
      // Ensure an active membership exists so the new grants are evaluable;
      // mirrors the pattern used by setPrincipalPermission.
      const membership = await tx
        .select({ id: companyMemberships.id, status: companyMemberships.status })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "agent"),
            eq(companyMemberships.principalId, agent.id),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!membership) {
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "agent",
          principalId: agent.id,
          status: "active",
          membershipRole: "member",
        });
      }

      for (const grant of toInsert) {
        // Use ON CONFLICT DO NOTHING for belt-and-suspenders idempotency in
        // case a concurrent caller races us; the lookup above already filtered
        // duplicates within this transaction.
        await tx
          .insert(principalPermissionGrants)
          .values({
            companyId,
            principalType: "agent",
            principalId: agent.id,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
          })
          .onConflictDoNothing({
            target: [
              principalPermissionGrants.companyId,
              principalPermissionGrants.principalType,
              principalPermissionGrants.principalId,
              principalPermissionGrants.permissionKey,
            ],
          });
      }
    });

    summary.agentsUpdated += 1;
    summary.grantsInserted += toInsert.length;
    summary.perAgent.push({
      agentId: agent.id,
      role: agent.role,
      insertedGrants: toInsert.map((grant) => grant.permissionKey),
    });
  }

  return summary;
}

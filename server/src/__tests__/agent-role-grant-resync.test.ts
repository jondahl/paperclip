import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resyncAgentRoleGrantsForCompany } from "../services/agent-role-grant-resync.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>, label: string) {
  return db
    .insert(companies)
    .values({
      name: `Resync ${label} ${randomUUID()}`,
      issuePrefix: `RZ${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  input: {
    role?: string;
    status?: string;
    permissions?: Record<string, unknown>;
  } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: input.role ?? "engineer",
      status: input.status ?? "idle",
      permissions: input.permissions ?? {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedTasksAssignGrant(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    status: "active",
    membershipRole: "member",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    permissionKey: "tasks:assign",
    grantedByUserId: "local-board",
  });
}

async function listGrantKeys(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
) {
  const rows = await db
    .select({ permissionKey: principalPermissionGrants.permissionKey })
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, agentId),
      ),
    );
  return rows.map((row) => row.permissionKey).sort();
}

describeEmbeddedPostgres("resyncAgentRoleGrantsForCompany", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-role-grant-resync-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inserts missing agents:pause + agents:terminate for an existing CEO agent", async () => {
    const company = await createCompany(db, "Backfill");
    const ceoAgent = await createAgent(db, company.id, {
      role: "ceo",
      permissions: { canCreateAgents: true },
    });
    await seedTasksAssignGrant(db, company.id, ceoAgent.id);

    await expect(listGrantKeys(db, company.id, ceoAgent.id)).resolves.toEqual([
      "tasks:assign",
    ]);

    const summary = await resyncAgentRoleGrantsForCompany(db, {
      companyId: company.id,
      grantedByUserId: "operator-1",
    });

    expect(summary.companyId).toBe(company.id);
    expect(summary.agentsQualified).toBe(1);
    expect(summary.agentsUpdated).toBe(1);
    expect(summary.grantsInserted).toBe(3);
    expect(summary.perAgent).toEqual([
      expect.objectContaining({
        agentId: ceoAgent.id,
        role: "ceo",
        insertedGrants: expect.arrayContaining([
          "agents:create",
          "agents:pause",
          "agents:terminate",
        ]),
      }),
    ]);

    await expect(listGrantKeys(db, company.id, ceoAgent.id)).resolves.toEqual([
      "agents:create",
      "agents:pause",
      "agents:terminate",
      "tasks:assign",
    ]);
  });

  it("is a no-op when re-run (no duplicate rows, no new grants)", async () => {
    const company = await createCompany(db, "Idempotent");
    const ceoAgent = await createAgent(db, company.id, { role: "ceo" });
    await seedTasksAssignGrant(db, company.id, ceoAgent.id);

    await resyncAgentRoleGrantsForCompany(db, {
      companyId: company.id,
      grantedByUserId: null,
    });
    const firstSnapshot = await listGrantKeys(db, company.id, ceoAgent.id);
    expect(firstSnapshot).toEqual([
      "agents:create",
      "agents:pause",
      "agents:terminate",
      "tasks:assign",
    ]);

    const secondRun = await resyncAgentRoleGrantsForCompany(db, {
      companyId: company.id,
      grantedByUserId: null,
    });
    expect(secondRun.grantsInserted).toBe(0);
    expect(secondRun.agentsUpdated).toBe(0);
    expect(secondRun.agentsQualified).toBe(1);

    await expect(listGrantKeys(db, company.id, ceoAgent.id)).resolves.toEqual(firstSnapshot);
  });

  it("does not add new grants to non-qualifying engineer agents", async () => {
    const company = await createCompany(db, "NoQualify");
    const engineerAgent = await createAgent(db, company.id, { role: "engineer" });
    await seedTasksAssignGrant(db, company.id, engineerAgent.id);

    const summary = await resyncAgentRoleGrantsForCompany(db, {
      companyId: company.id,
      grantedByUserId: null,
    });

    expect(summary.agentsConsidered).toBe(1);
    expect(summary.agentsQualified).toBe(0);
    expect(summary.agentsUpdated).toBe(0);
    expect(summary.grantsInserted).toBe(0);
    await expect(listGrantKeys(db, company.id, engineerAgent.id)).resolves.toEqual([
      "tasks:assign",
    ]);
  });

  it("preserves unrelated existing grants on qualifying agents", async () => {
    const company = await createCompany(db, "Preserve");
    const ceoAgent = await createAgent(db, company.id, { role: "ceo" });
    await seedTasksAssignGrant(db, company.id, ceoAgent.id);
    // Pre-existing custom grant the operator added by hand. Not in the role
    // defaults — the resync must leave it alone.
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: ceoAgent.id,
      permissionKey: "environments:manage",
      grantedByUserId: "operator-prior",
    });

    await resyncAgentRoleGrantsForCompany(db, {
      companyId: company.id,
      grantedByUserId: null,
    });

    await expect(listGrantKeys(db, company.id, ceoAgent.id)).resolves.toEqual([
      "agents:create",
      "agents:pause",
      "agents:terminate",
      "environments:manage",
      "tasks:assign",
    ]);
  });

  it("skips terminated agents", async () => {
    const company = await createCompany(db, "Terminated");
    const terminatedCeo = await createAgent(db, company.id, {
      role: "ceo",
      status: "terminated",
    });
    await seedTasksAssignGrant(db, company.id, terminatedCeo.id);

    const summary = await resyncAgentRoleGrantsForCompany(db, {
      companyId: company.id,
      grantedByUserId: null,
    });

    expect(summary.agentsConsidered).toBe(0);
    expect(summary.agentsUpdated).toBe(0);
    await expect(listGrantKeys(db, company.id, terminatedCeo.id)).resolves.toEqual([
      "tasks:assign",
    ]);
  });

  it("creates an active membership for a qualifying agent that lacks one", async () => {
    const company = await createCompany(db, "Membership");
    const ceoAgent = await createAgent(db, company.id, { role: "ceo" });
    // No prior membership or grants — simulate an agent provisioned outside
    // the normal join flow.

    const summary = await resyncAgentRoleGrantsForCompany(db, {
      companyId: company.id,
      grantedByUserId: "local-board",
    });

    expect(summary.agentsUpdated).toBe(1);
    expect(summary.grantsInserted).toBe(4);

    const membership = await db
      .select({ status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalId, ceoAgent.id),
        ),
      );
    expect(membership).toHaveLength(1);
    expect(membership[0]!.status).toBe("active");
    await expect(listGrantKeys(db, company.id, ceoAgent.id)).resolves.toEqual([
      "agents:create",
      "agents:pause",
      "agents:terminate",
      "tasks:assign",
    ]);
  });
});

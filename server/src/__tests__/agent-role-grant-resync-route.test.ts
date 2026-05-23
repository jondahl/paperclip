import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createAppForAgent(
  db: Db,
  companyId: string,
  agentId: string,
) {
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      companyIds: [companyId],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompany(db: Db) {
  return db
    .insert(companies)
    .values({
      name: `Resync Route ${randomUUID()}`,
      issuePrefix: `RR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: Db,
  companyId: string,
  input: { role?: string } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: input.role ?? "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function ensureActiveMembership(
  db: Db,
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
}

async function listGrantKeys(db: Db, companyId: string, agentId: string) {
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

describeEmbeddedPostgres("POST /api/companies/:companyId/agents/resync-role-grants", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-role-grant-resync-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects an agent caller without users:manage_permissions with 403", async () => {
    const company = await createCompany(db);
    const callerAgent = await createAgent(db, company.id, { role: "engineer" });
    await ensureActiveMembership(db, company.id, callerAgent.id);
    // Caller has tasks:assign but NOT users:manage_permissions.
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: callerAgent.id,
      permissionKey: "tasks:assign",
      grantedByUserId: null,
    });

    const ceoAgent = await createAgent(db, company.id, { role: "ceo" });
    await ensureActiveMembership(db, company.id, ceoAgent.id);

    const res = await request(await createAppForAgent(db, company.id, callerAgent.id))
      .post(`/api/companies/${company.id}/agents/resync-role-grants`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // No grants should have been inserted on the target CEO agent.
    await expect(listGrantKeys(db, company.id, ceoAgent.id)).resolves.toEqual([]);
  });

  it("succeeds and reports a summary when the agent caller has users:manage_permissions", async () => {
    const company = await createCompany(db);
    const callerAgent = await createAgent(db, company.id, { role: "ceo" });
    await ensureActiveMembership(db, company.id, callerAgent.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: callerAgent.id,
      permissionKey: "users:manage_permissions",
      grantedByUserId: null,
    });

    const ceoAgent = await createAgent(db, company.id, { role: "ceo" });
    await ensureActiveMembership(db, company.id, ceoAgent.id);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: ceoAgent.id,
      permissionKey: "tasks:assign",
      grantedByUserId: null,
    });

    const res = await request(await createAppForAgent(db, company.id, callerAgent.id))
      .post(`/api/companies/${company.id}/agents/resync-role-grants`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      companyId: company.id,
      grantsInserted: expect.any(Number),
    });
    expect(res.body.grantsInserted).toBeGreaterThan(0);

    // Target CEO agent now has the role-default grants.
    await expect(listGrantKeys(db, company.id, ceoAgent.id)).resolves.toEqual(
      expect.arrayContaining(["agents:pause", "agents:terminate"]),
    );
  });
});

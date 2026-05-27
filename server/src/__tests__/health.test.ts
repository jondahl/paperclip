import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";


const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
  writeDevServerRestartRequest: vi.fn(),
}));

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db));
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", version: serverVersion });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable"
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
    });
  });
});

describe("POST /health/dev-server/restart", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createRestartApp() {
    const ds = await import("../dev-server-status.js");
    const { healthRoutes } = await import("../routes/health.js");
    const app = express();
    app.use(express.json());
    app.use("/health", healthRoutes());
    return { app, ds };
  }

  it("returns 404 when no dev server supervisor is running", async () => {
    const { app, ds } = await createRestartApp();
    vi.spyOn(ds, "readPersistedDevServerStatus").mockReturnValue(null);
    const res = await request(app).post("/health/dev-server/restart").send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "dev_server_supervisor_unavailable" });
  });

  it("returns 409 when the server is already up to date and force is not set", async () => {
    const { app, ds } = await createRestartApp();
    vi.spyOn(ds, "readPersistedDevServerStatus").mockReturnValue({
      dirty: false,
      changedPathCount: 0,
      pendingMigrations: [],
      changedPathsSample: [],
      lastChangedAt: null,
      lastRestartAt: null,
    });
    const writeSpy = vi.spyOn(ds, "writeDevServerRestartRequest").mockReturnValue(false);
    const res = await request(app).post("/health/dev-server/restart").send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "restart_not_required" });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("returns 202 and writes the restart request when changes are pending", async () => {
    const { app, ds } = await createRestartApp();
    vi.spyOn(ds, "readPersistedDevServerStatus").mockReturnValue({
      dirty: true,
      changedPathCount: 2,
      pendingMigrations: [],
      changedPathsSample: ["server/src/routes/foo.ts"],
      lastChangedAt: "2026-05-27T00:00:00Z",
      lastRestartAt: null,
    });
    const writeSpy = vi.spyOn(ds, "writeDevServerRestartRequest").mockReturnValue(true);
    const res = await request(app).post("/health/dev-server/restart").send({});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "restart_requested" });
    expect(writeSpy).toHaveBeenCalledOnce();
  });

  // Regression: force=true must bypass the restartRequired gate so operators can recycle
  // a stale binary when the dev-runner status file shows a clean state (PLA-166).
  it("returns 202 when force=true even if the server appears clean", async () => {
    const { app, ds } = await createRestartApp();
    vi.spyOn(ds, "readPersistedDevServerStatus").mockReturnValue({
      dirty: false,
      changedPathCount: 0,
      pendingMigrations: [],
      changedPathsSample: [],
      lastChangedAt: null,
      lastRestartAt: null,
    });
    const writeSpy = vi.spyOn(ds, "writeDevServerRestartRequest").mockReturnValue(true);
    const res = await request(app)
      .post("/health/dev-server/restart")
      .send({ force: true });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "restart_requested" });
    expect(writeSpy).toHaveBeenCalledOnce();
  });
});

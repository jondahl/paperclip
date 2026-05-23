import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { getTokenSnapshot } from "../services/tokens.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

function parseDate(raw: unknown, fallback: () => Date): Date {
  if (raw == null || raw === "") return fallback();
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) throw badRequest("invalid date");
  return parsed;
}

export function tokenRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/tokens/snapshot", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from = parseDate(req.query.from, () => defaultFrom);
    const to = parseDate(req.query.to, () => now);
    if (from.getTime() > to.getTime()) {
      throw badRequest("'from' must be <= 'to'");
    }
    const weekOverWeek = String(req.query.weekOverWeek ?? "").toLowerCase() === "true";
    const agentId = typeof req.query.agentId === "string" && req.query.agentId.length > 0
      ? (req.query.agentId as string)
      : undefined;

    const snapshot = await getTokenSnapshot(db, {
      companyId,
      from,
      to,
      agentId,
      weekOverWeek,
    });
    res.json(snapshot);
  });

  return router;
}

import { Router } from "express";
import type { RowDataPacket } from "mysql2";
import { requireSession } from "../middleware/require-session.js";
import { pool } from "../db.js";
import { writeAuditEvent } from "../security/audit.js";

interface FacilityRow extends RowDataPacket {
  facility_id: number;
  facility_code: string;
  name: string;
}

export const facilitiesRouter = Router();
facilitiesRouter.use(requireSession);

facilitiesRouter.get("/", async (req, res, next) => {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  if (principal.facilityIds.size === 0) {
    res.json({ facilities: [] });
    return;
  }
  try {
    const [facilities] = await pool.execute<FacilityRow[]>(
      `SELECT facility_id, facility_code, name
       FROM facilities WHERE status = 'active' AND facility_id IN (${[...principal.facilityIds].map(() => "?").join(",")})
       ORDER BY name`,
      [...principal.facilityIds],
    );
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "facility.list",
      resourceType: "facility",
      outcome: "allowed",
      ipAddress: req.ip,
    });
    res.json({ facilities });
  } catch (error) {
    next(error);
  }
});

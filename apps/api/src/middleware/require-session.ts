import type { NextFunction, Request, Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db.js";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, hashSessionToken } from "../security/session.js";
import type { Principal } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal;
  }
}

interface SessionRow extends RowDataPacket {
  session_id: number;
  user_id: number;
  username: string;
  display_name: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  mfa_verified_at: Date | null;
  must_change_password: number;
}

interface PermissionRow extends RowDataPacket {
  permission_code: string;
}

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

interface DepartmentAssignmentRow extends RowDataPacket {
  facility_id: number;
  department_id: number;
}

interface MfaRoleRow extends RowDataPacket {
  mfa_required: number;
  mfa_enrolled: number;
}

export async function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof token !== "string" || token.length < 32) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }

  try {
    const [sessions] = await pool.execute<SessionRow[]>(
      `SELECT s.session_id, u.user_id, u.username, u.display_name, u.must_change_password,
              s.idle_expires_at, s.absolute_expires_at, s.mfa_verified_at
       FROM sessions s
       JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL
         AND s.idle_expires_at > UTC_TIMESTAMP(6)
         AND s.absolute_expires_at > UTC_TIMESTAMP(6)
         AND u.status = 'active'
       LIMIT 1`,
      [hashSessionToken(token)],
    );
    const session = sessions[0];

    if (!session) {
      res.status(401).json({ error: { code: "SESSION_EXPIRED", message: "Your session has expired. Sign in again." } });
      return;
    }

    const [permissionRows] = await pool.execute<PermissionRow[]>(
      `SELECT DISTINCT p.permission_code
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.permission_id = rp.permission_id
       JOIN roles r ON r.role_id = ur.role_id
       WHERE ur.user_id = ? AND r.status = 'active'`,
      [session.user_id],
    );
    const [facilityRows] = await pool.execute<FacilityRow[]>(
      `SELECT facility_id FROM user_facilities WHERE user_id = ?`,
      [session.user_id],
    );
    const [departmentRows] = await pool.execute<DepartmentAssignmentRow[]>(
      `SELECT facility_id, department_id FROM user_departments WHERE user_id = ?`,
      [session.user_id],
    );
    const [mfaRoleRows] = await pool.execute<MfaRoleRow[]>(
      `SELECT MAX(r.mfa_required) AS mfa_required,
              MAX(IF(c.confirmed_at IS NOT NULL, 1, 0)) AS mfa_enrolled
       FROM user_roles ur
       JOIN roles r ON r.role_id = ur.role_id
       LEFT JOIN user_mfa_credentials c ON c.user_id = ur.user_id
       WHERE ur.user_id = ? AND r.status = 'active'`,
      [session.user_id],
    );

    await pool.execute(
      `UPDATE sessions SET idle_expires_at = LEAST(
         DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MINUTE), absolute_expires_at
       ), last_seen_at = UTC_TIMESTAMP(6) WHERE session_id = ?`,
      [config.SESSION_IDLE_MINUTES, session.session_id],
    );

    req.principal = {
      userId: session.user_id,
      sessionId: session.session_id,
      permissions: new Set(permissionRows.map((row) => row.permission_code)),
      facilityIds: new Set(facilityRows.map((row) => row.facility_id)),
      departmentAssignments: new Set(departmentRows.map((row) => `${row.facility_id}:${row.department_id}`)),
      mfaRequired: Boolean(mfaRoleRows[0]?.mfa_required),
      mfaVerified: session.mfa_verified_at !== null,
      mfaEnrolled: Boolean(mfaRoleRows[0]?.mfa_enrolled),
      mustChangePassword: Boolean(session.must_change_password),
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.principal) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
      return;
    }
    if (req.principal.mustChangePassword) {
      try {
        await writeAuditEvent({
          actorUserId: req.principal.userId,
          action: "authorization.password_change_required",
          resourceType: "permission",
          resourceId: permission,
          outcome: "denied",
          ipAddress: req.ip,
        });
      } catch (error) {
        next(error);
        return;
      }
      res.status(403).json({
        error: { code: "PASSWORD_CHANGE_REQUIRED", message: "Change your temporary password before continuing." },
      });
      return;
    }
    if (!req.principal.permissions.has(permission)) {
      try {
        await writeAuditEvent({
          actorUserId: req.principal.userId,
          action: "authorization.permission",
          resourceType: "permission",
          resourceId: permission,
          outcome: "denied",
          ipAddress: req.ip,
        });
      } catch (error) {
        next(error);
        return;
      }
      res.status(403).json({ error: { code: "FORBIDDEN", message: "You are not authorized to perform this action." } });
      return;
    }
    if (req.principal.mfaRequired && !req.principal.mfaVerified) {
      try {
        await writeAuditEvent({
          actorUserId: req.principal.userId,
          action: "authorization.mfa_required",
          resourceType: "permission",
          resourceId: permission,
          outcome: "denied",
          ipAddress: req.ip,
        });
      } catch (error) {
        next(error);
        return;
      }
      res.status(403).json({
        error: { code: "MFA_REQUIRED", message: "Enroll or verify multi-factor authentication before continuing." },
      });
      return;
    }
    next();
  };
}

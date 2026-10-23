import argon2 from "argon2";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { Router } from "express";
import { z } from "zod";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { pool } from "../db.js";
import { writeAuditEvent } from "../security/audit.js";

export const adminFacilitiesRouter = Router();
adminFacilitiesRouter.use(requireSession, requirePermission("security.user.manage"));

interface FacilityListRow extends RowDataPacket {
  facility_id: number;
  facility_code: string;
  name: string;
}

adminFacilitiesRouter.get("/facilities", async (req, res, next) => {
  try {
    const [facilities] = await pool.execute<FacilityListRow[]>(
      "SELECT facility_id, facility_code, name FROM facilities WHERE status = 'active' ORDER BY name",
    );
    if (req.principal) {
      await writeAuditEvent({
        actorUserId: req.principal.userId,
        action: "security.facility.list",
        resourceType: "facility",
        outcome: "allowed",
        ipAddress: req.ip,
      });
    }
    res.json({ facilities });
  } catch (error) {
    next(error);
  }
});

adminFacilitiesRouter.get("/roles", async (req, res, next) => {
  const facilityId = z.coerce.number().int().positive().optional().safeParse(req.query.facilityId);
  const departmentId = z.coerce.number().int().positive().optional().safeParse(req.query.departmentId);
  if (!facilityId.success || !departmentId.success) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Choose a valid facility and department." } });
    return;
  }
  if (departmentId.data !== undefined && facilityId.data === undefined) {
    res.status(400).json({ error: { code: "FACILITY_REQUIRED", message: "Choose a facility with the department." } });
    return;
  }
  try {
    if (facilityId.data !== undefined && departmentId.data !== undefined) {
      const [departments] = await pool.execute<DepartmentRow[]>(
        `SELECT department_id FROM departments
         WHERE facility_id = ? AND department_id = ? AND status = 'active'`,
        [facilityId.data, departmentId.data],
      );
      if (!departments[0]) {
        res.status(404).json({ error: { code: "DEPARTMENT_NOT_FOUND", message: "The active department was not found in that facility." } });
        return;
      }
    }
    const [roles] = await pool.execute<RoleRow[]>(
      `SELECT role_id, role_code, name, mfa_required,
              EXISTS (
                SELECT 1 FROM department_role_assignments mapped
                WHERE mapped.role_id = roles.role_id AND mapped.facility_id = ?
              ) AS department_required
       FROM roles
       WHERE status = 'active' AND role_code <> 'system_admin'
         AND (
           ? IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM department_role_assignments configured
             WHERE configured.role_id = roles.role_id AND configured.facility_id = ?
           )
           OR EXISTS (
             SELECT 1 FROM department_role_assignments allowed
             WHERE allowed.role_id = roles.role_id AND allowed.facility_id = ?
               AND allowed.department_id = ?
           )
         )
       ORDER BY display_order, name`,
      [
        facilityId.data ?? null,
        departmentId.data ?? null,
        facilityId.data ?? null,
        facilityId.data ?? null,
        departmentId.data ?? null,
      ],
    );
    res.json({
      roles: roles.map((role) => ({
        roleCode: role.role_code,
        name: role.name,
        mfaRequired: Boolean(role.mfa_required),
        departmentRequired: Boolean(role.department_required),
      })),
    });
  } catch (error) {
    next(error);
  }
});

adminFacilitiesRouter.get("/departments", async (req, res, next) => {
  const facilityId = z.coerce.number().int().positive().safeParse(req.query.facilityId);
  if (!facilityId.success) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Choose a valid facility." } });
    return;
  }
  try {
    const [departments] = await pool.execute<RowDataPacket[]>(
      `SELECT department_id, department_code, name
       FROM departments
       WHERE facility_id = ? AND status = 'active'
       ORDER BY name
       LIMIT 100`,
      [facilityId.data],
    );
    res.json({ departments });
  } catch (error) {
    next(error);
  }
});

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/u),
  displayName: z.string().trim().min(2).max(190),
  temporaryPassword: z.string().min(6).max(1024),
  roleCode: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,63}$/u),
  facilityId: z.coerce.number().int().positive(),
  departmentCode: z.string().trim().regex(/^[A-Z0-9_]{2,64}$/u).optional(),
});

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

interface RoleRow extends RowDataPacket {
  role_id: number;
  role_code: string;
  name: string;
  mfa_required: number;
  department_required: number;
}

interface DepartmentRow extends RowDataPacket {
  department_id: number;
}

export const adminUsersRouter = Router();
adminUsersRouter.use(requireSession);
adminUsersRouter.post("/", requirePermission("security.user.manage"), async (req, res, next) => {
  const actor = req.principal;
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Check the staff account details.", details: parsed.error.flatten() } });
    return;
  }
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  if (parsed.data.roleCode === "system_admin") {
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.user.create",
      resourceType: "role",
      resourceId: "system_admin",
      outcome: "denied",
      ipAddress: req.ip,
    });
    res.status(403).json({
      error: { code: "SYSTEM_ADMIN_REQUIRES_APPROVED_PROCESS", message: "System administrator access requires a separate approved process." },
    });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [facilities] = await connection.execute<FacilityRow[]>(
      "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' FOR UPDATE",
      [parsed.data.facilityId],
    );
    const [roles] = await connection.execute<RoleRow[]>(
      "SELECT role_id, mfa_required FROM roles WHERE role_code = ? AND status = 'active' FOR UPDATE",
      [parsed.data.roleCode],
    );
    const facility = facilities[0];
    const role = roles[0];
    if (!facility || !role) {
      await connection.rollback();
      res.status(404).json({ error: { code: "FACILITY_OR_ROLE_NOT_FOUND", message: "The facility or staff role is unavailable." } });
      return;
    }
    const requiredDepartmentCode = parsed.data.roleCode === "triage_nurse" || parsed.data.roleCode === "triage_clinician"
      ? "TRIAGE"
      : parsed.data.roleCode.startsWith("finance_") ? "FINANCE"
      : undefined;
    const departmentCode = requiredDepartmentCode ?? parsed.data.departmentCode;
    const [mappedDepartments] = await connection.execute<DepartmentRow[]>(
      `SELECT department_id FROM department_role_assignments
       WHERE facility_id = ? AND role_id = ? FOR UPDATE`,
      [facility.facility_id, role.role_id],
    );
    if ((parsed.data.roleCode === "department_staff" || mappedDepartments.length > 0) && !departmentCode) {
      await connection.rollback();
      res.status(400).json({
        error: { code: "DEPARTMENT_REQUIRED", message: "Choose a department assigned to this role for the staff account." },
      });
      return;
    }
    let assignedDepartmentId: number | undefined;
    if (departmentCode) {
      const [departments] = await connection.execute<DepartmentRow[]>(
        `SELECT department_id FROM departments
         WHERE facility_id = ? AND department_code = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [facility.facility_id, departmentCode],
      );
      assignedDepartmentId = departments[0]?.department_id;
      if (assignedDepartmentId === undefined) {
        await connection.rollback();
        res.status(409).json({
          error: {
            code: "DEPARTMENT_NOT_CONFIGURED",
            message: `The ${departmentCode.toLowerCase()} department is not active for this facility.`,
          },
        });
        return;
      }
      if (!mappedDepartments.some((mappedDepartment) => mappedDepartment.department_id === assignedDepartmentId)) {
        await connection.rollback();
        res.status(409).json({
          error: { code: "ROLE_NOT_ASSIGNED_TO_DEPARTMENT", message: "This role is not configured for the selected department." },
        });
        return;
      }
    }

    const passwordHash = await argon2.hash(parsed.data.temporaryPassword, { type: argon2.argon2id });
    const [inserted] = await connection.execute<ResultSetHeader>(
      `INSERT INTO users (username, display_name, password_hash, status, must_change_password, created_at)
       VALUES (?, ?, ?, 'active', TRUE, UTC_TIMESTAMP(6))`,
      [parsed.data.username, parsed.data.displayName, passwordHash],
    );
    const userId = inserted.insertId;
    await connection.execute(
      "INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)",
      [userId, role.role_id],
    );
    await connection.execute(
      "INSERT INTO user_facilities (user_id, facility_id) VALUES (?, ?)",
      [userId, facility.facility_id],
    );
    if (assignedDepartmentId !== undefined) {
      await connection.execute(
        `INSERT INTO user_departments (user_id, facility_id, department_id, assigned_at, assigned_by)
         VALUES (?, ?, ?, UTC_TIMESTAMP(6), ?)`,
        [userId, facility.facility_id, assignedDepartmentId, actor.userId],
      );
    }
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.user.create",
      resourceType: "user",
      resourceId: String(userId),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.status(201).json({
      user: {
        id: userId,
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        roleCode: parsed.data.roleCode,
        departmentCode: departmentCode ?? null,
      },
      mfaRequired: Boolean(role.mfa_required),
      passwordChangeRequired: true,
      note: "Share the temporary password through an approved secure channel. The account must change it before accessing protected modules.",
    });
  } catch (error) {
    await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: { code: "USERNAME_EXISTS", message: "That username is already in use." } });
      return;
    }
    next(error);
  } finally {
    connection.release();
  }
});

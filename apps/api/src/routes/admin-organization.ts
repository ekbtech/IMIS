import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { Router, type Response } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { writeAuditEvent } from "../security/audit.js";

export const organizationAdminRouter = Router();
organizationAdminRouter.use(requireSession, requirePermission("security.role.manage"));

const unitTypes = ["department", "ward", "clinic", "store", "service_unit", "other"] as const;
const departmentGroups = [
  "hospital",
  "budget",
  "inventory",
  "procurement",
  "hr",
  "finance",
  "administration",
  "system_tools",
  "morgue",
  "reports",
] as const;
const hospitalSubgroups = [
  "outpatient",
  "emergency",
  "inpatient",
  "maternity",
  "specialty_clinics",
  "diagnostics",
  "treatment_support",
  "other",
] as const;
const departmentSchema = z.object({
  facilityId: z.coerce.number().int().positive(),
  divisionId: z.coerce.number().int().positive(),
  departmentCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,64}$/u),
  name: z.string().trim().min(2).max(190),
  departmentGroup: z.enum(departmentGroups).default("hospital"),
  hospitalSubgroup: z.enum(hospitalSubgroups).nullable().optional(),
  unitType: z.enum(unitTypes).default("department"),
  parentDepartmentId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  displayOrder: z.coerce.number().int().min(0).max(65535).default(0),
}).superRefine((department, context) => {
  if (department.departmentGroup === "hospital" && !department.hospitalSubgroup) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hospitalSubgroup"],
      message: "Choose a subgroup for Hospital departments.",
    });
  }
  if (department.departmentGroup !== "hospital" && department.hospitalSubgroup) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hospitalSubgroup"],
      message: "Only Hospital departments can have a Hospital subgroup.",
    });
  }
});
const departmentUpdateSchema = z.object({
  divisionId: z.coerce.number().int().positive(),
  name: z.string().trim().min(2).max(190),
  departmentGroup: z.enum(departmentGroups),
  hospitalSubgroup: z.enum(hospitalSubgroups).nullable(),
  unitType: z.enum(unitTypes),
  parentDepartmentId: z.union([z.coerce.number().int().positive(), z.null()]),
  displayOrder: z.coerce.number().int().min(0).max(65535),
  status: z.enum(["active", "inactive"]),
}).superRefine((department, context) => {
  if (department.departmentGroup === "hospital" && !department.hospitalSubgroup) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hospitalSubgroup"],
      message: "Choose a subgroup for Hospital departments.",
    });
  }
  if (department.departmentGroup !== "hospital" && department.hospitalSubgroup) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["hospitalSubgroup"],
      message: "Only Hospital departments can have a Hospital subgroup.",
    });
  }
});
const divisionSchema = z.object({
  facilityId: z.coerce.number().int().positive(),
  divisionCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,64}$/u),
  name: z.string().trim().min(2).max(190),
  description: z.string().trim().max(255).default(""),
  displayOrder: z.coerce.number().int().min(0).max(65535).default(0),
});
const divisionUpdateSchema = z.object({
  name: z.string().trim().min(2).max(190),
  description: z.string().trim().max(255),
  status: z.enum(["active", "inactive"]),
  displayOrder: z.coerce.number().int().min(0).max(65535),
});
const roleCreateSchema = z.object({
  roleCode: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,63}$/u),
  name: z.string().trim().min(2).max(190),
  description: z.string().trim().max(255).default(""),
});
const roleUpdateSchema = z.object({
  name: z.string().trim().min(2).max(190),
  description: z.string().trim().max(255),
  status: z.enum(["active", "inactive"]),
  mfaRequired: z.boolean(),
});
const roleActivationSchema = z.object({
  name: z.string().trim().min(2).max(190),
  description: z.string().trim().max(255),
  facilityId: z.coerce.number().int().positive(),
  departmentIds: z.array(z.coerce.number().int().positive()).min(1).max(200),
  permissionCodes: z.array(z.string().trim().min(3).max(120)).min(1).max(100),
});
const permissionsSchema = z.object({
  permissionCodes: z.array(z.string().trim().min(3).max(120)).max(100),
});

interface DepartmentRow extends RowDataPacket {
  department_id: number;
  facility_id: number;
  division_id: number;
  department_code: string;
  department_group: typeof departmentGroups[number];
  name: string;
  status: "active" | "inactive";
  unit_type: typeof unitTypes[number];
  parent_department_id: number | null;
  display_order: number;
  hospital_subgroup: typeof hospitalSubgroups[number] | null;
}

interface DivisionRow extends RowDataPacket {
  division_id: number;
  facility_id: number;
  division_code: string;
  name: string;
  description: string;
  status: "active" | "inactive";
  display_order: number;
}

interface IdRow extends RowDataPacket {
  id: number;
}

interface RoleRow extends RowDataPacket {
  role_id: number;
  role_code: string;
  name: string;
  status: "active" | "inactive";
  mfa_required: number;
  description: string;
  display_order: number;
}

interface PermissionRow extends RowDataPacket {
  permission_id: number;
  permission_code: string;
  description: string;
}

interface RolePermissionRow extends RowDataPacket {
  role_code: string;
  permission_code: string;
}

interface RoleDepartmentRow extends RowDataPacket {
  role_code: string;
  facility_id: number;
  department_id: number;
  department_code: string;
  department_name: string;
}

function invalidRequest(res: Response, details: unknown) {
  res.status(400).json({
    error: { code: "INVALID_REQUEST", message: "Check the organization settings.", details },
  });
}

organizationAdminRouter.get("/divisions", async (req, res, next) => {
  const facilityId = z.coerce.number().int().positive().safeParse(req.query.facilityId);
  if (!facilityId.success) {
    invalidRequest(res, facilityId.error.flatten());
    return;
  }
  try {
    const [divisions] = await pool.execute<DivisionRow[]>(
      `SELECT division_id, facility_id, division_code, name, description, status, display_order
       FROM divisions
       WHERE facility_id = ?
       ORDER BY display_order, name, division_id`,
      [facilityId.data],
    );
    res.json({ divisions });
  } catch (error) {
    next(error);
  }
});

organizationAdminRouter.post("/divisions", async (req, res, next) => {
  const parsed = divisionSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [facilities] = await connection.execute<IdRow[]>(
      "SELECT facility_id AS id FROM facilities WHERE facility_id = ? AND status = 'active' FOR UPDATE",
      [parsed.data.facilityId],
    );
    if (!facilities[0]) {
      await connection.rollback();
      res.status(404).json({ error: { code: "FACILITY_NOT_FOUND", message: "The active facility was not found." } });
      return;
    }
    const [inserted] = await connection.execute<ResultSetHeader>(
      `INSERT INTO divisions
        (facility_id, division_code, name, description, status, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        parsed.data.facilityId,
        parsed.data.divisionCode,
        parsed.data.name,
        parsed.data.description,
        parsed.data.displayOrder,
      ],
    );
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.division.create",
      resourceType: "division",
      resourceId: String(inserted.insertId),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.status(201).json({ divisionId: inserted.insertId });
  } catch (error) {
    await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: { code: "DIVISION_CODE_EXISTS", message: "That division code is already in use at this facility." } });
      return;
    }
    next(error);
  } finally {
    connection.release();
  }
});

organizationAdminRouter.put("/divisions/:divisionId", async (req, res, next) => {
  const divisionId = z.coerce.number().int().positive().safeParse(req.params.divisionId);
  const parsed = divisionUpdateSchema.safeParse(req.body);
  if (!divisionId.success) {
    invalidRequest(res, divisionId.error.flatten());
    return;
  }
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [divisions] = await connection.execute<DivisionRow[]>(
      `SELECT division_id, facility_id, division_code, name, description, status, display_order
       FROM divisions WHERE division_id = ? FOR UPDATE`,
      [divisionId.data],
    );
    const division = divisions[0];
    if (!division) {
      await connection.rollback();
      res.status(404).json({ error: { code: "DIVISION_NOT_FOUND", message: "The division was not found." } });
      return;
    }
    if (parsed.data.status === "inactive" && division.status !== "inactive") {
      const [departments] = await connection.execute<IdRow[]>(
        `SELECT department_id AS id FROM departments
         WHERE facility_id = ? AND division_id = ? AND status = 'active'
         LIMIT 1 FOR UPDATE`,
        [division.facility_id, division.division_id],
      );
      if (departments[0]) {
        await connection.rollback();
        res.status(409).json({
          error: {
            code: "DIVISION_HAS_ACTIVE_DEPARTMENTS",
            message: "Move or deactivate the division's active departments before deactivating it.",
          },
        });
        return;
      }
    }
    await connection.execute(
      `UPDATE divisions
       SET name = ?, description = ?, status = ?, display_order = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE division_id = ?`,
      [parsed.data.name, parsed.data.description, parsed.data.status, parsed.data.displayOrder, division.division_id],
    );
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.division.update",
      resourceType: "division",
      resourceId: String(division.division_id),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.json({ divisionId: division.division_id });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

organizationAdminRouter.get("/departments", async (req, res, next) => {
  const facilityId = z.coerce.number().int().positive().safeParse(req.query.facilityId);
  if (!facilityId.success) {
    invalidRequest(res, facilityId.error.flatten());
    return;
  }
  try {
    const [departments] = await pool.execute<DepartmentRow[]>(
      `SELECT department_id, facility_id, division_id, department_code, department_group, hospital_subgroup, name, status,
              unit_type, parent_department_id, display_order
       FROM departments
       WHERE facility_id = ?
       ORDER BY display_order, name, department_id`,
      [facilityId.data],
    );
    res.json({ departments });
  } catch (error) {
    next(error);
  }
});

organizationAdminRouter.post("/departments", async (req, res, next) => {
  const parsed = departmentSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [facilities] = await connection.execute<IdRow[]>(
      "SELECT facility_id AS id FROM facilities WHERE facility_id = ? AND status = 'active' FOR UPDATE",
      [parsed.data.facilityId],
    );
    if (!facilities[0]) {
      await connection.rollback();
      res.status(404).json({ error: { code: "FACILITY_NOT_FOUND", message: "The active facility was not found." } });
      return;
    }
    const [divisions] = await connection.execute<IdRow[]>(
      `SELECT division_id AS id FROM divisions
       WHERE division_id = ? AND facility_id = ? AND status = 'active' FOR UPDATE`,
      [parsed.data.divisionId, parsed.data.facilityId],
    );
    if (!divisions[0]) {
      await connection.rollback();
      res.status(400).json({ error: { code: "INVALID_DIVISION", message: "Choose an active division in the selected facility." } });
      return;
    }
    if (parsed.data.parentDepartmentId !== undefined && parsed.data.parentDepartmentId !== null) {
      const [parents] = await connection.execute<IdRow[]>(
        `SELECT department_id AS id FROM departments
         WHERE department_id = ? AND facility_id = ? AND status = 'active' FOR UPDATE`,
        [parsed.data.parentDepartmentId, parsed.data.facilityId],
      );
      if (!parents[0]) {
        await connection.rollback();
        res.status(400).json({ error: { code: "INVALID_PARENT", message: "Choose an active parent in the same facility." } });
        return;
      }
    }
    const [inserted] = await connection.execute<ResultSetHeader>(
      `INSERT INTO departments
        (facility_id, division_id, department_code, department_group, hospital_subgroup, name, status, unit_type, parent_department_id, display_order)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)` ,
      [
        parsed.data.facilityId,
        parsed.data.divisionId,
        parsed.data.departmentCode,
        parsed.data.departmentGroup,
        parsed.data.departmentGroup === "hospital" ? parsed.data.hospitalSubgroup ?? "other" : null,
        parsed.data.name,
        parsed.data.unitType,
        parsed.data.parentDepartmentId ?? null,
        parsed.data.displayOrder,
      ],
    );
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.department.create",
      resourceType: "department",
      resourceId: String(inserted.insertId),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.status(201).json({ departmentId: inserted.insertId });
  } catch (error) {
    await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: { code: "DEPARTMENT_CODE_EXISTS", message: "That department code is already in use at this facility." } });
      return;
    }
    next(error);
  } finally {
    connection.release();
  }
});

organizationAdminRouter.put("/departments/:departmentId", async (req, res, next) => {
  const departmentId = z.coerce.number().int().positive().safeParse(req.params.departmentId);
  const parsed = departmentUpdateSchema.safeParse(req.body);
  if (!departmentId.success) {
    invalidRequest(res, departmentId.error.flatten());
    return;
  }
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<DepartmentRow[]>(
      `SELECT department_id, facility_id, division_id, department_code, department_group, hospital_subgroup, name, status,
              unit_type, parent_department_id, display_order
       FROM departments WHERE department_id = ? FOR UPDATE`,
      [departmentId.data],
    );
    const current = rows[0];
    if (!current) {
      await connection.rollback();
      res.status(404).json({ error: { code: "DEPARTMENT_NOT_FOUND", message: "The department was not found." } });
      return;
    }
    const [divisions] = await connection.execute<IdRow[]>(
      `SELECT division_id AS id FROM divisions
       WHERE division_id = ? AND facility_id = ? AND status = 'active' FOR UPDATE`,
      [parsed.data.divisionId, current.facility_id],
    );
    if (!divisions[0]) {
      await connection.rollback();
      res.status(400).json({ error: { code: "INVALID_DIVISION", message: "Choose an active division in the department's facility." } });
      return;
    }
    const parentId = parsed.data.parentDepartmentId;
    if (parentId !== null) {
      if (parentId === current.department_id) {
        await connection.rollback();
        res.status(400).json({ error: { code: "INVALID_PARENT", message: "A department cannot be its own parent." } });
        return;
      }
      const [parents] = await connection.execute<IdRow[]>(
        `SELECT department_id AS id FROM departments
         WHERE department_id = ? AND facility_id = ? AND status = 'active' FOR UPDATE`,
        [parentId, current.facility_id],
      );
      if (!parents[0]) {
        await connection.rollback();
        res.status(400).json({ error: { code: "INVALID_PARENT", message: "Choose an active parent in the same facility." } });
        return;
      }
      const [descendants] = await connection.execute<IdRow[]>(
        `WITH RECURSIVE descendants AS (
           SELECT department_id FROM departments
           WHERE department_id = ? AND facility_id = ?
           UNION ALL
           SELECT child.department_id FROM departments child
           JOIN descendants parent ON child.parent_department_id = parent.department_id
           WHERE child.facility_id = ?
         )
         SELECT department_id AS id FROM descendants WHERE department_id = ? LIMIT 1`,
        [current.department_id, current.facility_id, current.facility_id, parentId],
      );
      if (descendants[0]) {
        await connection.rollback();
        res.status(400).json({ error: { code: "DEPARTMENT_CYCLE", message: "The parent change would create a department hierarchy cycle." } });
        return;
      }
    }
    if (parsed.data.status === "inactive" && current.status !== "inactive") {
      const [usage] = await connection.execute<IdRow[]>(
        `SELECT 1 AS id
         FROM user_departments ud
         JOIN users u ON u.user_id = ud.user_id
         WHERE ud.facility_id = ? AND ud.department_id = ? AND u.status = 'active'
         UNION ALL
         SELECT 1 AS id FROM department_workflow_tasks
         WHERE facility_id = ? AND status IN ('requested', 'accepted', 'in_progress')
           AND (sending_department_id = ? OR receiving_department_id = ?)
         UNION ALL
         SELECT 1 AS id FROM departments
         WHERE facility_id = ? AND parent_department_id = ? AND status = 'active'
         LIMIT 1`,
        [
          current.facility_id,
          current.department_id,
          current.facility_id,
          current.department_id,
          current.department_id,
          current.facility_id,
          current.department_id,
        ],
      );
      if (usage[0]) {
        await connection.rollback();
        res.status(409).json({
          error: { code: "DEPARTMENT_IN_USE", message: "Reassign active staff, move active child units, and finish open department tasks before deactivating this department." },
        });
        return;
      }
    }
    await connection.execute(
      `UPDATE departments
       SET division_id = ?, name = ?, department_group = ?, hospital_subgroup = ?, unit_type = ?, parent_department_id = ?, display_order = ?, status = ?
       WHERE department_id = ?`,
      [
        parsed.data.divisionId,
        parsed.data.name,
        parsed.data.departmentGroup,
        parsed.data.departmentGroup === "hospital" ? parsed.data.hospitalSubgroup ?? current.hospital_subgroup ?? "other" : null,
        parsed.data.unitType,
        parentId,
        parsed.data.displayOrder,
        parsed.data.status,
        current.department_id,
      ],
    );
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.department.update",
      resourceType: "department",
      resourceId: String(current.department_id),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.json({ departmentId: current.department_id });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

organizationAdminRouter.get("/roles", async (_req, res, next) => {
  try {
    const [roles] = await pool.execute<RoleRow[]>(
      `SELECT role_id, role_code, name, status, mfa_required, description, display_order
       FROM roles ORDER BY display_order, name, role_id`,
    );
    const [permissions] = await pool.execute<PermissionRow[]>(
      "SELECT permission_id, permission_code, description FROM permissions ORDER BY permission_code",
    );
    const [grants] = await pool.execute<RolePermissionRow[]>(
      `SELECT r.role_code, p.permission_code
       FROM role_permissions rp
       JOIN roles r ON r.role_id = rp.role_id
       JOIN permissions p ON p.permission_id = rp.permission_id`,
    );
    const [departmentAssignments] = await pool.execute<RoleDepartmentRow[]>(
      `SELECT r.role_code, dra.facility_id, dra.department_id,
              d.department_code, d.name AS department_name
       FROM department_role_assignments dra
       JOIN roles r ON r.role_id = dra.role_id
       JOIN departments d ON d.facility_id = dra.facility_id
         AND d.department_id = dra.department_id
       ORDER BY dra.facility_id, d.display_order, d.name`,
    );
    const permissionsByRole = new Map<string, string[]>();
    for (const grant of grants) {
      const assigned = permissionsByRole.get(grant.role_code) ?? [];
      assigned.push(grant.permission_code);
      permissionsByRole.set(grant.role_code, assigned);
    }
    const departmentsByRole = new Map<string, Array<{
      facilityId: number;
      departmentId: number;
      departmentCode: string;
      departmentName: string;
    }>>();
    for (const assignment of departmentAssignments) {
      const assigned = departmentsByRole.get(assignment.role_code) ?? [];
      assigned.push({
        facilityId: assignment.facility_id,
        departmentId: assignment.department_id,
        departmentCode: assignment.department_code,
        departmentName: assignment.department_name,
      });
      departmentsByRole.set(assignment.role_code, assigned);
    }
    res.json({
      roles: roles.map((role) => ({
        roleId: role.role_id,
        roleCode: role.role_code,
        name: role.name,
        status: role.status,
        mfaRequired: Boolean(role.mfa_required),
        description: role.description,
        permissionCodes: permissionsByRole.get(role.role_code) ?? [],
        departmentAssignments: departmentsByRole.get(role.role_code) ?? [],
      })),
      permissions,
    });
  } catch (error) {
    next(error);
  }
});

organizationAdminRouter.post("/roles", async (req, res, next) => {
  const parsed = roleCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [inserted] = await connection.execute<ResultSetHeader>(
      `INSERT INTO roles (role_code, name, status, mfa_required, description, display_order)
       VALUES (?, ?, 'inactive', TRUE, ?, 0)`,
      [parsed.data.roleCode, parsed.data.name, parsed.data.description],
    );
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.role.create",
      resourceType: "role",
      resourceId: String(inserted.insertId),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.status(201).json({ roleId: inserted.insertId, status: "inactive", mfaRequired: true, permissionCodes: [] });
  } catch (error) {
    await connection.rollback();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: { code: "ROLE_CODE_EXISTS", message: "That role code is already in use." } });
      return;
    }
    next(error);
  } finally {
    connection.release();
  }
});

organizationAdminRouter.put("/roles/:roleId", async (req, res, next) => {
  const roleId = z.coerce.number().int().positive().safeParse(req.params.roleId);
  const parsed = roleUpdateSchema.safeParse(req.body);
  if (!roleId.success) {
    invalidRequest(res, roleId.error.flatten());
    return;
  }
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RoleRow[]>(
      `SELECT role_id, role_code, name, status, mfa_required, description, display_order
       FROM roles WHERE role_id = ? FOR UPDATE`,
      [roleId.data],
    );
    const role = rows[0];
    if (!role) {
      await connection.rollback();
      res.status(404).json({ error: { code: "ROLE_NOT_FOUND", message: "The role was not found." } });
      return;
    }
    if (role.role_code === "system_admin") {
      await connection.rollback();
      res.status(403).json({ error: { code: "SYSTEM_ROLE_PROTECTED", message: "The built-in system administrator role cannot be changed here." } });
      return;
    }
    if (role.mfa_required && !parsed.data.mfaRequired) {
      await connection.rollback();
      res.status(400).json({
        error: { code: "MFA_CANNOT_BE_WEAKENED", message: "MFA cannot be disabled for a role that currently requires it." },
      });
      return;
    }
    if (parsed.data.status === "active" && role.status !== "active") {
      await connection.rollback();
      res.status(409).json({
        error: {
          code: "ROLE_ACTIVATION_REQUIRES_CONFIGURATION",
          message: "Activate an inactive role through the guided permissions and department assignment workflow.",
        },
      });
      return;
    }
    await connection.execute(
      `UPDATE roles SET name = ?, description = ?, status = ?, mfa_required = ? WHERE role_id = ?`,
      [parsed.data.name, parsed.data.description, parsed.data.status, parsed.data.mfaRequired, role.role_id],
    );
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.role.update",
      resourceType: "role",
      resourceId: String(role.role_id),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.json({ roleId: role.role_id });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

organizationAdminRouter.put("/roles/:roleId/activate", async (req, res, next) => {
  const roleId = z.coerce.number().int().positive().safeParse(req.params.roleId);
  const parsed = roleActivationSchema.safeParse(req.body);
  if (!roleId.success) {
    invalidRequest(res, roleId.error.flatten());
    return;
  }
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const requestedCodes = [...new Set(parsed.data.permissionCodes)];
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  if (requestedCodes.includes("security.role.manage") || requestedCodes.includes("security.user.manage")) {
    res.status(400).json({
      error: {
        code: "PROTECTED_PERMISSION",
        message: "Role and user administration permissions are reserved for the built-in system administrator role.",
      },
    });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [roles] = await connection.execute<RoleRow[]>(
      `SELECT role_id, role_code, name, status, mfa_required, description, display_order
       FROM roles WHERE role_id = ? FOR UPDATE`,
      [roleId.data],
    );
    const role = roles[0];
    if (!role) {
      await connection.rollback();
      res.status(404).json({ error: { code: "ROLE_NOT_FOUND", message: "The role was not found." } });
      return;
    }
    if (role.role_code === "system_admin") {
      await connection.rollback();
      res.status(403).json({ error: { code: "SYSTEM_ROLE_PROTECTED", message: "The built-in system administrator role cannot be changed here." } });
      return;
    }
    const placeholders = requestedCodes.map(() => "?").join(", ");
    const [found] = await connection.execute<PermissionRow[]>(
      `SELECT permission_id, permission_code, description
       FROM permissions WHERE permission_code IN (${placeholders})`,
      requestedCodes,
    );
    if (found.length !== requestedCodes.length) {
      await connection.rollback();
      res.status(400).json({ error: { code: "UNKNOWN_PERMISSION", message: "One or more permission codes are not recognized." } });
      return;
    }
    const departmentIds = [...new Set(parsed.data.departmentIds)];
    const departmentPlaceholders = departmentIds.map(() => "?").join(", ");
    const [departments] = await connection.execute<DepartmentRow[]>(
      `SELECT department_id, facility_id, department_code, name, status,
              unit_type, parent_department_id, display_order
       FROM departments
       WHERE facility_id = ? AND status = 'active' AND department_id IN (${departmentPlaceholders})
       FOR UPDATE`,
      [parsed.data.facilityId, ...departmentIds],
    );
    if (departments.length !== departmentIds.length) {
      await connection.rollback();
      res.status(400).json({
        error: { code: "INVALID_DEPARTMENT_ASSIGNMENT", message: "Choose active departments from the selected facility." },
      });
      return;
    }
    const [facilityRows] = await connection.execute<IdRow[]>(
      "SELECT facility_id AS id FROM facilities WHERE facility_id = ? AND status = 'active' FOR UPDATE",
      [parsed.data.facilityId],
    );
    if (!facilityRows[0]) {
      await connection.rollback();
      res.status(404).json({ error: { code: "FACILITY_NOT_FOUND", message: "The active facility was not found." } });
      return;
    }
    await connection.execute("DELETE FROM role_permissions WHERE role_id = ?", [role.role_id]);
    for (const permission of found) {
      await connection.execute(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
        [role.role_id, permission.permission_id],
      );
    }
    await connection.execute(
      `UPDATE roles SET name = ?, description = ?, status = 'active', mfa_required = TRUE
       WHERE role_id = ?`,
      [parsed.data.name, parsed.data.description, role.role_id],
    );
    await connection.execute(
      "DELETE FROM department_role_assignments WHERE role_id = ? AND facility_id = ?",
      [role.role_id, parsed.data.facilityId],
    );
    for (const departmentId of departmentIds) {
      await connection.execute(
        `INSERT INTO department_role_assignments
          (facility_id, department_id, role_id, assigned_at, assigned_by)
         VALUES (?, ?, ?, UTC_TIMESTAMP(6), ?)`,
        [parsed.data.facilityId, departmentId, role.role_id, actor.userId],
      );
    }
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.role.activate",
      resourceType: "role",
      resourceId: String(role.role_id),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.json({
      roleId: role.role_id,
      status: "active",
      mfaRequired: true,
      permissionCodes: requestedCodes,
      departmentIds,
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

organizationAdminRouter.put("/roles/:roleId/permissions", async (req, res, next) => {
  const roleId = z.coerce.number().int().positive().safeParse(req.params.roleId);
  const parsed = permissionsSchema.safeParse(req.body);
  if (!roleId.success) {
    invalidRequest(res, roleId.error.flatten());
    return;
  }
  if (!parsed.success) {
    invalidRequest(res, parsed.error.flatten());
    return;
  }
  const requestedCodes = [...new Set(parsed.data.permissionCodes)];
  const actor = req.principal;
  if (!actor) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [roles] = await connection.execute<RoleRow[]>(
      `SELECT role_id, role_code, name, status, mfa_required, description, display_order
       FROM roles WHERE role_id = ? FOR UPDATE`,
      [roleId.data],
    );
    const role = roles[0];
    if (!role) {
      await connection.rollback();
      res.status(404).json({ error: { code: "ROLE_NOT_FOUND", message: "The role was not found." } });
      return;
    }
    if (role.role_code === "system_admin") {
      await connection.rollback();
      res.status(403).json({ error: { code: "SYSTEM_ROLE_PROTECTED", message: "System administrator permissions cannot be changed here." } });
      return;
    }
    if (role.status === "active" && requestedCodes.length === 0) {
      await connection.rollback();
      res.status(409).json({
        error: { code: "ACTIVE_ROLE_REQUIRES_PERMISSION", message: "Deactivate this role before removing all of its permissions." },
      });
      return;
    }
    if (requestedCodes.includes("security.role.manage") || requestedCodes.includes("security.user.manage")) {
      await connection.rollback();
      res.status(400).json({
        error: {
          code: "PROTECTED_PERMISSION",
          message: "Role and user administration permissions are reserved for the built-in system administrator role.",
        },
      });
      return;
    }
    let permissionIds: number[] = [];
    if (requestedCodes.length > 0) {
      const placeholders = requestedCodes.map(() => "?").join(", ");
      const [found] = await connection.execute<PermissionRow[]>(
        `SELECT permission_id, permission_code, description
         FROM permissions WHERE permission_code IN (${placeholders})`,
        requestedCodes,
      );
      if (found.length !== requestedCodes.length) {
        await connection.rollback();
        res.status(400).json({ error: { code: "UNKNOWN_PERMISSION", message: "One or more permission codes are not recognized." } });
        return;
      }
      permissionIds = found.map((permission) => permission.permission_id);
    }
    await connection.execute("DELETE FROM role_permissions WHERE role_id = ?", [role.role_id]);
    for (const permissionId of permissionIds) {
      await connection.execute(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
        [role.role_id, permissionId],
      );
    }
    if (permissionIds.length > 0) {
      await connection.execute("UPDATE roles SET mfa_required = TRUE WHERE role_id = ?", [role.role_id]);
    }
    await writeAuditEvent({
      actorUserId: actor.userId,
      action: "security.role.permissions.update",
      resourceType: "role",
      resourceId: String(role.role_id),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    res.json({ roleId: role.role_id, permissionCodes: requestedCodes });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

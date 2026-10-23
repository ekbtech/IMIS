import type { RowDataPacket } from "mysql2";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireSession } from "../middleware/require-session.js";
import { canAccessDepartment, canUsePermission } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";

export const departmentWorkspacesRouter = Router();
departmentWorkspacesRouter.use(requireSession);

interface WorkspaceRow extends RowDataPacket {
  facility_id: number;
  facility_name: string;
  division_id: number;
  division_code: string;
  division_name: string;
  division_order: number;
  department_id: number;
  department_code: string;
  department_group: "hospital" | "budget" | "inventory" | "procurement" | "hr" | "finance" |
    "administration" | "system_tools" | "morgue" | "reports";
  hospital_subgroup: "outpatient" | "emergency" | "inpatient" | "maternity" |
    "specialty_clinics" | "diagnostics" | "treatment_support" | "other" | null;
  department_name: string;
  unit_type: string;
  role_id: number | null;
  role_code: string | null;
  role_name: string | null;
  role_status: "active" | "inactive" | null;
}

interface DivisionListRow extends RowDataPacket {
  division_id: number;
  division_code: string;
  division_name: string;
  division_order: number;
}

function mapWorkspaces(rows: WorkspaceRow[]) {
  const workspaces = new Map<string, {
    facilityId: number;
    facilityName: string;
    divisionId: number;
    divisionCode: string;
    divisionName: string;
    divisionOrder: number;
    departmentId: number;
    departmentCode: string;
    departmentGroup: WorkspaceRow["department_group"];
    hospitalSubgroup: WorkspaceRow["hospital_subgroup"];
    departmentName: string;
    unitType: string;
    roles: Array<{ roleId: number; roleCode: string; name: string; status: string }>;
  }>();
  for (const row of rows) {
    const key = `${row.facility_id}:${row.department_id}`;
    let workspace = workspaces.get(key);
    if (!workspace) {
      workspace = {
        facilityId: row.facility_id,
        facilityName: row.facility_name,
        divisionId: row.division_id,
        divisionCode: row.division_code,
        divisionName: row.division_name,
        divisionOrder: row.division_order,
        departmentId: row.department_id,
        departmentCode: row.department_code,
        departmentGroup: row.department_group,
        hospitalSubgroup: row.hospital_subgroup,
        departmentName: row.department_name,
        unitType: row.unit_type,
        roles: [],
      };
      workspaces.set(key, workspace);
    }
    if (row.role_id !== null && row.role_code && row.role_name && row.role_status) {
      workspace.roles.push({
        roleId: row.role_id,
        roleCode: row.role_code,
        name: row.role_name,
        status: row.role_status,
      });
    }
  }
  return [...workspaces.values()];
}

function requireUsableSession(req: Parameters<typeof requireSession>[0], res: Parameters<typeof requireSession>[1]): boolean {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return false;
  }
  if (principal.mustChangePassword || (principal.mfaRequired && !principal.mfaVerified)) {
    res.status(403).json({
      error: {
        code: principal.mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "MFA_REQUIRED",
        message: principal.mustChangePassword
          ? "Change your temporary password before continuing."
          : "Verify multi-factor authentication before continuing.",
      },
    });
    return false;
  }
  return true;
}

departmentWorkspacesRouter.get("/workspaces", async (req, res, next) => {
  const principal = req.principal;
  if (!requireUsableSession(req, res) || !principal) return;
  const isAdministrator = canUsePermission(principal, "security.role.manage");
  try {
    const [divisionRows] = await pool.execute<DivisionListRow[]>(
      `SELECT DISTINCT v.division_id, v.division_code, v.name AS division_name,
              v.display_order AS division_order
       FROM divisions v
       LEFT JOIN departments d ON d.facility_id = v.facility_id
         AND d.division_id = v.division_id AND d.status = 'active'
       WHERE v.status = 'active'
         AND (? = 1 OR EXISTS (
           SELECT 1 FROM user_departments ud
           WHERE ud.user_id = ? AND ud.facility_id = v.facility_id
             AND ud.department_id = d.department_id
         ))
       ORDER BY v.display_order, v.name`,
      [isAdministrator ? 1 : 0, principal.userId],
    );
    const [rows] = await pool.execute<WorkspaceRow[]>(
      `SELECT d.facility_id, f.name AS facility_name,
              v.division_id, v.division_code, v.name AS division_name,
              v.display_order AS division_order,
              d.department_id, d.department_code, d.department_group, d.hospital_subgroup,
              d.name AS department_name, d.unit_type,
              r.role_id, r.role_code, r.name AS role_name, r.status AS role_status
       FROM departments d
       JOIN facilities f ON f.facility_id = d.facility_id AND f.status = 'active'
       JOIN divisions v ON v.facility_id = d.facility_id
         AND v.division_id = d.division_id AND v.status = 'active'
       LEFT JOIN department_role_assignments dra
         ON dra.facility_id = d.facility_id AND dra.department_id = d.department_id
       LEFT JOIN roles r ON r.role_id = dra.role_id
         AND (? = 1 OR (
           r.status = 'active'
           AND EXISTS (
             SELECT 1 FROM user_roles ur
             WHERE ur.user_id = ? AND ur.role_id = r.role_id
           )
           AND EXISTS (
             SELECT 1 FROM user_departments ud
             WHERE ud.user_id = ? AND ud.facility_id = d.facility_id
               AND ud.department_id = d.department_id
           )
         ))
       WHERE d.status = 'active'
         AND (? = 1 OR EXISTS (
           SELECT 1 FROM user_departments ud
           WHERE ud.user_id = ? AND ud.facility_id = d.facility_id
             AND ud.department_id = d.department_id
         ))
       ORDER BY f.name, v.display_order, v.name, d.display_order, d.name, r.name`,
      [
        isAdministrator ? 1 : 0,
        principal.userId,
        principal.userId,
        isAdministrator ? 1 : 0,
        principal.userId,
      ],
    );
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "department.workspace.list",
      resourceType: "department",
      outcome: "allowed",
      ipAddress: req.ip,
    });
    res.json({
      divisions: divisionRows.map((division) => ({
        divisionId: division.division_id,
        divisionCode: division.division_code,
        divisionName: division.division_name,
        divisionOrder: division.division_order,
      })),
      workspaces: mapWorkspaces(rows),
      administratorView: isAdministrator,
    });
  } catch (error) {
    next(error);
  }
});

departmentWorkspacesRouter.get("/workspaces/:facilityId/:departmentId", async (req, res, next) => {
  const facilityId = z.coerce.number().int().positive().safeParse(req.params.facilityId);
  const departmentId = z.coerce.number().int().positive().safeParse(req.params.departmentId);
  if (!facilityId.success || !departmentId.success) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Choose a valid department." } });
    return;
  }
  const principal = req.principal;
  if (!requireUsableSession(req, res) || !principal) return;
  const isAdministrator = canUsePermission(principal, "security.role.manage");
  if (!isAdministrator &&
      (!principal.facilityIds.has(facilityId.data) ||
        !canAccessDepartment(principal, facilityId.data, departmentId.data))) {
    try {
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "department.workspace.read",
        resourceType: "department",
        resourceId: String(departmentId.data),
        outcome: "denied",
        ipAddress: req.ip,
      });
    } catch (error) {
      next(error);
      return;
    }
    res.status(403).json({ error: { code: "FORBIDDEN", message: "You are not assigned to this department." } });
    return;
  }
  try {
    const [rows] = await pool.execute<WorkspaceRow[]>(
      `SELECT d.facility_id, f.name AS facility_name,
              v.division_id, v.division_code, v.name AS division_name,
              v.display_order AS division_order,
              d.department_id, d.department_code, d.department_group, d.hospital_subgroup,
              d.name AS department_name, d.unit_type,
              r.role_id, r.role_code, r.name AS role_name, r.status AS role_status
       FROM departments d
       JOIN facilities f ON f.facility_id = d.facility_id AND f.status = 'active'
       JOIN divisions v ON v.facility_id = d.facility_id
         AND v.division_id = d.division_id AND v.status = 'active'
       LEFT JOIN department_role_assignments dra
         ON dra.facility_id = d.facility_id AND dra.department_id = d.department_id
       LEFT JOIN roles r ON r.role_id = dra.role_id
         AND (? = 1 OR (
           r.status = 'active'
           AND EXISTS (
             SELECT 1 FROM user_roles ur
             WHERE ur.user_id = ? AND ur.role_id = r.role_id
           )
           AND EXISTS (
             SELECT 1 FROM user_departments ud
             WHERE ud.user_id = ? AND ud.facility_id = d.facility_id
               AND ud.department_id = d.department_id
           )
         ))
       WHERE d.status = 'active' AND d.facility_id = ? AND d.department_id = ?
       ORDER BY r.name`,
      [isAdministrator ? 1 : 0, principal.userId, principal.userId, facilityId.data, departmentId.data],
    );
    const workspace = mapWorkspaces(rows)[0];
    if (!workspace) {
      res.status(404).json({ error: { code: "DEPARTMENT_NOT_FOUND", message: "The active department was not found." } });
      return;
    }
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "department.workspace.read",
      resourceType: "department",
      resourceId: String(departmentId.data),
      outcome: "allowed",
      ipAddress: req.ip,
    });
    res.json({
      workspace,
      permissions: [...principal.permissions],
      administratorView: isAdministrator,
    });
  } catch (error) {
    next(error);
  }
});

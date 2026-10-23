import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";

const mysqlWorkflowEnabled = process.env.MYSQL_E2E === "1";
const facilityCode = "DEMO-L5";
const suffix = randomUUID();
const dateOfBirth = new Date(
  Date.UTC(1900, 0, 1 + Number.parseInt(suffix.slice(0, 8), 16) % 45000),
).toISOString().slice(0, 10);

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

interface PatientRow extends RowDataPacket {
  patient_count: number;
}

interface ClinicalRows extends RowDataPacket {
  observation_count: number;
  note_count: number;
  encrypted_content: Buffer;
}

async function createSessionForRole(
  roleCode: string,
  mfaVerified: boolean,
  departmentCode?: string,
): Promise<{ token: string; userId: number }> {
  const [roleRows] = await pool.execute<RowDataPacket[]>(
    "SELECT role_id FROM roles WHERE role_code = ? AND status = 'active' LIMIT 1",
    [roleCode],
  );
  const role = roleRows[0];
  if (!role) throw new Error(`Required integration-test role is missing: ${roleCode}`);

  const username = `mysql-e2e-${roleCode}-${randomUUID().slice(0, 8)}`;
  const [userResult] = await pool.execute<ResultSetHeader>(
    `INSERT INTO users (username, display_name, password_hash, status, created_at)
     VALUES (?, ?, 'test-only-password-hash', 'active', UTC_TIMESTAMP(6))`,
    [username, `Synthetic ${roleCode}`],
  );
  const userId = userResult.insertId;
  const [facilities] = await pool.execute<FacilityRow[]>(
    "SELECT facility_id FROM facilities WHERE facility_code = ? AND status = 'active' LIMIT 1",
    [facilityCode],
  );
  if (!facilities[0]) throw new Error(`Required integration-test facility is missing: ${facilityCode}`);

  await pool.execute("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, role.role_id]);
  await pool.execute(
    "INSERT INTO user_facilities (user_id, facility_id) VALUES (?, ?)",
    [userId, facilities[0].facility_id],
  );
  if (departmentCode) {
    const [departments] = await pool.execute<RowDataPacket[]>(
      "SELECT department_id FROM departments WHERE facility_id = ? AND department_code = ? LIMIT 1",
      [facilities[0].facility_id, departmentCode],
    );
    const department = departments[0];
    if (!department) throw new Error("Required triage department is missing.");
    await pool.execute(
      `INSERT INTO user_departments (user_id, facility_id, department_id, assigned_at, assigned_by)
       VALUES (?, ?, ?, UTC_TIMESTAMP(6), ?)`,
      [userId, facilities[0].facility_id, department.department_id, userId],
    );
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await pool.execute(
    `INSERT INTO sessions
      (user_id, token_hash, created_at, last_seen_at, idle_expires_at,
       absolute_expires_at, revoked_at, mfa_verified_at)
     VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6),
       DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 15 MINUTE),
       DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 HOUR), NULL,
       ${mfaVerified ? "UTC_TIMESTAMP(6)" : "NULL"})`,
    [userId, tokenHash],
  );
  return { token, userId };
}

function futureEatDateTime(hoursAhead: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Date.now() + hoursAhead * 60 * 60 * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

describe.skipIf(!mysqlWorkflowEnabled)("MySQL-backed synthetic patient workflow", () => {
  let registrationCookie: string;
  let clinicianCookie: string;
  let administratorCookie: string;
  let administratorId: number;
  let triageNurseCookie: string;
  let triageClinicianCookie: string;
  let unassignedTriageNurseCookie: string;
  let financeClerkCookie: string;
  let financeBillerCookie: string;
  let financeSupervisorCookie: string;
  let unassignedFinanceClerkCookie: string;
  let triageApproverId: number;
  let facilityId: number;
  let patientId: number;
  let encounterId: string;

  beforeAll(async () => {
    const [facilities] = await pool.execute<FacilityRow[]>(
      "SELECT facility_id FROM facilities WHERE facility_code = ? AND status = 'active' LIMIT 1",
      [facilityCode],
    );
    if (!facilities[0]) throw new Error(`Required integration-test facility is missing: ${facilityCode}`);
    facilityId = Number(facilities[0].facility_id);
    registrationCookie = `imis_session=${(await createSessionForRole("registration_clerk", false, "OPD")).token}`;
    clinicianCookie = `imis_session=${(await createSessionForRole("clinician", true)).token}`;
    const administrator = await createSessionForRole("system_admin", true);
    administratorCookie = `imis_session=${administrator.token}`;
    administratorId = administrator.userId;
    triageNurseCookie = `imis_session=${(await createSessionForRole("triage_nurse", true, "TRIAGE")).token}`;
    const triageClinician = await createSessionForRole("triage_clinician", true, "TRIAGE");
    triageClinicianCookie = `imis_session=${triageClinician.token}`;
    triageApproverId = triageClinician.userId;
    unassignedTriageNurseCookie = `imis_session=${(await createSessionForRole("triage_nurse", true)).token}`;
    financeClerkCookie = `imis_session=${(await createSessionForRole("finance_clerk", true, "FINANCE")).token}`;
    financeBillerCookie = `imis_session=${(await createSessionForRole("finance_biller", true, "FINANCE")).token}`;
    financeSupervisorCookie = `imis_session=${(await createSessionForRole("finance_supervisor", true, "FINANCE")).token}`;
    unassignedFinanceClerkCookie = `imis_session=${(await createSessionForRole("finance_clerk", true)).token}`;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("configures departments and permissionless roles without privilege escalation", async () => {
    const code = `E2E_${suffix.slice(0, 8).toUpperCase()}`;
    let parentDepartmentId: number | undefined;
    let childDepartmentId: number | undefined;
    let roleId: number | undefined;
    let mappedStaffUserId: number | undefined;
    let provisionedStaffUserId: number | undefined;
    try {
      const unprivilegedRoles = await request(app)
        .get("/api/v1/admin/config/roles")
        .set("Cookie", registrationCookie);
      expect(unprivilegedRoles.status).toBe(403);
      expect(unprivilegedRoles.body.error.code).toBe("FORBIDDEN");

      const hospitalRoleCatalog = await request(app)
        .get("/api/v1/admin/config/roles")
        .set("Cookie", administratorCookie);
      expect(hospitalRoleCatalog.status).toBe(200);
      expect(hospitalRoleCatalog.body.roles).toContainEqual(expect.objectContaining({
        roleCode: "hospital_opd_staff",
        name: "Outpatient Department staff",
        status: "inactive",
        permissionCodes: [],
        departmentAssignments: [],
      }));

      const systemAdminGrant = await request(app)
        .post("/api/v1/admin/users")
        .set("Cookie", administratorCookie)
        .send({
          username: `e2e-admin-${suffix.slice(0, 8)}`,
          displayName: "Rejected E2E Administrator",
          temporaryPassword: "Synthetic-only-password",
          roleCode: "system_admin",
          facilityId,
        });
      expect(systemAdminGrant.status).toBe(403);
      expect(systemAdminGrant.body.error.code).toBe("SYSTEM_ADMIN_REQUIRES_APPROVED_PROCESS");

      const parent = await request(app)
        .post("/api/v1/admin/config/departments")
        .set("Cookie", administratorCookie)
        .send({
          facilityId,
          departmentCode: code,
          name: "Synthetic E2E Unit",
          departmentGroup: "reports",
          unitType: "department",
          parentDepartmentId: null,
          displayOrder: 900,
        });
      expect(parent.status).toBe(201);
      parentDepartmentId = parent.body.departmentId as number;

      const missingHospitalSubgroup = await request(app)
        .post("/api/v1/admin/config/departments")
        .set("Cookie", administratorCookie)
        .send({
          facilityId,
          departmentCode: `${code}_NO_GROUP`,
          name: "Synthetic Hospital Unit Without Subgroup",
        });
      expect(missingHospitalSubgroup.status).toBe(400);

      const createdDepartment = await request(app)
        .get(`/api/v1/admin/config/departments?facilityId=${facilityId}`)
        .set("Cookie", administratorCookie);
      expect(createdDepartment.status).toBe(200);
      expect(createdDepartment.body.departments).toContainEqual(expect.objectContaining({
        department_id: parentDepartmentId,
        department_group: "reports",
      }));

      const child = await request(app)
        .post("/api/v1/admin/config/departments")
        .set("Cookie", administratorCookie)
        .send({
          facilityId,
          departmentCode: `${code}_CHILD`,
          name: "Synthetic E2E Clinic",
          hospitalSubgroup: "outpatient",
          unitType: "clinic",
          parentDepartmentId,
          displayOrder: 901,
        });
      expect(child.status).toBe(201);
      childDepartmentId = child.body.departmentId as number;

      const cycle = await request(app)
        .put(`/api/v1/admin/config/departments/${parentDepartmentId}`)
        .set("Cookie", administratorCookie)
        .send({
          name: "Synthetic E2E Unit",
          departmentGroup: "reports",
          hospitalSubgroup: null,
          unitType: "department",
          parentDepartmentId: childDepartmentId,
          displayOrder: 900,
          status: "active",
        });
      expect(cycle.status).toBe(400);
      expect(cycle.body.error.code).toBe("DEPARTMENT_CYCLE");

      const role = await request(app)
        .post("/api/v1/admin/config/roles")
        .set("Cookie", administratorCookie)
        .send({
          roleCode: `e2e_${suffix.slice(0, 8)}`,
          name: "Synthetic E2E Role",
          description: "Temporary integration-test role",
        });
      expect(role.status).toBe(201);
      roleId = role.body.roleId as number;
      expect(role.body).toMatchObject({ status: "inactive", mfaRequired: true, permissionCodes: [] });

      const bypassActivation = await request(app)
        .put(`/api/v1/admin/config/roles/${roleId}`)
        .set("Cookie", administratorCookie)
        .send({
          name: "Synthetic E2E Role",
          description: "Temporary integration-test role",
          status: "active",
          mfaRequired: true,
        });
      expect(bypassActivation.status).toBe(409);
      expect(bypassActivation.body.error.code).toBe("ROLE_ACTIVATION_REQUIRES_CONFIGURATION");

      const protectedGrant = await request(app)
        .put(`/api/v1/admin/config/roles/${roleId}/activate`)
        .set("Cookie", administratorCookie)
        .send({
          name: "Synthetic E2E Role",
          description: "Temporary integration-test role",
          facilityId,
          departmentIds: [parentDepartmentId],
          permissionCodes: ["security.user.manage"],
        });
      expect(protectedGrant.status).toBe(400);
      expect(protectedGrant.body.error.code).toBe("PROTECTED_PERMISSION");

      const emptyGrants = await request(app)
        .put(`/api/v1/admin/config/roles/${roleId}/activate`)
        .set("Cookie", administratorCookie)
        .send({
          name: "Synthetic E2E Role",
          description: "Temporary integration-test role",
          facilityId,
          departmentIds: [parentDepartmentId],
          permissionCodes: [],
        });
      expect(emptyGrants.status).toBe(400);
      expect(emptyGrants.body.error.code).toBe("INVALID_REQUEST");

      const grants = await request(app)
        .put(`/api/v1/admin/config/roles/${roleId}/activate`)
        .set("Cookie", administratorCookie)
        .send({
          name: "Synthetic E2E Role",
          description: "Temporary integration-test role",
          facilityId,
          departmentIds: [parentDepartmentId],
          permissionCodes: ["patient.mpi.search"],
        });
      expect(grants.status).toBe(200);
      expect(grants.body).toMatchObject({
        status: "active",
        mfaRequired: true,
        permissionCodes: ["patient.mpi.search"],
        departmentIds: [parentDepartmentId],
      });
      const parentDepartmentRoles = await request(app)
        .get(`/api/v1/admin/roles?facilityId=${facilityId}&departmentId=${parentDepartmentId}`)
        .set("Cookie", administratorCookie);
      expect(parentDepartmentRoles.status).toBe(200);
      expect(parentDepartmentRoles.body.roles).toContainEqual(expect.objectContaining({
        roleCode: `e2e_${suffix.slice(0, 8)}`,
        departmentRequired: true,
      }));
      const childDepartmentRoles = await request(app)
        .get(`/api/v1/admin/roles?facilityId=${facilityId}&departmentId=${childDepartmentId}`)
        .set("Cookie", administratorCookie);
      expect(childDepartmentRoles.status).toBe(200);
      expect(childDepartmentRoles.body.roles).not.toContainEqual(expect.objectContaining({
        roleCode: `e2e_${suffix.slice(0, 8)}`,
      }));
      const mismatchedProvisioning = await request(app)
        .post("/api/v1/admin/users")
        .set("Cookie", administratorCookie)
        .send({
          username: `e2e-mismatch-${suffix.slice(0, 8)}`,
          displayName: "Rejected Department Mismatch",
          temporaryPassword: "Synthetic-only-password",
          roleCode: `e2e_${suffix.slice(0, 8)}`,
          facilityId,
          departmentCode: `${code}_CHILD`,
        });
      expect(mismatchedProvisioning.status).toBe(409);
      expect(mismatchedProvisioning.body.error.code).toBe("ROLE_NOT_ASSIGNED_TO_DEPARTMENT");
      const matchingProvisioning = await request(app)
        .post("/api/v1/admin/users")
        .set("Cookie", administratorCookie)
        .send({
          username: `e2e-mapped-${suffix.slice(0, 8)}`,
          displayName: "Mapped E2E Staff",
          temporaryPassword: "Synthetic-only-password",
          roleCode: `e2e_${suffix.slice(0, 8)}`,
          facilityId,
          departmentCode: code,
        });
      expect(matchingProvisioning.status).toBe(201);
      expect(matchingProvisioning.body.user.departmentCode).toBe(code);
      provisionedStaffUserId = matchingProvisioning.body.user.id as number;
      const adminWorkspaces = await request(app)
        .get("/api/v1/departments/workspaces")
        .set("Cookie", administratorCookie);
      expect(adminWorkspaces.status).toBe(200);
      expect(adminWorkspaces.body.administratorView).toBe(true);
      expect(adminWorkspaces.body.workspaces).toEqual(expect.arrayContaining([
        expect.objectContaining({ departmentId: parentDepartmentId, departmentGroup: "reports" }),
        expect.objectContaining({ departmentId: childDepartmentId, departmentGroup: "hospital" }),
        expect.objectContaining({ departmentId: childDepartmentId, hospitalSubgroup: "outpatient" }),
        expect.objectContaining({ departmentCode: "OPD", departmentGroup: "hospital", hospitalSubgroup: "outpatient" }),
        expect.objectContaining({ departmentCode: "LABORATORY", hospitalSubgroup: "diagnostics" }),
        expect.objectContaining({ departmentCode: "STORES", departmentGroup: "inventory" }),
        expect.objectContaining({ departmentCode: "PROCUREMENT", departmentGroup: "procurement" }),
        expect.objectContaining({ departmentCode: "HR", departmentGroup: "hr" }),
        expect.objectContaining({ departmentCode: "FINANCE", departmentGroup: "finance" }),
        expect.objectContaining({ departmentCode: "ICT", departmentGroup: "system_tools" }),
        expect.objectContaining({ departmentCode: "MORTUARY", departmentGroup: "morgue" }),
        expect.objectContaining({ departmentCode: "HMIS", departmentGroup: "reports" }),
      ]));

      const mappedStaff = await createSessionForRole(`e2e_${suffix.slice(0, 8)}`, true, code);
      mappedStaffUserId = mappedStaff.userId;
      const mappedStaffCookie = `imis_session=${mappedStaff.token}`;
      const staffWorkspaces = await request(app)
        .get("/api/v1/departments/workspaces")
        .set("Cookie", mappedStaffCookie);
      expect(staffWorkspaces.status).toBe(200);
      expect(staffWorkspaces.body.administratorView).toBe(false);
      expect(staffWorkspaces.body.workspaces).toHaveLength(1);
      expect(staffWorkspaces.body.workspaces[0]).toMatchObject({
        departmentId: parentDepartmentId,
        departmentGroup: "reports",
        roles: [expect.objectContaining({ roleCode: `e2e_${suffix.slice(0, 8)}` })],
      });
      const forbiddenDepartment = await request(app)
        .get(`/api/v1/departments/workspaces/${facilityId}/${childDepartmentId}`)
        .set("Cookie", mappedStaffCookie);
      expect(forbiddenDepartment.status).toBe(403);

      const invalidDepartmentFilter = await request(app)
        .get(`/api/v1/admin/roles?facilityId=${facilityId}&departmentId=999999999`)
        .set("Cookie", administratorCookie);
      expect(invalidDepartmentFilter.status).toBe(404);
      const provisionableRoles = await request(app)
        .get(`/api/v1/admin/roles?facilityId=${facilityId}`)
        .set("Cookie", administratorCookie);
      expect(provisionableRoles.status).toBe(200);
      expect(provisionableRoles.body.roles).toContainEqual({
        roleCode: `e2e_${suffix.slice(0, 8)}`,
        name: "Synthetic E2E Role",
        mfaRequired: true,
        departmentRequired: true,
      });
    } finally {
      if (mappedStaffUserId !== undefined) {
        await pool.execute("DELETE FROM audit_events WHERE actor_user_id = ?", [mappedStaffUserId]);
        await pool.execute("DELETE FROM sessions WHERE user_id = ?", [mappedStaffUserId]);
        await pool.execute("DELETE FROM user_departments WHERE user_id = ?", [mappedStaffUserId]);
        await pool.execute("DELETE FROM user_facilities WHERE user_id = ?", [mappedStaffUserId]);
        await pool.execute("DELETE FROM user_roles WHERE user_id = ?", [mappedStaffUserId]);
        await pool.execute("DELETE FROM users WHERE user_id = ?", [mappedStaffUserId]);
      }
      if (provisionedStaffUserId !== undefined) {
        await pool.execute("DELETE FROM user_departments WHERE user_id = ?", [provisionedStaffUserId]);
        await pool.execute("DELETE FROM user_facilities WHERE user_id = ?", [provisionedStaffUserId]);
        await pool.execute("DELETE FROM user_roles WHERE user_id = ?", [provisionedStaffUserId]);
        await pool.execute("DELETE FROM users WHERE user_id = ?", [provisionedStaffUserId]);
      }
      if (parentDepartmentId !== undefined) {
        await pool.execute(
          "DELETE FROM department_workflow_tasks WHERE facility_id = ? AND (sending_department_id = ? OR receiving_department_id = ?)",
          [facilityId, parentDepartmentId, parentDepartmentId],
        );
      }
      if (childDepartmentId !== undefined) {
        if (roleId !== undefined) {
          await pool.execute(
            "DELETE FROM department_role_assignments WHERE role_id = ? AND facility_id = ?",
            [roleId, facilityId],
          );
        }
        await pool.execute(
          "DELETE FROM department_workflow_tasks WHERE facility_id = ? AND (sending_department_id = ? OR receiving_department_id = ?)",
          [facilityId, childDepartmentId, childDepartmentId],
        );
        await pool.execute("DELETE FROM departments WHERE department_id = ?", [childDepartmentId]);
      }
      if (parentDepartmentId !== undefined) {
        if (roleId !== undefined) {
          await pool.execute(
            "DELETE FROM department_role_assignments WHERE role_id = ? AND facility_id = ?",
            [roleId, facilityId],
          );
        }
        await pool.execute("DELETE FROM departments WHERE department_id = ?", [parentDepartmentId]);
      }
      if (roleId !== undefined) {
        await pool.execute("DELETE FROM department_role_assignments WHERE role_id = ?", [roleId]);
        await pool.execute("DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
        await pool.execute("DELETE FROM roles WHERE role_id = ?", [roleId]);
      }
    }
  });

  it("allows provisioned staff to set a six-character password", async () => {
    const temporaryPassword = "Synthetic-only-password-2026";
    const newPassword = "Abc123";
    const provisioned = await request(app)
      .post("/api/v1/admin/users")
      .set("Cookie", administratorCookie)
      .send({
        username: `password-change-${randomUUID().slice(0, 8)}`,
        displayName: "Synthetic Password Change Staff",
        temporaryPassword,
        roleCode: "registration_clerk",
        facilityId,
      });
    expect(provisioned.status).toBe(201);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "http://127.0.0.1:5173")
      .send({ username: provisioned.body.user.username, password: temporaryPassword });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(cookie).toBeTruthy();

    const rejectedSamePassword = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie ?? "")
      .send({ currentPassword: temporaryPassword, newPassword: temporaryPassword });
    expect(rejectedSamePassword.status).toBe(400);
    expect(rejectedSamePassword.body.error.fields).toContainEqual({
      field: "new password",
      message: "The new password must be different from the temporary password.",
    });

    const rejectedShortPassword = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie ?? "")
      .send({ currentPassword: temporaryPassword, newPassword: "Ab123" });
    expect(rejectedShortPassword.status).toBe(400);
    expect(rejectedShortPassword.body.error.fields).toContainEqual({
      field: "new password",
      message: "Use at least 6 characters for the new password.",
    });

    const changed = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", cookie ?? "")
      .send({ currentPassword: temporaryPassword, newPassword });
    expect(changed.status).toBe(200);
    expect(changed.body.changed).toBe(true);

    const currentUser = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", cookie ?? "");
    expect(currentUser.status).toBe(200);
    expect(currentUser.body.user.mustChangePassword).toBe(false);
  });

  it("persists one synthetic outpatient visit and enforces role permission boundaries", async () => {
    const registration = await request(app)
      .post("/api/v1/patients")
      .set("Cookie", registrationCookie)
      .send({
        facilityId,
        givenName: `Synthetic${suffix.slice(0, 8)}`,
        familyName: `Integration${suffix.slice(0, 8)}`,
        dateOfBirth,
        sexAtRegistration: "not_recorded",
      });

    expect(registration.status).toBe(201);
    patientId = registration.body.patient.patientId;

    const registrationDeniedForClinicalNotes = await request(app)
      .post(`/api/v1/encounters/${randomUUID()}/notes`)
      .set("Cookie", registrationCookie)
      .set("Idempotency-Key", randomUUID())
      .send({ noteType: "clinical", title: "Test", content: "Synthetic test" });
    expect(registrationDeniedForClinicalNotes.status).toBe(403);

    const encounter = await request(app)
      .post("/api/v1/encounters")
      .set("Cookie", registrationCookie)
      .set("Idempotency-Key", randomUUID())
      .send({ facilityId, patientId, encounterType: "outpatient" });

    expect(encounter.status).toBe(201);
    encounterId = encounter.body.encounter.encounterId;

    const appointmentStaff = await createSessionForRole("department_staff", true, "OPD");
    const appointmentStaffCookie = `imis_session=${appointmentStaff.token}`;
    const appointmentDepartments = await request(app)
      .get(`/api/v1/appointments/facilities/${facilityId}/departments`)
      .set("Cookie", registrationCookie);
    expect(appointmentDepartments.status).toBe(200);
    const outpatientAppointmentDepartment = appointmentDepartments.body.departments
      .find((department: { name: string }) => department.name === "Outpatient Department");
    expect(outpatientAppointmentDepartment).toBeTruthy();
    const appointmentInput = {
      patientId,
      departmentId: outpatientAppointmentDepartment.department_id as number,
      requestedAt: futureEatDateTime(24),
      reason: `Synthetic appointment request ${suffix}`,
    };
    const appointmentKey = randomUUID();
    const appointmentRequest = await request(app)
      .post(`/api/v1/appointments/facilities/${facilityId}/requests`)
      .set("Cookie", registrationCookie)
      .set("Idempotency-Key", appointmentKey)
      .send(appointmentInput);
    expect(appointmentRequest.status).toBe(201);
    expect(appointmentRequest.body.appointment.status).toBe("requested");
    const [appointmentCipherRows] = await pool.execute<RowDataPacket[]>(
      "SELECT reason_ciphertext FROM appointments WHERE appointment_uuid = ?",
      [appointmentRequest.body.appointment.appointmentId],
    );
    expect(Buffer.from(appointmentCipherRows[0].reason_ciphertext).toString("utf8"))
      .not.toContain(appointmentInput.reason);
    const appointmentReplay = await request(app)
      .post(`/api/v1/appointments/facilities/${facilityId}/requests`)
      .set("Cookie", registrationCookie)
      .set("Idempotency-Key", appointmentKey)
      .send(appointmentInput);
    expect(appointmentReplay.status).toBe(200);
    expect(appointmentReplay.body.idempotentReplay).toBe(true);

    const unassignedAppointmentList = await request(app)
      .get(`/api/v1/appointments/facilities/${facilityId}/requests`)
      .set("Cookie", clinicianCookie);
    expect(unassignedAppointmentList.status).toBe(200);
    expect(unassignedAppointmentList.body.appointments).not.toContainEqual(
      expect.objectContaining({ appointmentId: appointmentRequest.body.appointment.appointmentId }),
    );
    const appointmentList = await request(app)
      .get(`/api/v1/appointments/facilities/${facilityId}/requests`)
      .set("Cookie", appointmentStaffCookie);
    expect(appointmentList.status).toBe(200);
    expect(appointmentList.body.appointments).toContainEqual(
      expect.objectContaining({
        appointmentId: appointmentRequest.body.appointment.appointmentId,
        reason: appointmentInput.reason,
        status: "requested",
      }),
    );
    const unauthorizedAppointmentResponse = await request(app)
      .post(`/api/v1/appointments/requests/${appointmentRequest.body.appointment.appointmentId}/respond`)
      .set("Cookie", registrationCookie)
      .send({ action: "confirm" });
    expect(unauthorizedAppointmentResponse.status).toBe(403);
    const appointmentConfirmation = await request(app)
      .post(`/api/v1/appointments/requests/${appointmentRequest.body.appointment.appointmentId}/respond`)
      .set("Cookie", appointmentStaffCookie)
      .send({ action: "confirm" });
    expect(appointmentConfirmation.status).toBe(200);
    expect(appointmentConfirmation.body.appointment.status).toBe("confirmed");
    const appointmentHistory = await request(app)
      .get(`/api/v1/appointments/facilities/${facilityId}/requests`)
      .set("Cookie", appointmentStaffCookie);
    const appointmentHistoryEntry = appointmentHistory.body.appointments
      .find((item: { appointmentId: string }) => item.appointmentId === appointmentRequest.body.appointment.appointmentId);
    expect(appointmentHistoryEntry.events.map((event: { type: string }) => event.type))
      .toEqual(["requested", "confirmed"]);

    const workflowSender = await createSessionForRole("department_staff", true, "OPD");
    const workflowReceiver = await createSessionForRole("department_staff", true, "LABORATORY");
    const unassignedWorkflowStaff = await createSessionForRole("department_staff", true);
    const workflowCookie = `imis_session=${workflowSender.token}`;
    const receiverCookie = `imis_session=${workflowReceiver.token}`;
    const unassignedWorkflowCookie = `imis_session=${unassignedWorkflowStaff.token}`;
    const { departments } = (await request(app)
      .get(`/api/v1/workflow/facilities/${facilityId}/departments`)
      .set("Cookie", workflowCookie)).body as { departments: Array<{ department_id: number; department_code: string; assigned_to_user: boolean }> };
    const outpatientDepartment = departments.find((department) => department.department_code === "OPD");
    const laboratoryDepartment = departments.find((department) => department.department_code === "LABORATORY");
    expect(Boolean(outpatientDepartment?.assigned_to_user)).toBe(true);
    expect(Boolean(laboratoryDepartment?.assigned_to_user)).toBe(false);
    if (!outpatientDepartment || !laboratoryDepartment) throw new Error("Synthetic workflow departments were not seeded.");
    const storeStaff = await createSessionForRole("department_staff", true, "STORES");
    const storeCookie = `imis_session=${storeStaff.token}`;
    const inventoryDepartments = await request(app)
      .get(`/api/v1/inventory/facilities/${facilityId}/departments`)
      .set("Cookie", storeCookie);
    expect(inventoryDepartments.status).toBe(200);
    const storesDepartment = inventoryDepartments.body.departments[0] as { department_id: number } | undefined;
    expect(storesDepartment).toBeTruthy();
    const itemCode = `E2E-${suffix.slice(0, 8).toUpperCase()}`;
    const createdItem = await request(app)
      .post(`/api/v1/inventory/facilities/${facilityId}/departments/${storesDepartment.department_id}/items`)
      .set("Cookie", storeCookie)
      .send({ itemCode, name: `Synthetic gloves ${suffix.slice(0, 8)}`, unitOfMeasure: "box" });
    expect(createdItem.status).toBe(201);
    const inventoryPath = `/api/v1/inventory/facilities/${facilityId}/departments/${storesDepartment.department_id}`;
    const receiptKey = randomUUID();
    const receiptInput = {
      movementType: "receipt",
      inventoryItemId: createdItem.body.item.inventoryItemId,
      batchCode: `B-${suffix.slice(0, 8)}`,
      quantity: 12,
      reference: `Synthetic delivery ${suffix.slice(0, 8)}`,
    };
    const receipt = await request(app)
      .post(`${inventoryPath}/movements`)
      .set("Cookie", storeCookie)
      .set("Idempotency-Key", receiptKey)
      .send(receiptInput);
    expect(receipt.status).toBe(201);
    const receiptReplay = await request(app)
      .post(`${inventoryPath}/movements`)
      .set("Cookie", storeCookie)
      .set("Idempotency-Key", receiptKey)
      .send(receiptInput);
    expect(receiptReplay.status).toBe(200);
    expect(receiptReplay.body.idempotentReplay).toBe(true);
    const issue = await request(app)
      .post(`${inventoryPath}/movements`)
      .set("Cookie", storeCookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        ...receiptInput,
        movementType: "issue",
        quantity: 3,
        reference: `Synthetic issue ${suffix.slice(0, 8)}`,
        issueToDepartmentId: outpatientDepartment.department_id,
      });
    expect(issue.status).toBe(201);
    const overIssue = await request(app)
      .post(`${inventoryPath}/movements`)
      .set("Cookie", storeCookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        ...receiptInput,
        movementType: "issue",
        quantity: 100,
        reference: `Synthetic overissue ${suffix.slice(0, 8)}`,
        issueToDepartmentId: outpatientDepartment.department_id,
      });
    expect(overIssue.status).toBe(409);
    expect(overIssue.body.error.code).toBe("INSUFFICIENT_STOCK");
    const inventorySnapshot = await request(app)
      .get(inventoryPath)
      .set("Cookie", storeCookie);
    expect(inventorySnapshot.status).toBe(200);
    expect(inventorySnapshot.body.items).toContainEqual(expect.objectContaining({
      itemCode,
      lot: expect.objectContaining({ batchCode: receiptInput.batchCode, quantityOnHand: 9 }),
    }));
    const adminDepartments = await request(app)
      .get(`/api/v1/admin/departments?facilityId=${facilityId}`)
      .set("Cookie", administratorCookie);
    expect(adminDepartments.status).toBe(200);
    expect(adminDepartments.body.departments.map((department: { department_code: string }) => department.department_code))
      .toContain("LABORATORY");
    const provisionedDepartmentStaff = await request(app)
      .post("/api/v1/admin/users")
      .set("Cookie", administratorCookie)
      .send({
        username: `workflow-provisioned-${randomUUID().slice(0, 8)}`,
        displayName: "Synthetic Laboratory Staff",
        temporaryPassword: "Synthetic-only-password-2026",
        roleCode: "department_staff",
        departmentCode: "LABORATORY",
        facilityId,
      });
    expect(provisionedDepartmentStaff.status).toBe(201);
    expect(provisionedDepartmentStaff.body.user.departmentCode).toBe("LABORATORY");
    expect(provisionedDepartmentStaff.body.mfaRequired).toBe(true);

    const taskInput = {
      sendingDepartmentId: outpatientDepartment.department_id,
      receivingDepartmentId: laboratoryDepartment.department_id,
      taskType: "diagnostic",
      title: "Synthetic laboratory handover",
      details: `Synthetic workflow payload ${suffix}`,
    };
    const taskKey = randomUUID();
    const createdTask = await request(app)
      .post(`/api/v1/workflow/encounters/${encounterId}/tasks`)
      .set("Cookie", workflowCookie)
      .set("Idempotency-Key", taskKey)
      .send(taskInput);
    expect(createdTask.status).toBe(201);
    expect(createdTask.body.task.details).toBe(taskInput.details);
    const [encryptedTaskRows] = await pool.execute<RowDataPacket[]>(
      "SELECT details_ciphertext FROM department_workflow_tasks WHERE task_uuid = ?",
      [createdTask.body.task.taskId],
    );
    expect(Buffer.from(encryptedTaskRows[0].details_ciphertext).toString("utf8")).not.toContain(taskInput.details);
    const replayedTask = await request(app)
      .post(`/api/v1/workflow/encounters/${encounterId}/tasks`)
      .set("Cookie", workflowCookie)
      .set("Idempotency-Key", taskKey)
      .send(taskInput);
    expect(replayedTask.status).toBe(200);
    expect(replayedTask.body.idempotentReplay).toBe(true);

    const departmentTasks = await request(app)
      .get(`/api/v1/workflow/departments/${laboratoryDepartment.department_id}/tasks?facilityId=${facilityId}`)
      .set("Cookie", receiverCookie);
    expect(departmentTasks.status).toBe(200);
    expect(departmentTasks.body.tasks.map((task: { taskId: string }) => task.taskId)).toContain(createdTask.body.task.taskId);
    const unassignedTaskAccess = await request(app)
      .get(`/api/v1/workflow/departments/${laboratoryDepartment.department_id}/tasks?facilityId=${facilityId}`)
      .set("Cookie", unassignedWorkflowCookie);
    expect(unassignedTaskAccess.status).toBe(403);

    for (const action of ["accept", "start", "complete"]) {
      const transition = await request(app)
        .post(`/api/v1/workflow/tasks/${createdTask.body.task.taskId}/transitions`)
        .set("Cookie", receiverCookie)
        .send({ action });
      expect(transition.status).toBe(200);
      expect(transition.body.task.status).toBe(
        action === "accept" ? "accepted" : action === "start" ? "in_progress" : "completed",
      );
    }
    const eventHistory = await request(app)
      .get(`/api/v1/workflow/tasks/${createdTask.body.task.taskId}`)
      .set("Cookie", receiverCookie);
    expect(eventHistory.status).toBe(200);
    expect(eventHistory.body.events.map((event: { type: string }) => event.type))
      .toEqual(["requested", "accepted", "started", "completed"]);

    const rejectedTask = await request(app)
      .post(`/api/v1/workflow/encounters/${encounterId}/tasks`)
      .set("Cookie", workflowCookie)
      .set("Idempotency-Key", randomUUID())
      .send(taskInput);
    expect(rejectedTask.status).toBe(201);
    const rejected = await request(app)
      .post(`/api/v1/workflow/tasks/${rejectedTask.body.task.taskId}/transitions`)
      .set("Cookie", receiverCookie)
      .send({ action: "reject", note: "Synthetic test rejection reason." });
    expect(rejected.status).toBe(200);
    expect(rejected.body.task.status).toBe("rejected");

    const cancelledTask = await request(app)
      .post(`/api/v1/workflow/encounters/${encounterId}/tasks`)
      .set("Cookie", workflowCookie)
      .set("Idempotency-Key", randomUUID())
      .send(taskInput);
    expect(cancelledTask.status).toBe(201);
    const cancelled = await request(app)
      .post(`/api/v1/workflow/tasks/${cancelledTask.body.task.taskId}/transitions`)
      .set("Cookie", workflowCookie)
      .send({ action: "cancel" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.task.status).toBe("cancelled");

    const clinicianCannotCreateTask = await request(app)
      .post(`/api/v1/workflow/encounters/${encounterId}/tasks`)
      .set("Cookie", clinicianCookie)
      .set("Idempotency-Key", randomUUID())
      .send(taskInput);
    expect(clinicianCannotCreateTask.status).toBe(403);

    const disabledFinance = await request(app)
      .get(`/api/v1/finance/encounters/${encounterId}/charges`)
      .set("Cookie", financeClerkCookie);
    expect(disabledFinance.status).toBe(503);
    expect(disabledFinance.body.error.code).toBe("FINANCE_DISABLED");

    const disabledTriageQueue = await request(app)
      .get(`/api/v1/triage/queue?facilityId=${facilityId}`)
      .set("Cookie", triageNurseCookie);
    expect(disabledTriageQueue.status).toBe(503);

    await pool.execute(
      `UPDATE triage_module_settings
       SET enabled = TRUE, workflow_approval_reference = 'SYNTHETIC_TEST_ONLY',
           approved_by = ?, approved_at = UTC_TIMESTAMP(6)
       WHERE facility_id = ?`,
      [triageApproverId, facilityId],
    );

    const provisionedStaff = await request(app)
      .post("/api/v1/admin/users")
      .set("Cookie", administratorCookie)
      .send({
        username: `triage-provisioned-${randomUUID().slice(0, 8)}`,
        displayName: "Synthetic Triage Staff",
        temporaryPassword: "Synthetic-only-password-2026",
        roleCode: "triage_nurse",
        facilityId,
      });
    expect(provisionedStaff.status).toBe(201);
    expect(provisionedStaff.body.user.departmentCode).toBe("TRIAGE");
    const [provisionedRows] = await pool.execute<RowDataPacket[]>(
      `SELECT u.must_change_password, COUNT(ud.user_id) AS department_count
       FROM users u
       LEFT JOIN user_departments ud ON ud.user_id = u.user_id
       WHERE u.user_id = ? GROUP BY u.user_id`,
      [provisionedStaff.body.user.id],
    );
    expect(Number(provisionedRows[0]?.must_change_password)).toBe(1);
    expect(Number(provisionedRows[0]?.department_count)).toBe(1);

    const provisionedStaffLogin = await request(app)
      .post("/api/v1/auth/login")
      .set("Origin", "http://127.0.0.1:5173")
      .send({
        username: provisionedStaff.body.user.username,
        password: "Synthetic-only-password-2026",
      });
    expect(provisionedStaffLogin.status).toBe(200);
    const staffCookie = provisionedStaffLogin.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(staffCookie).toBeTruthy();
    const staffSessionBeforeChange = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", staffCookie ?? "");
    expect(staffSessionBeforeChange.status).toBe(200);
    expect(staffSessionBeforeChange.body.user.mustChangePassword).toBe(true);

    const passwordChange = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Cookie", staffCookie ?? "")
      .send({
        currentPassword: "Synthetic-only-password-2026",
        newPassword: "Abc123",
      });
    expect(passwordChange.status).toBe(200);
    expect(passwordChange.body.changed).toBe(true);

    const staffSessionAfterChange = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", staffCookie ?? "");
    expect(staffSessionAfterChange.status).toBe(200);
    expect(staffSessionAfterChange.body.user.mustChangePassword).toBe(false);

    const provisionedFinanceStaff = await request(app)
      .post("/api/v1/admin/users")
      .set("Cookie", administratorCookie)
      .send({
        username: `finance-provisioned-${randomUUID().slice(0, 8)}`,
        displayName: "Synthetic Finance Biller",
        temporaryPassword: "Synthetic-only-password-2026",
        roleCode: "finance_biller",
        facilityId,
      });
    expect(provisionedFinanceStaff.status).toBe(201);
    expect(provisionedFinanceStaff.body.user.departmentCode).toBe("FINANCE");
    expect(provisionedFinanceStaff.body.mfaRequired).toBe(true);
    const [provisionedFinanceRows] = await pool.execute<RowDataPacket[]>(
      `SELECT u.must_change_password, COUNT(ud.user_id) AS department_count
       FROM users u
       LEFT JOIN user_departments ud ON ud.user_id = u.user_id
       WHERE u.user_id = ? GROUP BY u.user_id`,
      [provisionedFinanceStaff.body.user.id],
    );
    expect(Number(provisionedFinanceRows[0]?.must_change_password)).toBe(1);
    expect(Number(provisionedFinanceRows[0]?.department_count)).toBe(1);

    const unassignedTriage = await request(app)
      .get(`/api/v1/triage/queue?facilityId=${facilityId}`)
      .set("Cookie", unassignedTriageNurseCookie);
    expect(unassignedTriage.status).toBe(403);
    expect(unassignedTriage.body.error.code).toBe("DEPARTMENT_ACCESS_DENIED");

    const registrationDeniedTriage = await request(app)
      .post(`/api/v1/triage/encounters/${encounterId}/assessments`)
      .set("Cookie", registrationCookie)
      .set("Idempotency-Key", randomUUID())
      .send({ pulseBpm: 72 });
    expect(registrationDeniedTriage.status).toBe(403);

    const triageKey = randomUUID();
    const triageCapture = await request(app)
      .post(`/api/v1/triage/encounters/${encounterId}/assessments`)
      .set("Cookie", triageNurseCookie)
      .set("Idempotency-Key", triageKey)
      .send({
        systolicBpMmhg: 120,
        diastolicBpMmhg: 80,
        pulseBpm: 72,
        respiratoryRateBpm: 16,
        temperatureCelsius: 36.8,
        oxygenSaturationPercent: 98,
      });
    expect(triageCapture.status).toBe(201);
    expect(triageCapture.body).not.toHaveProperty("acuity");
    const triageId = triageCapture.body.triageId as string;

    const triageQueue = await request(app)
      .get(`/api/v1/triage/queue?facilityId=${facilityId}`)
      .set("Cookie", triageNurseCookie);
    expect(triageQueue.status).toBe(200);
    expect(triageQueue.body.assessments).toHaveLength(1);

    const triageNurseCannotReview = await request(app)
      .post(`/api/v1/triage/assessments/${triageId}/review`)
      .set("Cookie", triageNurseCookie)
      .send({});
    expect(triageNurseCannotReview.status).toBe(403);

    const genericClinicianCannotReviewTriage = await request(app)
      .post(`/api/v1/triage/assessments/${triageId}/review`)
      .set("Cookie", clinicianCookie)
      .send({});
    expect(genericClinicianCannotReviewTriage.status).toBe(403);

    const triageReview = await request(app)
      .post(`/api/v1/triage/assessments/${triageId}/review`)
      .set("Cookie", triageClinicianCookie)
      .send({});
    expect(triageReview.status).toBe(200);
    expect(triageReview.body.status).toBe("reviewed");

    const triageReplay = await request(app)
      .post(`/api/v1/triage/encounters/${encounterId}/assessments`)
      .set("Cookie", triageNurseCookie)
      .set("Idempotency-Key", triageKey)
      .send({
        systolicBpMmhg: 120,
        diastolicBpMmhg: 80,
        pulseBpm: 72,
        respiratoryRateBpm: 16,
        temperatureCelsius: 36.8,
        oxygenSaturationPercent: 98,
      });
    expect(triageReplay.status).toBe(200);
    expect(triageReplay.body.idempotentReplay).toBe(true);

    await pool.execute(
      `UPDATE finance_module_settings
       SET enabled = TRUE, workflow_approval_reference = 'SYNTHETIC_TEST_ONLY',
           approved_by = ?, approved_at = UTC_TIMESTAMP(6)
       WHERE facility_id = ?`,
      [administratorId, facilityId],
    );

    const financeKey = randomUUID();
    const chargePayload = {
      chargeCode: "SYNTHETIC-CONSULT",
      description: "Synthetic consultation charge for integration test",
      amount: "1250.50",
      currencyCode: "KES",
    };
    const charge = await request(app)
      .post(`/api/v1/finance/encounters/${encounterId}/charges`)
      .set("Cookie", financeClerkCookie)
      .set("Idempotency-Key", financeKey)
      .send(chargePayload);
    expect(charge.status).toBe(201);
    expect(charge.body.charge.amount).toBe("1250.50");
    expect(charge.body.charge.status).toBe("unbilled");

    const chargeReplay = await request(app)
      .post(`/api/v1/finance/encounters/${encounterId}/charges`)
      .set("Cookie", financeClerkCookie)
      .set("Idempotency-Key", financeKey)
      .send(chargePayload);
    expect(chargeReplay.status).toBe(200);
    expect(chargeReplay.body.idempotentReplay).toBe(true);

    const financeClerkCannotIssueInvoice = await request(app)
      .post(`/api/v1/finance/encounters/${encounterId}/invoices`)
      .set("Cookie", financeClerkCookie)
      .set("Idempotency-Key", randomUUID())
      .send({ currencyCode: "KES" });
    expect(financeClerkCannotIssueInvoice.status).toBe(403);

    const financeBillerCannotRecordCharge = await request(app)
      .post(`/api/v1/finance/encounters/${encounterId}/charges`)
      .set("Cookie", financeBillerCookie)
      .set("Idempotency-Key", randomUUID())
      .send(chargePayload);
    expect(financeBillerCannotRecordCharge.status).toBe(403);

    const financeInvoiceKey = randomUUID();
    const invoice = await request(app)
      .post(`/api/v1/finance/encounters/${encounterId}/invoices`)
      .set("Cookie", financeBillerCookie)
      .set("Idempotency-Key", financeInvoiceKey)
      .send({ currencyCode: "KES" });
    expect(invoice.status).toBe(201);
    expect(invoice.body.invoice.subtotalAmount).toBe("1250.50");
    expect(invoice.body.invoice.lines).toHaveLength(1);
    const invoiceId = invoice.body.invoice.invoiceId as string;

    const invoiceReplay = await request(app)
      .post(`/api/v1/finance/encounters/${encounterId}/invoices`)
      .set("Cookie", financeBillerCookie)
      .set("Idempotency-Key", financeInvoiceKey)
      .send({ currencyCode: "KES" });
    expect(invoiceReplay.status).toBe(200);
    expect(invoiceReplay.body.idempotentReplay).toBe(true);

    const unassignedFinanceDenied = await request(app)
      .get(`/api/v1/finance/encounters/${encounterId}/charges`)
      .set("Cookie", unassignedFinanceClerkCookie);
    expect(unassignedFinanceDenied.status).toBe(403);
    expect(unassignedFinanceDenied.body.error.code).toBe("DEPARTMENT_ACCESS_DENIED");

    const genericClinicianCannotReadFinance = await request(app)
      .get(`/api/v1/finance/encounters/${encounterId}/charges`)
      .set("Cookie", clinicianCookie);
    expect(genericClinicianCannotReadFinance.status).toBe(403);

    const financeClerkCannotAdjust = await request(app)
      .post(`/api/v1/finance/invoices/${invoiceId}/adjustments`)
      .set("Cookie", financeClerkCookie)
      .set("Idempotency-Key", randomUUID())
      .send({ adjustmentType: "credit", amount: "100.00", reason: "Synthetic test adjustment reason" });
    expect(financeClerkCannotAdjust.status).toBe(403);

    const adjustmentKey = randomUUID();
    const adjustmentPayload = {
      adjustmentType: "credit",
      amount: "100.00",
      reason: "Synthetic test adjustment reason",
    };
    const adjustment = await request(app)
      .post(`/api/v1/finance/invoices/${invoiceId}/adjustments`)
      .set("Cookie", financeSupervisorCookie)
      .set("Idempotency-Key", adjustmentKey)
      .send(adjustmentPayload);
    expect(adjustment.status).toBe(201);
    expect(adjustment.body.invoice.adjustmentNetAmount).toBe("-100.00");
    expect(adjustment.body.invoice.totalAmount).toBe("1150.50");

    const adjustmentReplay = await request(app)
      .post(`/api/v1/finance/invoices/${invoiceId}/adjustments`)
      .set("Cookie", financeSupervisorCookie)
      .set("Idempotency-Key", adjustmentKey)
      .send(adjustmentPayload);
    expect(adjustmentReplay.status).toBe(200);
    expect(adjustmentReplay.body.idempotentReplay).toBe(true);

    const [financeRows] = await pool.execute<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM finance_charges WHERE facility_id = ? AND encounter_id = e.encounter_id) AS charge_count,
         (SELECT COUNT(*) FROM finance_invoice_lines WHERE facility_id = ? AND invoice_id = i.invoice_id) AS invoice_line_count,
         c.description_ciphertext AS encrypted_description,
         a.reason_ciphertext AS encrypted_adjustment_reason
       FROM encounters e
       JOIN finance_invoices i ON i.encounter_id = e.encounter_id AND i.facility_id = e.facility_id
       JOIN finance_charges c ON c.encounter_id = e.encounter_id AND c.facility_id = e.facility_id
       JOIN finance_adjustments a ON a.invoice_id = i.invoice_id AND a.facility_id = i.facility_id
       WHERE e.encounter_uuid = ? AND e.facility_id = ? LIMIT 1`,
      [facilityId, facilityId, encounterId, facilityId],
    );
    expect(Number(financeRows[0]?.charge_count)).toBe(1);
    expect(Number(financeRows[0]?.invoice_line_count)).toBe(1);
    expect(financeRows[0]?.encrypted_description.toString("utf8")).not.toContain(chargePayload.description);
    expect(financeRows[0]?.encrypted_adjustment_reason.toString("utf8")).not.toContain(adjustmentPayload.reason);

    const clinicianDeniedForPatientRegistration = await request(app)
      .post("/api/v1/patients")
      .set("Cookie", clinicianCookie)
      .send({
        facilityId,
        givenName: `Unapproved${suffix.slice(0, 8)}`,
        familyName: "IntegrationTest",
        dateOfBirth: "1990-01-01",
        sexAtRegistration: "not_recorded",
      });
    expect(clinicianDeniedForPatientRegistration.status).toBe(403);

    const observations = await request(app)
      .post(`/api/v1/encounters/${encounterId}/observations`)
      .set("Cookie", clinicianCookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        systolicBpMmhg: 120,
        diastolicBpMmhg: 80,
        pulseBpm: 72,
        respiratoryRateBpm: 16,
        temperatureCelsius: 36.8,
        oxygenSaturationPercent: 98,
      });
    expect(observations.status).toBe(201);

    const note = await request(app)
      .post(`/api/v1/encounters/${encounterId}/notes`)
      .set("Cookie", clinicianCookie)
      .set("Idempotency-Key", randomUUID())
      .send({
        noteType: "clinical",
        title: "Synthetic integration test",
        content: "Synthetic test record only; not a clinical assessment.",
      });
    expect(note.status).toBe(201);

    const registrationCannotReadSharedClinicalContext = await request(app)
      .get(`/api/v1/encounters/${encounterId}/care-context`)
      .set("Cookie", registrationCookie);
    expect(registrationCannotReadSharedClinicalContext.status).toBe(403);

    const clinicianContext = await request(app)
      .get(`/api/v1/encounters/${encounterId}/care-context`)
      .set("Cookie", clinicianCookie);
    expect(clinicianContext.status).toBe(200);
    expect(clinicianContext.body.patient.recordNumber).toBe(registration.body.patient.recordNumber);
    expect(clinicianContext.body.encounters).toHaveLength(1);
    expect(clinicianContext.body.encounters[0].observations).toHaveLength(2);
    expect(clinicianContext.body).not.toHaveProperty("notes");
    expect(clinicianContext.body.sections).toContain("observations");
    expect(clinicianContext.body.sections).not.toContain("diagnostics");
    expect(clinicianContext.body.sections).not.toContain("inpatient");

    const triageContext = await request(app)
      .get(`/api/v1/encounters/${encounterId}/care-context`)
      .set("Cookie", triageNurseCookie);
    expect(triageContext.status).toBe(200);
    expect(triageContext.body.encounters[0].observations).toHaveLength(2);
    expect(triageContext.body.encounters[0].triageAssessments).toHaveLength(1);
    expect(triageContext.body.encounters[0].triageAssessments[0].status).toBe("reviewed");
    expect(triageContext.body.sections).toEqual(expect.arrayContaining(["observations", "triage"]));

    const financeCannotReadClinicalContext = await request(app)
      .get(`/api/v1/encounters/${encounterId}/care-context`)
      .set("Cookie", financeClerkCookie);
    expect(financeCannotReadClinicalContext.status).toBe(403);

    const [patientRows] = await pool.execute<PatientRow[]>(
      "SELECT COUNT(*) AS patient_count FROM patients WHERE patient_id = ? AND facility_id = ?",
      [patientId, facilityId],
    );
    const [clinicalRows] = await pool.execute<ClinicalRows[]>(
      `SELECT
         (SELECT COUNT(*) FROM encounter_observations WHERE encounter_id = e.encounter_id) AS observation_count,
         (SELECT COUNT(*) FROM encounter_notes WHERE encounter_id = e.encounter_id) AS note_count,
         n.content_ciphertext AS encrypted_content
       FROM encounters e
       JOIN encounter_notes n ON n.encounter_id = e.encounter_id AND n.facility_id = e.facility_id
       WHERE e.encounter_uuid = ? AND e.facility_id = ?
       ORDER BY n.note_id DESC LIMIT 1`,
      [encounterId, facilityId],
    );

    expect(Number(patientRows[0]?.patient_count)).toBe(1);
    expect(Number(clinicalRows[0]?.observation_count)).toBe(2);
    expect(Number(clinicalRows[0]?.note_count)).toBe(1);
    expect(clinicalRows[0]?.encrypted_content.toString("utf8"))
      .not.toContain("not a clinical assessment");
  });
});

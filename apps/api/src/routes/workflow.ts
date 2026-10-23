import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessDepartment, canAccessFacility } from "../security/access-control.js";
import { decryptData, encryptData, isDataEncryptionConfigured } from "../security/data-encryption.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  workflowEncounterIdSchema,
  workflowIdempotencyKeySchema,
  workflowTaskIdSchema,
  workflowTaskSchema,
  workflowTransitionSchema,
} from "../validation/workflow.js";

type WorkflowStatus = "requested" | "accepted" | "in_progress" | "completed" | "rejected" | "cancelled";
type WorkflowAction = "accept" | "reject" | "start" | "complete" | "cancel";

interface TaskRow extends RowDataPacket {
  task_id: number;
  task_uuid: string;
  facility_id: number;
  encounter_id: number;
  encounter_uuid: string;
  record_number: string;
  idempotency_key: string;
  task_type: "consultation" | "diagnostic" | "medication" | "procedure" | "referral" | "handover" | "other";
  title: string;
  details_ciphertext: Buffer;
  sending_department_id: number;
  sending_department_code: string;
  receiving_department_id: number;
  receiving_department_code: string;
  status: WorkflowStatus;
  requested_by: number;
  requester_name: string;
  requested_at: Date;
  responded_by: number | null;
  responder_name: string | null;
  responded_at: Date | null;
  completed_by: number | null;
  completer_name: string | null;
  completed_at: Date | null;
}

interface DepartmentRow extends RowDataPacket {
  department_id: number;
  department_code: string;
  status: "active" | "inactive";
}

interface AssignmentRow extends RowDataPacket {
  department_id: number;
}

interface TaskEventRow extends RowDataPacket {
  event_type: string;
  previous_status: WorkflowStatus | null;
  new_status: WorkflowStatus;
  note_ciphertext: Buffer | null;
  actor_name: string;
  occurred_at: Date;
}

const taskSelect = `SELECT t.task_id, t.task_uuid, t.facility_id, t.encounter_id,
  e.encounter_uuid, p.record_number, t.idempotency_key, t.task_type, t.title,
  t.details_ciphertext, t.sending_department_id, sd.department_code AS sending_department_code,
  t.receiving_department_id, rd.department_code AS receiving_department_code, t.status,
  t.requested_by, requester.display_name AS requester_name, t.requested_at,
  t.responded_by, responder.display_name AS responder_name, t.responded_at,
  t.completed_by, completer.display_name AS completer_name, t.completed_at
  FROM department_workflow_tasks t
  JOIN encounters e ON e.encounter_id = t.encounter_id AND e.facility_id = t.facility_id
  JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
  JOIN departments sd ON sd.department_id = t.sending_department_id AND sd.facility_id = t.facility_id
  JOIN departments rd ON rd.department_id = t.receiving_department_id AND rd.facility_id = t.facility_id
  JOIN users requester ON requester.user_id = t.requested_by
  LEFT JOIN users responder ON responder.user_id = t.responded_by
  LEFT JOIN users completer ON completer.user_id = t.completed_by`;

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function serializeTask(row: TaskRow) {
  return {
    taskId: row.task_uuid,
    encounterId: row.encounter_uuid,
    recordNumber: row.record_number,
    taskType: row.task_type,
    title: row.title,
    details: decryptData(row.details_ciphertext),
    sendingDepartment: row.sending_department_code,
    receivingDepartment: row.receiving_department_code,
    status: row.status,
    requestedBy: row.requester_name,
    requestedAt: new Date(row.requested_at).toISOString(),
    respondedBy: row.responder_name,
    respondedAt: row.responded_at ? new Date(row.responded_at).toISOString() : null,
    completedBy: row.completer_name,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

async function loadTask(
  executor: PoolConnection | typeof pool,
  taskUuid: string,
  lock = false,
): Promise<TaskRow | null> {
  const [rows] = await executor.execute<TaskRow[]>(
    `${taskSelect}
     WHERE t.task_uuid = ?
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [taskUuid],
  );
  return rows[0] ?? null;
}

async function departmentIsAssigned(
  executor: PoolConnection | typeof pool,
  req: Request,
  res: Response,
  facilityId: number,
  departmentId: number,
): Promise<boolean> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return false;
  }
  const [rows] = await executor.execute<AssignmentRow[]>(
    `SELECT department_id FROM user_departments
     WHERE user_id = ? AND facility_id = ? AND department_id = ?
     LIMIT 1`,
    [principal.userId, facilityId, departmentId],
  );
  if (rows.length > 0 && canAccessDepartment(principal, facilityId, departmentId)) return true;
  await writeAuditEvent({
    actorUserId: principal.userId,
    action: "workflow.department_access",
    resourceType: "department",
    resourceId: String(departmentId),
    outcome: "denied",
    ipAddress: req.ip,
  });
  respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to this workflow department.");
  return false;
}

export const workflowRouter = Router();
workflowRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
workflowRouter.use(requireSession);

workflowRouter.get(
  "/facilities/:facilityId/departments",
  requirePermission("workflow.task.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const facilityId = Number(req.params.facilityId);
    if (!Number.isSafeInteger(facilityId) || facilityId < 1) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid facility identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!canAccessFacility(principal, facilityId)) {
      respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
      return;
    }
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT d.department_id, d.department_code, d.name,
                IF(ud.user_id IS NULL, FALSE, TRUE) AS assigned_to_user
         FROM departments d
         LEFT JOIN user_departments ud
           ON ud.facility_id = d.facility_id AND ud.department_id = d.department_id
           AND ud.user_id = ?
         WHERE d.facility_id = ? AND d.status = 'active'
         ORDER BY d.name
         LIMIT 100`,
        [principal.userId, facilityId],
      );
      res.json({ departments: rows });
    } catch (error) {
      next(error);
    }
  },
);

workflowRouter.get(
  "/departments/:departmentId/tasks",
  requirePermission("workflow.task.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const departmentId = Number(req.params.departmentId);
    const facilityId = Number(req.query.facilityId);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const validStatuses: WorkflowStatus[] = ["requested", "accepted", "in_progress", "completed", "rejected", "cancelled"];
    if (!Number.isSafeInteger(departmentId) || departmentId < 1 ||
        !Number.isSafeInteger(facilityId) || facilityId < 1 ||
        (status !== undefined && !validStatuses.includes(status as WorkflowStatus))) {
      respondError(res, 400, "INVALID_REQUEST", "Choose a valid facility, department, and optional task status.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!canAccessFacility(principal, facilityId)) {
      respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
      return;
    }
    try {
      if (!await departmentIsAssigned(pool, req, res, facilityId, departmentId)) return;
      if (!isDataEncryptionConfigured()) {
        respondError(res, 503, "WORKFLOW_DATA_KEY_REQUIRED", "Workflow encryption is not configured.");
        return;
      }
      const [rows] = await pool.execute<TaskRow[]>(
        `${taskSelect}
         WHERE t.facility_id = ? AND
           (t.sending_department_id = ? OR t.receiving_department_id = ?)
           ${status ? "AND t.status = ?" : ""}
         ORDER BY t.requested_at DESC, t.task_id DESC
         LIMIT 101`,
        status
          ? [facilityId, departmentId, departmentId, status]
          : [facilityId, departmentId, departmentId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "workflow.task.list",
        resourceType: "department",
        resourceId: String(departmentId),
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        tasks: rows.slice(0, 100).map(serializeTask),
        truncated: rows.length > 100,
      });
    } catch (error) {
      next(error);
    }
  },
);

workflowRouter.get(
  "/encounters/:encounterId/tasks",
  requirePermission("workflow.task.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const encounterId = workflowEncounterIdSchema.safeParse(req.params.encounterId);
    if (!encounterId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "WORKFLOW_DATA_KEY_REQUIRED", "Workflow encryption is not configured.");
      return;
    }
    try {
      const [rows] = await pool.execute<TaskRow[]>(
        `${taskSelect}
         WHERE e.encounter_uuid = ? AND p.status = 'active'
           AND t.facility_id IN (${[...principal.facilityIds].map(() => "?").join(", ") || "NULL"})
           AND EXISTS (
             SELECT 1 FROM user_departments ud
             WHERE ud.user_id = ? AND ud.facility_id = t.facility_id
               AND ud.department_id IN (t.sending_department_id, t.receiving_department_id)
           )
         ORDER BY t.requested_at DESC, t.task_id DESC
         LIMIT 100`,
        [encounterId.data, ...principal.facilityIds, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "workflow.task.read",
        resourceType: "encounter",
        resourceId: encounterId.data,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({ tasks: rows.map(serializeTask), truncated: false });
    } catch (error) {
      next(error);
    }
  },
);

workflowRouter.get(
  "/tasks/:taskId",
  requirePermission("workflow.task.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const taskId = workflowTaskIdSchema.safeParse(req.params.taskId);
    if (!taskId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid task identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "WORKFLOW_DATA_KEY_REQUIRED", "Workflow encryption is not configured.");
      return;
    }
    try {
      const task = await loadTask(pool, taskId.data);
      if (!task || !canAccessFacility(principal, Number(task.facility_id))) {
        respondError(res, 404, "WORKFLOW_TASK_NOT_FOUND", "The workflow task was not found.");
        return;
      }
      const canReadTask = canAccessDepartment(principal, Number(task.facility_id), Number(task.sending_department_id)) ||
        canAccessDepartment(principal, Number(task.facility_id), Number(task.receiving_department_id));
      if (!canReadTask) {
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "workflow.task.read",
          resourceType: "workflow_task",
          resourceId: task.task_uuid,
          outcome: "denied",
          ipAddress: req.ip,
        });
        respondError(res, 404, "WORKFLOW_TASK_NOT_FOUND", "The workflow task was not found.");
        return;
      }
      const [events] = await pool.execute<TaskEventRow[]>(
        `SELECT e.event_type, e.previous_status, e.new_status, e.note_ciphertext,
                u.display_name AS actor_name, e.occurred_at
         FROM department_workflow_task_events e
         JOIN users u ON u.user_id = e.actor_user_id
         WHERE e.facility_id = ? AND e.task_id = ?
         ORDER BY e.occurred_at, e.task_event_id`,
        [task.facility_id, task.task_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "workflow.task.read",
        resourceType: "workflow_task",
        resourceId: task.task_uuid,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        task: serializeTask(task),
        events: events.map((event) => ({
          type: event.event_type,
          previousStatus: event.previous_status,
          status: event.new_status,
          note: event.note_ciphertext ? decryptData(event.note_ciphertext) : null,
          actor: event.actor_name,
          occurredAt: new Date(event.occurred_at).toISOString(),
        })),
      });
    } catch (error) {
      next(error);
    }
  },
);

workflowRouter.post(
  "/encounters/:encounterId/tasks",
  requirePermission("workflow.task.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const encounterId = workflowEncounterIdSchema.safeParse(req.params.encounterId);
    const input = workflowTaskSchema.safeParse(req.body);
    const idempotencyKey = workflowIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!encounterId.success || !input.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid task details and an Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "WORKFLOW_DATA_KEY_REQUIRED", "Workflow encryption is not configured.");
      return;
    }

    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [encounters] = await connection.execute<RowDataPacket[]>(
        `SELECT e.encounter_id, e.facility_id, e.status
         FROM encounters e
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         WHERE e.encounter_uuid = ? AND p.status = 'active'
         LIMIT 1 FOR UPDATE`,
        [encounterId.data],
      );
      const encounter = encounters[0];
      if (!encounter) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "ENCOUNTER_NOT_FOUND", "The active encounter was not found.");
        return;
      }
      const facilityId = Number(encounter.facility_id);
      if (!canAccessFacility(principal, facilityId)) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
        return;
      }
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "A workflow task can only be created for an open encounter.");
        return;
      }
      if (!await departmentIsAssigned(
        connection,
        req,
        res,
        facilityId,
        input.data.sendingDepartmentId,
      )) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      const [departments] = await connection.execute<DepartmentRow[]>(
        `SELECT department_id, department_code, status
         FROM departments
         WHERE facility_id = ? AND department_id IN (?, ?)
         FOR UPDATE`,
        [facilityId, input.data.sendingDepartmentId, input.data.receivingDepartmentId],
      );
      const sendingDepartment = departments.find((department) =>
        Number(department.department_id) === input.data.sendingDepartmentId);
      const receivingDepartment = departments.find((department) =>
        Number(department.department_id) === input.data.receivingDepartmentId);
      if (!sendingDepartment || sendingDepartment.status !== "active" ||
          !receivingDepartment || receivingDepartment.status !== "active") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "DEPARTMENT_NOT_FOUND", "Both workflow departments must be active at this facility.");
        return;
      }
      const [existingRows] = await connection.execute<TaskRow[]>(
        `${taskSelect}
         WHERE t.facility_id = ? AND t.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [facilityId, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = Number(existing.encounter_id) === Number(encounter.encounter_id) &&
          Number(existing.requested_by) === principal.userId &&
          Number(existing.sending_department_id) === input.data.sendingDepartmentId &&
          Number(existing.receiving_department_id) === input.data.receivingDepartmentId &&
          existing.task_type === input.data.taskType &&
          existing.title === input.data.title &&
          decryptData(existing.details_ciphertext) === input.data.details;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different task.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "workflow.task.idempotent_replay",
          resourceType: "workflow_task",
          resourceId: existing.task_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({ task: serializeTask(existing), idempotentReplay: true });
        return;
      }

      const taskUuid = randomUUID();
      const [inserted] = await connection.execute<ResultSetHeader>(
        `INSERT INTO department_workflow_tasks
          (task_uuid, facility_id, encounter_id, idempotency_key, task_type, title,
           details_ciphertext, sending_department_id, receiving_department_id,
           status, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, UTC_TIMESTAMP(6))`,
        [
          taskUuid, facilityId, encounter.encounter_id, idempotencyKey.data,
          input.data.taskType, input.data.title, encryptData(input.data.details),
          input.data.sendingDepartmentId, input.data.receivingDepartmentId, principal.userId,
        ],
      );
      await connection.execute(
        `INSERT INTO department_workflow_task_events
          (task_id, facility_id, event_type, previous_status, new_status, note_ciphertext,
           actor_user_id, occurred_at)
         VALUES (?, ?, 'requested', NULL, 'requested', NULL, ?, UTC_TIMESTAMP(6))`,
        [inserted.insertId, facilityId, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "workflow.task.create",
        resourceType: "workflow_task",
        resourceId: taskUuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const task = await loadTask(connection, taskUuid);
      if (!task) throw new Error("The newly created workflow task could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ task: serializeTask(task), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
        respondError(res, 409, "WORKFLOW_TASK_CONFLICT", "This task request identity already exists; reload and retry.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

workflowRouter.post(
  "/tasks/:taskId/transitions",
  requirePermission("workflow.task.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const taskId = workflowTaskIdSchema.safeParse(req.params.taskId);
    const input = workflowTransitionSchema.safeParse(req.body);
    if (!taskId.success || !input.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid task and allowed transition.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    const transitionPermission = input.data.action === "cancel"
      ? "workflow.task.create"
      : "workflow.task.respond";
    if (!principal.permissions.has(transitionPermission)) {
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "authorization.permission",
        resourceType: "workflow_task",
        resourceId: transitionPermission,
        outcome: "denied",
        ipAddress: req.ip,
      });
      respondError(res, 403, "FORBIDDEN", "You are not authorized to respond to workflow tasks.");
      return;
    }

    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const task = await loadTask(connection, taskId.data, true);
      if (!task) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "WORKFLOW_TASK_NOT_FOUND", "The workflow task was not found.");
        return;
      }
      if (!canAccessFacility(principal, Number(task.facility_id))) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
        return;
      }
      const receivingAction = input.data.action !== "cancel";
      const departmentId = receivingAction
        ? Number(task.receiving_department_id)
        : Number(task.sending_department_id);
      if (!await departmentIsAssigned(connection, req, res, Number(task.facility_id), departmentId)) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      const transitions: Record<WorkflowAction, { from: WorkflowStatus[]; to: WorkflowStatus; event: string }> = {
        accept: { from: ["requested"], to: "accepted", event: "accepted" },
        reject: { from: ["requested"], to: "rejected", event: "rejected" },
        start: { from: ["accepted"], to: "in_progress", event: "started" },
        complete: { from: ["accepted", "in_progress"], to: "completed", event: "completed" },
        cancel: { from: ["requested"], to: "cancelled", event: "cancelled" },
      };
      const transition = transitions[input.data.action];
      if (!transition.from.includes(task.status)) {
        await connection.rollback();
        transactionStarted = false;
        const transitionVerb: Record<WorkflowAction, string> = {
          accept: "accepted",
          reject: "rejected",
          start: "started",
          complete: "completed",
          cancel: "cancelled",
        };
        respondError(res, 409, "INVALID_TASK_TRANSITION", `A task in ${task.status} cannot be ${transitionVerb[input.data.action]}.`);
        return;
      }
      if (!isDataEncryptionConfigured()) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 503, "WORKFLOW_DATA_KEY_REQUIRED", "Workflow encryption is not configured.");
        return;
      }
      const responded = task.responded_by === null;
      await connection.execute(
        `UPDATE department_workflow_tasks
         SET status = ?, responded_by = IF(? = 1, ?, responded_by),
             responded_at = IF(? = 1, UTC_TIMESTAMP(6), responded_at),
             completed_by = IF(? = 1, ?, completed_by),
             completed_at = IF(? = 1, UTC_TIMESTAMP(6), completed_at)
         WHERE task_id = ? AND facility_id = ?`,
        [
          transition.to, Number(responded), principal.userId, Number(responded),
          Number(["completed", "rejected", "cancelled"].includes(transition.to)), principal.userId,
          Number(["completed", "rejected", "cancelled"].includes(transition.to)),
          task.task_id, task.facility_id,
        ],
      );
      await connection.execute(
        `INSERT INTO department_workflow_task_events
          (task_id, facility_id, event_type, previous_status, new_status, note_ciphertext,
           actor_user_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          task.task_id, task.facility_id, transition.event, task.status, transition.to,
          input.data.note ? encryptData(input.data.note) : null, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: `workflow.task.${input.data.action}`,
        resourceType: "workflow_task",
        resourceId: task.task_uuid,
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const updated = await loadTask(connection, task.task_uuid);
      if (!updated) throw new Error("The transitioned workflow task could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.json({ task: serializeTask(updated) });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);

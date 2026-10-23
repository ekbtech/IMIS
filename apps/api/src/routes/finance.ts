import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessDepartment, canAccessFacility } from "../security/access-control.js";
import { decryptData, encryptData, isDataEncryptionConfigured } from "../security/data-encryption.js";
import { writeAuditEvent } from "../security/audit.js";
import { sumMoneyAmounts } from "../finance/money.js";
import {
  financeAdjustmentSchema,
  financeChargeSchema,
  financeEncounterUuidSchema,
  financeIdempotencyKeySchema,
  financeInvoiceSchema,
  financeInvoiceUuidSchema,
} from "../validation/finance.js";

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  status: "open" | "closed" | "cancelled";
  record_number: string;
}

interface ChargeRow extends RowDataPacket {
  charge_id: number;
  charge_uuid: string;
  facility_id: number;
  encounter_id: number;
  encounter_uuid: string;
  record_number: string;
  idempotency_key: string;
  charge_code: string;
  description_ciphertext: Buffer;
  amount: string;
  currency_code: string;
  status: "unbilled" | "invoiced";
  recorded_by: number;
  recorder_name: string;
  recorded_at: Date;
}

interface InvoiceRow extends RowDataPacket {
  invoice_id: number;
  invoice_uuid: string;
  facility_id: number;
  encounter_id: number;
  encounter_uuid: string;
  record_number: string;
  idempotency_key: string;
  currency_code: string;
  subtotal_amount: string;
  adjustment_net_amount: string;
  total_amount: string;
  status: "issued";
  issued_by: number;
  issuer_name: string;
  issued_at: Date;
}

interface InvoiceLineRow extends RowDataPacket {
  invoice_line_id: number;
  charge_code: string;
  description_ciphertext: Buffer;
  amount: string;
  currency_code: string;
}

interface AdjustmentRow extends RowDataPacket {
  adjustment_uuid: string;
  adjustment_type: "debit" | "credit";
  amount: string;
  reason_ciphertext: Buffer;
  created_by: number;
  creator_name: string;
  created_at: Date;
}

interface AdjustmentReplayRow extends AdjustmentRow {
  invoice_id: number;
  invoice_uuid: string;
}

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

const invoiceSelect = `SELECT i.invoice_id, i.invoice_uuid, i.facility_id, i.encounter_id,
  e.encounter_uuid, p.record_number, i.idempotency_key, i.currency_code,
  CAST(i.subtotal_amount AS CHAR) AS subtotal_amount,
  CAST(COALESCE((
    SELECT SUM(CASE WHEN a.adjustment_type = 'debit' THEN a.amount ELSE -a.amount END)
    FROM finance_adjustments a
    WHERE a.facility_id = i.facility_id AND a.invoice_id = i.invoice_id
  ), 0.00) AS CHAR) AS adjustment_net_amount,
  CAST(i.subtotal_amount + COALESCE((
    SELECT SUM(CASE WHEN a.adjustment_type = 'debit' THEN a.amount ELSE -a.amount END)
    FROM finance_adjustments a
    WHERE a.facility_id = i.facility_id AND a.invoice_id = i.invoice_id
  ), 0.00) AS CHAR) AS total_amount,
  i.status, i.issued_by, issuer.display_name AS issuer_name, i.issued_at
  FROM finance_invoices i
  JOIN encounters e ON e.encounter_id = i.encounter_id AND e.facility_id = i.facility_id
  JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
  JOIN users issuer ON issuer.user_id = i.issued_by`;

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ER_DUP_ENTRY";
}

async function financeEnabled(
  req: Request,
  facilityId: number,
  res: Response,
  connection?: PoolConnection,
  lock = false,
): Promise<boolean> {
  const executor = connection ?? pool;
  const [rows] = await executor.execute<RowDataPacket[]>(
    `SELECT s.enabled, s.workflow_approval_reference, s.approved_by, s.approved_at,
            d.department_id
     FROM finance_module_settings s
     LEFT JOIN departments d
       ON d.facility_id = s.facility_id AND d.department_code = 'FINANCE' AND d.status = 'active'
     WHERE s.facility_id = ?
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [facilityId],
  );
  const settings = rows[0];
  if (!settings || !settings.department_id || Number(settings.enabled) !== 1 ||
      !settings.workflow_approval_reference || !settings.approved_by || !settings.approved_at) {
    await writeAuditEvent({
      actorUserId: req.principal?.userId ?? null,
      action: "finance.module.disabled",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    }, connection);
    respondError(res, 503, "FINANCE_DISABLED", "Finance workflows are disabled until facility approval and activation are recorded.");
    return false;
  }
  const principal = req.principal;
  if (!principal || !canAccessDepartment(principal, facilityId, Number(settings.department_id))) {
    await writeAuditEvent({
      actorUserId: principal?.userId ?? null,
      action: "finance.department_access",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    }, connection);
    respondError(res, 403, "DEPARTMENT_ACCESS_DENIED", "You are not assigned to the finance department.");
    return false;
  }
  return true;
}

async function checkFacilityAccess(
  req: Request,
  res: Response,
  facilityId: number,
  connection?: PoolConnection,
): Promise<boolean> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return false;
  }
  if (!canAccessFacility(principal, facilityId)) {
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "finance.facility_access",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    }, connection);
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return false;
  }
  const [facilities] = await (connection ?? pool).execute<FacilityRow[]>(
    "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
    [facilityId],
  );
  if (!facilities[0]) {
    respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
    return false;
  }
  return true;
}

async function loadEncounter(
  req: Request,
  res: Response,
  encounterUuid: string,
  connection?: PoolConnection,
  lock = false,
): Promise<EncounterRow | null> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return null;
  }
  const executor = connection ?? pool;
  const [rows] = await executor.execute<EncounterRow[]>(
    `SELECT e.encounter_id, e.encounter_uuid, e.facility_id, e.status, p.record_number
     FROM encounters e
     JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
     WHERE e.encounter_uuid = ? AND p.status = 'active'
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [encounterUuid],
  );
  const encounter = rows[0];
  if (!encounter) {
    respondError(res, 404, "ENCOUNTER_NOT_FOUND", "The active encounter was not found.");
    return null;
  }
  if (!await checkFacilityAccess(req, res, Number(encounter.facility_id), connection)) return null;
  return encounter;
}

async function loadInvoice(
  executor: PoolConnection | typeof pool,
  invoiceUuid: string,
): Promise<InvoiceRow | null> {
  const [rows] = await executor.execute<InvoiceRow[]>(
    `${invoiceSelect}
     WHERE i.invoice_uuid = ?
     LIMIT 1`,
    [invoiceUuid],
  );
  return rows[0] ?? null;
}

async function loadInvoiceLines(
  executor: PoolConnection | typeof pool,
  invoiceId: number,
  facilityId: number,
): Promise<InvoiceLineRow[]> {
  const [rows] = await executor.execute<InvoiceLineRow[]>(
    `SELECT invoice_line_id, charge_code, description_ciphertext,
            CAST(amount AS CHAR) AS amount, currency_code
     FROM finance_invoice_lines
     WHERE facility_id = ? AND invoice_id = ?
     ORDER BY invoice_line_id`,
    [facilityId, invoiceId],
  );
  return rows;
}

async function loadAdjustments(
  executor: PoolConnection | typeof pool,
  invoiceId: number,
  facilityId: number,
): Promise<AdjustmentRow[]> {
  const [rows] = await executor.execute<AdjustmentRow[]>(
    `SELECT a.adjustment_uuid, a.adjustment_type, CAST(a.amount AS CHAR) AS amount,
            a.reason_ciphertext, a.created_by, u.display_name AS creator_name, a.created_at
     FROM finance_adjustments a
     JOIN users u ON u.user_id = a.created_by
     WHERE a.facility_id = ? AND a.invoice_id = ?
     ORDER BY a.created_at, a.adjustment_id`,
    [facilityId, invoiceId],
  );
  return rows;
}

function serializeInvoiceSummary(invoice: InvoiceRow) {
  return {
    invoiceId: invoice.invoice_uuid,
    encounterId: invoice.encounter_uuid,
    recordNumber: invoice.record_number,
    currencyCode: invoice.currency_code,
    status: invoice.status,
    subtotalAmount: invoice.subtotal_amount,
    adjustmentNetAmount: invoice.adjustment_net_amount,
    totalAmount: invoice.total_amount,
    issuedByUserId: Number(invoice.issued_by),
    issuedBy: invoice.issuer_name,
    issuedAt: new Date(invoice.issued_at).toISOString(),
  };
}

async function serializeInvoice(
  executor: PoolConnection | typeof pool,
  invoice: InvoiceRow,
) {
  const [lines, adjustments] = await Promise.all([
    loadInvoiceLines(executor, Number(invoice.invoice_id), Number(invoice.facility_id)),
    loadAdjustments(executor, Number(invoice.invoice_id), Number(invoice.facility_id)),
  ]);
  return {
    invoiceId: invoice.invoice_uuid,
    encounterId: invoice.encounter_uuid,
    recordNumber: invoice.record_number,
    currencyCode: invoice.currency_code,
    status: invoice.status,
    subtotalAmount: invoice.subtotal_amount,
    adjustmentNetAmount: invoice.adjustment_net_amount,
    totalAmount: invoice.total_amount,
    issuedByUserId: Number(invoice.issued_by),
    issuedBy: invoice.issuer_name,
    issuedAt: new Date(invoice.issued_at).toISOString(),
    lines: lines.map((line) => ({
      chargeCode: line.charge_code,
      description: decryptData(line.description_ciphertext),
      amount: line.amount,
      currencyCode: line.currency_code,
    })),
    adjustments: adjustments.map((adjustment) => ({
      adjustmentId: adjustment.adjustment_uuid,
      adjustmentType: adjustment.adjustment_type,
      amount: adjustment.amount,
      reason: decryptData(adjustment.reason_ciphertext),
      createdByUserId: Number(adjustment.created_by),
      createdBy: adjustment.creator_name,
      createdAt: new Date(adjustment.created_at).toISOString(),
    })),
  };
}

function serializeCharge(row: ChargeRow) {
  return {
    chargeId: row.charge_uuid,
    encounterId: row.encounter_uuid,
    recordNumber: row.record_number,
    chargeCode: row.charge_code,
    description: decryptData(row.description_ciphertext),
    amount: row.amount,
    currencyCode: row.currency_code,
    status: row.status,
    recordedByUserId: Number(row.recorded_by),
    recordedBy: row.recorder_name,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

export const financeRouter = Router();
financeRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
financeRouter.use(requireSession);

financeRouter.get(
  "/encounters/:encounterId/charges",
  requirePermission("finance.charge.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = financeEncounterUuidSchema.safeParse(req.params.encounterId);
    if (!parsedEncounter.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "FINANCIAL_DATA_KEY_REQUIRED", "Finance encryption is not configured.");
      return;
    }
    try {
      const encounter = await loadEncounter(req, res, parsedEncounter.data);
      if (!encounter || !await financeEnabled(req, Number(encounter.facility_id), res)) return;
      const [rows] = await pool.execute<ChargeRow[]>(
        `SELECT c.charge_id, c.charge_uuid, c.facility_id, c.encounter_id,
                e.encounter_uuid, p.record_number, c.idempotency_key, c.charge_code,
                c.description_ciphertext, CAST(c.amount AS CHAR) AS amount, c.currency_code,
                c.status, c.recorded_by, u.display_name AS recorder_name, c.recorded_at
         FROM finance_charges c
         JOIN encounters e ON e.encounter_id = c.encounter_id AND e.facility_id = c.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users u ON u.user_id = c.recorded_by
         WHERE c.facility_id = ? AND c.encounter_id = ?
         ORDER BY c.recorded_at DESC, c.charge_id DESC
         LIMIT 100`,
        [encounter.facility_id, encounter.encounter_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "finance.charge.read",
        resourceType: "encounter",
        resourceId: parsedEncounter.data,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({ charges: rows.map(serializeCharge), truncated: rows.length === 100 });
    } catch (error) {
      next(error);
    }
  },
);

financeRouter.post(
  "/encounters/:encounterId/charges",
  requirePermission("finance.charge.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = financeEncounterUuidSchema.safeParse(req.params.encounterId);
    const parsedCharge = financeChargeSchema.safeParse(req.body);
    const idempotencyKey = financeIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedEncounter.success || !parsedCharge.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter, charge, and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "FINANCIAL_DATA_KEY_REQUIRED", "Finance encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const encounter = await loadEncounter(req, res, parsedEncounter.data, connection, true);
      if (!encounter) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (!await financeEnabled(req, Number(encounter.facility_id), res, connection, true)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      const [existingRows] = await connection.execute<ChargeRow[]>(
        `SELECT c.charge_id, c.charge_uuid, c.facility_id, c.encounter_id,
                e.encounter_uuid, p.record_number, c.idempotency_key, c.charge_code,
                c.description_ciphertext, CAST(c.amount AS CHAR) AS amount, c.currency_code,
                c.status, c.recorded_by, u.display_name AS recorder_name, c.recorded_at
         FROM finance_charges c
         JOIN encounters e ON e.encounter_id = c.encounter_id AND e.facility_id = c.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users u ON u.user_id = c.recorded_by
         WHERE c.facility_id = ? AND c.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = Number(existing.encounter_id) === Number(encounter.encounter_id) &&
          Number(existing.recorded_by) === principal.userId &&
          existing.charge_code === parsedCharge.data.chargeCode &&
          existing.description_ciphertext.length > 0 &&
          decryptData(existing.description_ciphertext) === parsedCharge.data.description &&
          existing.amount === parsedCharge.data.amount &&
          existing.currency_code === parsedCharge.data.currencyCode;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different charge.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "finance.charge.idempotent_replay",
          resourceType: "finance_charge",
          resourceId: existing.charge_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        res.json({ charge: serializeCharge(existing), idempotentReplay: true });
        return;
      }
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "A manual charge can only be recorded for an open encounter.");
        return;
      }
      const chargeUuid = randomUUID();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO finance_charges
          (charge_uuid, facility_id, encounter_id, idempotency_key, charge_code,
           description_ciphertext, amount, currency_code, status, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unbilled', ?, UTC_TIMESTAMP(6))`,
        [
          chargeUuid, encounter.facility_id, encounter.encounter_id, idempotencyKey.data,
          parsedCharge.data.chargeCode, encryptData(parsedCharge.data.description),
          parsedCharge.data.amount, parsedCharge.data.currencyCode, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "finance.charge.create",
        resourceType: "finance_charge",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const [createdRows] = await connection.execute<ChargeRow[]>(
        `SELECT c.charge_id, c.charge_uuid, c.facility_id, c.encounter_id,
                e.encounter_uuid, p.record_number, c.idempotency_key, c.charge_code,
                c.description_ciphertext, CAST(c.amount AS CHAR) AS amount, c.currency_code,
                c.status, c.recorded_by, u.display_name AS recorder_name, c.recorded_at
         FROM finance_charges c
         JOIN encounters e ON e.encounter_id = c.encounter_id AND e.facility_id = c.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users u ON u.user_id = c.recorded_by
         WHERE c.charge_uuid = ? AND c.facility_id = ?
         LIMIT 1`,
        [chargeUuid, encounter.facility_id],
      );
      if (!createdRows[0]) throw new Error("The newly recorded finance charge could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ charge: serializeCharge(createdRows[0]), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (isDuplicateKeyError(error)) {
        respondError(res, 409, "CHARGE_CONFLICT", "A charge with this request identity already exists; reload the encounter.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

financeRouter.get(
  "/encounters/:encounterId/invoices",
  requirePermission("finance.invoice.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = financeEncounterUuidSchema.safeParse(req.params.encounterId);
    if (!parsedEncounter.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "FINANCIAL_DATA_KEY_REQUIRED", "Finance encryption is not configured.");
      return;
    }
    try {
      const encounter = await loadEncounter(req, res, parsedEncounter.data);
      if (!encounter || !await financeEnabled(req, Number(encounter.facility_id), res)) return;
      const [rows] = await pool.execute<InvoiceRow[]>(
        `${invoiceSelect}
         WHERE i.facility_id = ? AND i.encounter_id = ?
         ORDER BY i.issued_at DESC, i.invoice_id DESC
         LIMIT 100`,
        [encounter.facility_id, encounter.encounter_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "finance.invoice.read",
        resourceType: "encounter",
        resourceId: parsedEncounter.data,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({
        invoices: rows.map(serializeInvoiceSummary),
        truncated: rows.length === 100,
      });
    } catch (error) {
      next(error);
    }
  },
);

financeRouter.post(
  "/encounters/:encounterId/invoices",
  requirePermission("finance.invoice.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = financeEncounterUuidSchema.safeParse(req.params.encounterId);
    const parsedInvoice = financeInvoiceSchema.safeParse(req.body);
    const idempotencyKey = financeIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedEncounter.success || !parsedInvoice.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter, currency code, and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "FINANCIAL_DATA_KEY_REQUIRED", "Finance encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const encounter = await loadEncounter(req, res, parsedEncounter.data, connection, true);
      if (!encounter) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (!await financeEnabled(req, Number(encounter.facility_id), res, connection, true)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      const [existingRows] = await connection.execute<InvoiceRow[]>(
        `${invoiceSelect}
         WHERE i.facility_id = ? AND i.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = Number(existing.encounter_id) === Number(encounter.encounter_id) &&
          existing.currency_code === parsedInvoice.data.currencyCode &&
          Number(existing.issued_by) === principal.userId;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different invoice.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "finance.invoice.idempotent_replay",
          resourceType: "finance_invoice",
          resourceId: existing.invoice_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        const invoice = await loadInvoice(pool, existing.invoice_uuid);
        if (!invoice) throw new Error("The existing invoice could not be read back.");
        res.json({ invoice: await serializeInvoice(pool, invoice), idempotentReplay: true });
        return;
      }
      if (encounter.status === "cancelled") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_CANCELLED", "An invoice cannot be issued for a cancelled encounter.");
        return;
      }
      const [chargeRows] = await connection.execute<ChargeRow[]>(
        `SELECT charge_id, charge_uuid, facility_id, encounter_id, ? AS encounter_uuid,
                ? AS record_number, idempotency_key, charge_code, description_ciphertext,
                CAST(amount AS CHAR) AS amount, currency_code, status, recorded_by,
                '' AS recorder_name, recorded_at
         FROM finance_charges
         WHERE facility_id = ? AND encounter_id = ? AND currency_code = ? AND status = 'unbilled'
         ORDER BY recorded_at, charge_id
         LIMIT 500 FOR UPDATE`,
        [
          encounter.encounter_uuid, encounter.record_number, encounter.facility_id,
          encounter.encounter_id, parsedInvoice.data.currencyCode,
        ],
      );
      if (chargeRows.length === 0) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "NO_UNBILLED_CHARGES", "There are no unbilled charges in the selected currency.");
        return;
      }
      const subtotalAmount = sumMoneyAmounts(chargeRows.map((charge) => charge.amount));
      const invoiceUuid = randomUUID();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO finance_invoices
          (invoice_uuid, facility_id, encounter_id, idempotency_key, currency_code,
           subtotal_amount, status, issued_by, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, UTC_TIMESTAMP(6))`,
        [
          invoiceUuid, encounter.facility_id, encounter.encounter_id, idempotencyKey.data,
          parsedInvoice.data.currencyCode, subtotalAmount, principal.userId,
        ],
      );
      for (const charge of chargeRows) {
        await connection.execute(
          `INSERT INTO finance_invoice_lines
            (facility_id, invoice_id, charge_id, charge_code, description_ciphertext, amount, currency_code)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            encounter.facility_id, result.insertId, charge.charge_id, charge.charge_code,
            charge.description_ciphertext, charge.amount, charge.currency_code,
          ],
        );
        await connection.execute(
          "UPDATE finance_charges SET status = 'invoiced' WHERE charge_id = ? AND status = 'unbilled'",
          [charge.charge_id],
        );
      }
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "finance.invoice.issue",
        resourceType: "finance_invoice",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const invoice = await loadInvoice(connection, invoiceUuid);
      if (!invoice) throw new Error("The newly issued invoice could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ invoice: await serializeInvoice(pool, invoice), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (isDuplicateKeyError(error)) {
        respondError(res, 409, "INVOICE_CONFLICT", "Charges or invoice request identity changed concurrently; reload and retry.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

financeRouter.get(
  "/invoices/:invoiceId",
  requirePermission("finance.invoice.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedInvoice = financeInvoiceUuidSchema.safeParse(req.params.invoiceId);
    if (!parsedInvoice.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid invoice identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "FINANCIAL_DATA_KEY_REQUIRED", "Finance encryption is not configured.");
      return;
    }
    try {
      const invoice = await loadInvoice(pool, parsedInvoice.data);
      if (!invoice) {
        respondError(res, 404, "INVOICE_NOT_FOUND", "The invoice was not found.");
        return;
      }
      if (!await checkFacilityAccess(req, res, Number(invoice.facility_id))) return;
      if (!await financeEnabled(req, Number(invoice.facility_id), res)) return;
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "finance.invoice.read",
        resourceType: "finance_invoice",
        resourceId: invoice.invoice_uuid,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({ invoice: await serializeInvoice(pool, invoice) });
    } catch (error) {
      next(error);
    }
  },
);

financeRouter.post(
  "/invoices/:invoiceId/adjustments",
  requirePermission("finance.adjustment.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedInvoice = financeInvoiceUuidSchema.safeParse(req.params.invoiceId);
    const parsedAdjustment = financeAdjustmentSchema.safeParse(req.body);
    const idempotencyKey = financeIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedInvoice.success || !parsedAdjustment.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid invoice, adjustment, and Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "FINANCIAL_DATA_KEY_REQUIRED", "Finance encryption is not configured.");
      return;
    }
    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const invoice = await loadInvoice(connection, parsedInvoice.data);
      if (!invoice) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "INVOICE_NOT_FOUND", "The invoice was not found.");
        return;
      }
      if (!await checkFacilityAccess(req, res, Number(invoice.facility_id), connection)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      if (!await financeEnabled(req, Number(invoice.facility_id), res, connection, true)) {
        await connection.commit();
        transactionStarted = false;
        return;
      }
      const [existingRows] = await connection.execute<AdjustmentReplayRow[]>(
        `SELECT a.adjustment_uuid, a.adjustment_type, CAST(a.amount AS CHAR) AS amount,
                a.reason_ciphertext, a.created_by, u.display_name AS creator_name, a.created_at,
                a.invoice_id, i.invoice_uuid
         FROM finance_adjustments a
         JOIN finance_invoices i ON i.invoice_id = a.invoice_id AND i.facility_id = a.facility_id
         JOIN users u ON u.user_id = a.created_by
         WHERE a.facility_id = ? AND a.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [invoice.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        const matches = existing.invoice_uuid === invoice.invoice_uuid &&
          Number(existing.created_by) === principal.userId &&
          existing.adjustment_type === parsedAdjustment.data.adjustmentType &&
          existing.amount === parsedAdjustment.data.amount &&
          decryptData(existing.reason_ciphertext) === parsedAdjustment.data.reason;
        await connection.rollback();
        transactionStarted = false;
        if (!matches) {
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different adjustment.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "finance.adjustment.idempotent_replay",
          resourceType: "finance_adjustment",
          resourceId: existing.adjustment_uuid,
          outcome: "allowed",
          ipAddress: req.ip,
        });
        const latestInvoice = await loadInvoice(pool, invoice.invoice_uuid);
        if (!latestInvoice) throw new Error("The existing invoice could not be read back.");
        res.json({ invoice: await serializeInvoice(pool, latestInvoice), idempotentReplay: true });
        return;
      }
      const adjustmentUuid = randomUUID();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO finance_adjustments
          (adjustment_uuid, facility_id, invoice_id, idempotency_key,
           adjustment_type, amount, reason_ciphertext, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
        [
          adjustmentUuid, invoice.facility_id, invoice.invoice_id, idempotencyKey.data,
          parsedAdjustment.data.adjustmentType, parsedAdjustment.data.amount,
          encryptData(parsedAdjustment.data.reason), principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "finance.adjustment.create",
        resourceType: "finance_adjustment",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const updatedInvoice = await loadInvoice(connection, invoice.invoice_uuid);
      if (!updatedInvoice) throw new Error("The adjusted invoice could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ invoice: await serializeInvoice(pool, updatedInvoice), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      if (isDuplicateKeyError(error)) {
        respondError(res, 409, "ADJUSTMENT_CONFLICT", "This adjustment request identity already exists.");
        return;
      }
      next(error);
    } finally {
      connection?.release();
    }
  },
);

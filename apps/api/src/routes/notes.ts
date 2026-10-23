import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessFacility } from "../security/access-control.js";
import { decryptData, encryptData, isDataEncryptionConfigured } from "../security/data-encryption.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  noteAmendmentSchema,
  noteDraftSchema,
  noteIdempotencyKeySchema,
  noteSignSchema,
  noteUuidSchema,
  type NoteAmendment,
  type NoteDraft,
} from "../validation/note.js";

interface EncounterRow extends RowDataPacket {
  encounter_id: number;
  encounter_uuid: string;
  facility_id: number;
  status: "open" | "closed" | "cancelled";
  record_number: string;
}

interface NoteRow extends RowDataPacket {
  note_id: number;
  note_uuid: string;
  root_note_uuid: string;
  parent_note_id: number | null;
  parent_note_uuid: string | null;
  encounter_uuid: string;
  encounter_id: number;
  record_number: string;
  note_type: "clinical" | "nursing" | "handover" | "other";
  title_ciphertext: Buffer;
  content_ciphertext: Buffer;
  status: "draft" | "signed";
  version_number: number;
  amendment_reason_ciphertext: Buffer | null;
  authored_by: number;
  author_name: string;
  signed_by: number | null;
  signer_name: string | null;
  signed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  idempotency_key: string;
}

interface FacilityRow extends RowDataPacket {
  facility_id: number;
}

function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function sameDraft(row: NoteRow, draft: NoteDraft, encounterId: number, authorId: number): boolean {
  if (Number(row.encounter_id) !== encounterId || Number(row.authored_by) !== authorId ||
      row.note_type !== draft.noteType) return false;
  return decryptData(row.title_ciphertext) === draft.title &&
    decryptData(row.content_ciphertext) === draft.content;
}

function sameAmendment(
  row: NoteRow,
  amendment: NoteAmendment,
  rootNoteUuid: string,
  parentNoteId: number,
  authorId: number,
): boolean {
  return row.root_note_uuid === rootNoteUuid &&
    Number(row.parent_note_id) === parentNoteId &&
    Number(row.authored_by) === authorId &&
    row.note_type === amendment.noteType &&
    row.amendment_reason_ciphertext !== null &&
    decryptData(row.amendment_reason_ciphertext) === amendment.reason &&
    decryptData(row.title_ciphertext) === amendment.title &&
    decryptData(row.content_ciphertext) === amendment.content;
}

function serializeNote(row: NoteRow) {
  return {
    noteId: row.note_uuid,
    rootNoteId: row.root_note_uuid,
    parentNoteId: row.parent_note_uuid,
    encounterId: row.encounter_uuid,
    recordNumber: row.record_number,
    noteType: row.note_type,
    title: decryptData(row.title_ciphertext),
    content: decryptData(row.content_ciphertext),
    status: row.status,
    version: Number(row.version_number),
    amendmentReason: row.amendment_reason_ciphertext === null
      ? null
      : decryptData(row.amendment_reason_ciphertext),
    authoredByUserId: Number(row.authored_by),
    authoredBy: row.author_name,
    signedByUserId: row.signed_by === null ? null : Number(row.signed_by),
    signedBy: row.signer_name,
    signedAt: row.signed_at ? new Date(row.signed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
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
  if (!canAccessFacility(principal, Number(encounter.facility_id))) {
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "encounter.note.facility_access",
      resourceType: "encounter",
      resourceId: encounterUuid,
      outcome: "denied",
      ipAddress: req.ip,
    });
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return null;
  }
  const [facilities] = await executor.execute<FacilityRow[]>(
    "SELECT facility_id FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
    [encounter.facility_id],
  );
  if (!facilities[0]) {
    respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
    return null;
  }
  return encounter;
}

async function loadNote(
  executor: PoolConnection | typeof pool,
  encounter: EncounterRow,
  noteUuid: string,
  lock = false,
): Promise<NoteRow | null> {
  const [rows] = await executor.execute<NoteRow[]>(
    `SELECT n.note_id, n.note_uuid, n.root_note_uuid, n.parent_note_id,
            (SELECT parent.note_uuid FROM encounter_notes parent
             WHERE parent.note_id = n.parent_note_id AND parent.facility_id = n.facility_id) AS parent_note_uuid,
            e.encounter_uuid, p.record_number, n.note_type, n.title_ciphertext,
            n.content_ciphertext, n.status, n.version_number, n.amendment_reason_ciphertext,
            n.authored_by, author.display_name AS author_name, n.signed_by,
            signer.display_name AS signer_name, n.signed_at, n.created_at,
            n.updated_at, n.idempotency_key, n.encounter_id
     FROM encounter_notes n
     JOIN encounters e ON e.encounter_id = n.encounter_id AND e.facility_id = n.facility_id
     JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
     JOIN users author ON author.user_id = n.authored_by
     LEFT JOIN users signer ON signer.user_id = n.signed_by
     WHERE n.note_uuid = ? AND n.encounter_id = ? AND n.facility_id = ?
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [noteUuid, encounter.encounter_id, encounter.facility_id],
  );
  return rows[0] ?? null;
}

export const notesRouter = Router();
notesRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

notesRouter.get(
  "/:encounterId/notes",
  requireSession,
  requirePermission("encounter.note.read"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedId = noteUuidSchema.safeParse(req.params.encounterId);
    if (!parsedId.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide a valid encounter identifier.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "CLINICAL_DATA_KEY_REQUIRED", "Clinical-note encryption is not configured.");
      return;
    }
    try {
      const encounter = await loadEncounter(req, res, parsedId.data);
      if (!encounter) return;
      const [rows] = await pool.execute<NoteRow[]>(
        `SELECT n.note_id, n.note_uuid, n.root_note_uuid, n.parent_note_id,
                (SELECT parent.note_uuid FROM encounter_notes parent
                 WHERE parent.note_id = n.parent_note_id AND parent.facility_id = n.facility_id) AS parent_note_uuid,
                e.encounter_uuid, p.record_number, n.note_type, n.title_ciphertext,
                n.content_ciphertext, n.status, n.version_number, n.amendment_reason_ciphertext,
                n.authored_by, author.display_name AS author_name, n.signed_by,
                signer.display_name AS signer_name, n.signed_at, n.created_at,
                n.updated_at, n.idempotency_key, n.encounter_id
         FROM encounter_notes n
         JOIN encounters e ON e.encounter_id = n.encounter_id AND e.facility_id = n.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users author ON author.user_id = n.authored_by
         LEFT JOIN users signer ON signer.user_id = n.signed_by
         WHERE n.encounter_id = ? AND n.facility_id = ?
         ORDER BY n.root_note_uuid, n.version_number
         LIMIT 100`,
        [encounter.encounter_id, encounter.facility_id],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.note.read",
        resourceType: "encounter",
        resourceId: parsedId.data,
        outcome: "allowed",
        ipAddress: req.ip,
      });
      res.json({ notes: rows.map(serializeNote), truncated: rows.length === 100 });
    } catch (error) {
      next(error);
    }
  },
);

notesRouter.post(
  "/:encounterId/notes",
  requireSession,
  requirePermission("encounter.note.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedId = noteUuidSchema.safeParse(req.params.encounterId);
    const parsedDraft = noteDraftSchema.safeParse(req.body);
    const idempotencyKey = noteIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedId.success || !parsedDraft.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid note details and an Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "CLINICAL_DATA_KEY_REQUIRED", "Clinical-note encryption is not configured.");
      return;
    }

    let connection: PoolConnection | undefined;
    let transactionStarted = false;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const encounter = await loadEncounter(req, res, parsedId.data, connection, true);
      if (!encounter) {
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "New note drafts can only be created for an open encounter.");
        return;
      }
      const [existingRows] = await connection.execute<NoteRow[]>(
        `SELECT n.note_id, n.note_uuid, n.root_note_uuid, n.parent_note_id,
                (SELECT parent.note_uuid FROM encounter_notes parent
                 WHERE parent.note_id = n.parent_note_id AND parent.facility_id = n.facility_id) AS parent_note_uuid,
                e.encounter_uuid, p.record_number, n.note_type, n.title_ciphertext,
                n.content_ciphertext, n.status, n.version_number, n.amendment_reason_ciphertext,
                n.authored_by, author.display_name AS author_name, n.signed_by,
                signer.display_name AS signer_name, n.signed_at, n.created_at,
                n.updated_at, n.idempotency_key, n.encounter_id
         FROM encounter_notes n
         JOIN encounters e ON e.encounter_id = n.encounter_id AND e.facility_id = n.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users author ON author.user_id = n.authored_by
         LEFT JOIN users signer ON signer.user_id = n.signed_by
         WHERE n.facility_id = ? AND n.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        if (!sameDraft(existing, parsedDraft.data, Number(encounter.encounter_id), principal.userId)) {
          await connection.rollback();
          transactionStarted = false;
          respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for different note content.");
          return;
        }
        await writeAuditEvent({
          actorUserId: principal.userId,
          action: "encounter.note.idempotent_replay",
          resourceType: "encounter",
          resourceId: parsedId.data,
          outcome: "allowed",
          ipAddress: req.ip,
        }, connection);
        await connection.commit();
        transactionStarted = false;
        res.json({ note: serializeNote(existing), idempotentReplay: true });
        return;
      }

      const noteUuid = randomUUID();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO encounter_notes
          (note_uuid, root_note_uuid, parent_note_id, facility_id, encounter_id,
           idempotency_key, note_type, title_ciphertext, content_ciphertext, status,
           version_number, amendment_reason_ciphertext, authored_by, signed_by, signed_at,
           created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'draft', 1, NULL, ?, NULL, NULL,
                 UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [
          noteUuid, noteUuid, encounter.facility_id, encounter.encounter_id,
          idempotencyKey.data, parsedDraft.data.noteType, encryptData(parsedDraft.data.title),
          encryptData(parsedDraft.data.content), principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.note.draft.create",
        resourceType: "encounter_note",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      const createdNote = await loadNote(connection, encounter, noteUuid);
      if (!createdNote) throw new Error("The newly created note draft could not be read back.");
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({ note: serializeNote(createdNote), idempotentReplay: false });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);

notesRouter.put(
  "/:encounterId/notes/:noteId",
  requireSession,
  requirePermission("encounter.note.create"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = noteUuidSchema.safeParse(req.params.encounterId);
    const parsedNote = noteUuidSchema.safeParse(req.params.noteId);
    const parsedDraft = noteDraftSchema.safeParse(req.body);
    if (!parsedEncounter.success || !parsedNote.success || !parsedDraft.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid draft note details.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "CLINICAL_DATA_KEY_REQUIRED", "Clinical-note encryption is not configured.");
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
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      const note = await loadNote(connection, encounter, parsedNote.data, true);
      if (!note) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "NOTE_NOT_FOUND", "The requested note was not found.");
        return;
      }
      if (note.status !== "draft" || Number(note.authored_by) !== principal.userId) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "NOTE_DRAFT_LOCKED", "Only the original author can edit an unsigned draft.");
        return;
      }
      if (encounter.status !== "open") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_NOT_OPEN", "A draft can only be edited while its encounter is open.");
        return;
      }
      await connection.execute(
        `UPDATE encounter_notes
         SET note_type = ?, title_ciphertext = ?, content_ciphertext = ?, updated_at = UTC_TIMESTAMP(6)
         WHERE note_id = ? AND status = 'draft' AND authored_by = ?`,
        [
          parsedDraft.data.noteType, encryptData(parsedDraft.data.title),
          encryptData(parsedDraft.data.content), note.note_id, principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.note.draft.update",
        resourceType: "encounter_note",
        resourceId: String(note.note_id),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.json({ noteId: parsedNote.data, status: "draft", updatedAt: new Date().toISOString() });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);

notesRouter.post(
  "/:encounterId/notes/:noteId/sign",
  requireSession,
  requirePermission("encounter.note.sign"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = noteUuidSchema.safeParse(req.params.encounterId);
    const parsedNote = noteUuidSchema.safeParse(req.params.noteId);
    const parsedBody = noteSignSchema.safeParse(req.body);
    if (!parsedEncounter.success || !parsedNote.success || !parsedBody.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid encounter and note identifiers.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
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
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      const note = await loadNote(connection, encounter, parsedNote.data, true);
      if (!note) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "NOTE_NOT_FOUND", "The requested note was not found.");
        return;
      }
      if (encounter.status !== "open" || note.status !== "draft" || Number(note.authored_by) !== principal.userId) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "NOTE_CANNOT_BE_SIGNED", "Only your own draft on an open encounter can be signed.");
        return;
      }
      await connection.execute(
        `UPDATE encounter_notes
         SET status = 'signed', signed_by = ?, signed_at = UTC_TIMESTAMP(6),
             updated_at = UTC_TIMESTAMP(6)
         WHERE note_id = ? AND status = 'draft' AND authored_by = ?`,
        [principal.userId, note.note_id, principal.userId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.note.sign",
        resourceType: "encounter_note",
        resourceId: String(note.note_id),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.json({ noteId: parsedNote.data, status: "signed", signedAt: new Date().toISOString() });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);

notesRouter.post(
  "/:encounterId/notes/:noteId/amendments",
  requireSession,
  requirePermission("encounter.note.amend"),
  async (req, res, next) => {
    const principal = req.principal;
    const parsedEncounter = noteUuidSchema.safeParse(req.params.encounterId);
    const parsedNote = noteUuidSchema.safeParse(req.params.noteId);
    const parsedAmendment = noteAmendmentSchema.safeParse(req.body);
    const idempotencyKey = noteIdempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedEncounter.success || !parsedNote.success || !parsedAmendment.success || !idempotencyKey.success) {
      respondError(res, 400, "INVALID_REQUEST", "Provide valid amendment details and an Idempotency-Key UUID.");
      return;
    }
    if (!principal) {
      respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
      return;
    }
    if (!isDataEncryptionConfigured()) {
      respondError(res, 503, "CLINICAL_DATA_KEY_REQUIRED", "Clinical-note encryption is not configured.");
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
        await connection.rollback();
        transactionStarted = false;
        return;
      }
      if (encounter.status === "cancelled") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "ENCOUNTER_CANCELLED", "Notes cannot be amended for a cancelled encounter.");
        return;
      }
      const target = await loadNote(connection, encounter, parsedNote.data, true);
      if (!target) {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 404, "NOTE_NOT_FOUND", "The requested note was not found.");
        return;
      }
      if (target.status !== "signed") {
        await connection.rollback();
        transactionStarted = false;
        respondError(res, 409, "NOTE_NOT_SIGNED", "Only a signed note can be amended.");
        return;
      }
      const [latestRows] = await connection.execute<NoteRow[]>(
        `SELECT n.note_id, n.note_uuid, n.root_note_uuid, n.parent_note_id,
                (SELECT parent.note_uuid FROM encounter_notes parent
                 WHERE parent.note_id = n.parent_note_id AND parent.facility_id = n.facility_id) AS parent_note_uuid,
                e.encounter_uuid, p.record_number, n.note_type, n.title_ciphertext,
                n.content_ciphertext, n.status, n.version_number, n.amendment_reason_ciphertext,
                n.authored_by, author.display_name AS author_name, n.signed_by,
                signer.display_name AS signer_name, n.signed_at, n.created_at,
                n.updated_at, n.idempotency_key, n.encounter_id
         FROM encounter_notes n
         JOIN encounters e ON e.encounter_id = n.encounter_id AND e.facility_id = n.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users author ON author.user_id = n.authored_by
         LEFT JOIN users signer ON signer.user_id = n.signed_by
         WHERE n.root_note_uuid = ? AND n.encounter_id = ? AND n.facility_id = ?
         ORDER BY n.version_number DESC
         LIMIT 1 FOR UPDATE`,
        [target.root_note_uuid, encounter.encounter_id, encounter.facility_id],
      );
      const latest = latestRows[0];
      if (!latest || Number(latest.note_id) !== Number(target.note_id) || latest.status !== "signed") {
        const [replayRows] = await connection.execute<NoteRow[]>(
          `SELECT n.note_id, n.note_uuid, n.root_note_uuid, n.parent_note_id,
                  (SELECT parent.note_uuid FROM encounter_notes parent
                   WHERE parent.note_id = n.parent_note_id AND parent.facility_id = n.facility_id) AS parent_note_uuid,
                  e.encounter_uuid, p.record_number, n.note_type, n.title_ciphertext,
                  n.content_ciphertext, n.status, n.version_number, n.amendment_reason_ciphertext,
                  n.authored_by, author.display_name AS author_name, n.signed_by,
                  signer.display_name AS signer_name, n.signed_at, n.created_at,
                  n.updated_at, n.idempotency_key, n.encounter_id
           FROM encounter_notes n
           JOIN encounters e ON e.encounter_id = n.encounter_id AND e.facility_id = n.facility_id
           JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
           JOIN users author ON author.user_id = n.authored_by
           LEFT JOIN users signer ON signer.user_id = n.signed_by
           WHERE n.facility_id = ? AND n.idempotency_key = ?
           LIMIT 1 FOR UPDATE`,
          [encounter.facility_id, idempotencyKey.data],
        );
        const replay = replayRows[0];
        await connection.rollback();
        transactionStarted = false;
        if (replay && sameAmendment(
          replay,
          parsedAmendment.data,
          target.root_note_uuid,
          Number(target.note_id),
          principal.userId,
        )) {
          await writeAuditEvent({
            actorUserId: principal.userId,
            action: "encounter.note.amendment.idempotent_replay",
            resourceType: "encounter_note",
            resourceId: replay.note_uuid,
            outcome: "allowed",
            ipAddress: req.ip,
          });
          res.json({
            noteId: replay.note_uuid,
            status: replay.status,
            version: Number(replay.version_number),
            idempotentReplay: true,
          });
          return;
        }
        respondError(res, 409, "NOTE_AMENDMENT_STALE", "Only the latest signed version can be amended; reload the note history.");
        return;
      }
      const [existingRows] = await connection.execute<NoteRow[]>(
        `SELECT n.note_id, n.note_uuid, n.root_note_uuid, n.parent_note_id,
                (SELECT parent.note_uuid FROM encounter_notes parent
                 WHERE parent.note_id = n.parent_note_id AND parent.facility_id = n.facility_id) AS parent_note_uuid,
                e.encounter_uuid, p.record_number, n.note_type, n.title_ciphertext,
                n.content_ciphertext, n.status, n.version_number, n.amendment_reason_ciphertext,
                n.authored_by, author.display_name AS author_name, n.signed_by,
                signer.display_name AS signer_name, n.signed_at, n.created_at,
                n.updated_at, n.idempotency_key, n.encounter_id
         FROM encounter_notes n
         JOIN encounters e ON e.encounter_id = n.encounter_id AND e.facility_id = n.facility_id
         JOIN patients p ON p.patient_id = e.patient_id AND p.facility_id = e.facility_id
         JOIN users author ON author.user_id = n.authored_by
         LEFT JOIN users signer ON signer.user_id = n.signed_by
         WHERE n.facility_id = ? AND n.idempotency_key = ?
         LIMIT 1 FOR UPDATE`,
        [encounter.facility_id, idempotencyKey.data],
      );
      const existing = existingRows[0];
      if (existing) {
        await connection.rollback();
        transactionStarted = false;
        if (sameAmendment(
          existing,
          parsedAmendment.data,
          target.root_note_uuid,
          Number(target.note_id),
          principal.userId,
        )) {
          res.json({ noteId: existing.note_uuid, status: existing.status, version: Number(existing.version_number), idempotentReplay: true });
          return;
        }
        respondError(res, 409, "IDEMPOTENCY_KEY_REUSED", "This request key was already used for another note.");
        return;
      }
      const noteUuid = randomUUID();
      const nextVersion = Number(latest.version_number) + 1;
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO encounter_notes
          (note_uuid, root_note_uuid, parent_note_id, facility_id, encounter_id,
           idempotency_key, note_type, title_ciphertext, content_ciphertext, status,
           version_number, amendment_reason_ciphertext, authored_by, signed_by, signed_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, NULL,
                 UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [
          noteUuid, target.root_note_uuid, target.note_id, encounter.facility_id,
          encounter.encounter_id, idempotencyKey.data, parsedAmendment.data.noteType,
          encryptData(parsedAmendment.data.title), encryptData(parsedAmendment.data.content),
          nextVersion, encryptData(parsedAmendment.data.reason), principal.userId,
        ],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "encounter.note.amendment.create",
        resourceType: "encounter_note",
        resourceId: String(result.insertId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      res.status(201).json({
        noteId: noteUuid,
        rootNoteId: target.root_note_uuid,
        parentNoteId: target.note_uuid,
        status: "draft",
        version: nextVersion,
        idempotentReplay: false,
      });
    } catch (error) {
      if (transactionStarted && connection) await connection.rollback();
      next(error);
    } finally {
      connection?.release();
    }
  },
);

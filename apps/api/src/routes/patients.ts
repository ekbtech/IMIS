import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { Router, type Request, type Response, type NextFunction } from "express";
import { requirePermission, requireSession } from "../middleware/require-session.js";
import { canAccessFacility } from "../security/access-control.js";
import { writeAuditEvent } from "../security/audit.js";
import {
  createPatientLookupHash,
  decryptData,
  encryptData,
  isDataEncryptionConfigured,
  isPatientLookupKeyConfigured,
} from "../security/data-encryption.js";
import { normalizeFullPatientName } from "../security/patient-identity.js";
import {
  duplicateCandidatesSchema,
  patientRegistrationSchema,
  patientSearchSchema,
  type PatientIdentity,
} from "../validation/patient.js";
import { pool } from "../db.js";

interface FacilityRow extends RowDataPacket {
  facility_code: string;
}

interface PatientRow extends RowDataPacket {
  patient_id: number;
  facility_id: number;
  record_number: string;
  demographics_ciphertext: Buffer;
  normalized_name_hmac: Buffer;
  birth_date_hmac: Buffer;
  created_at: Date;
}

type PatientDemographics = PatientIdentity;

function dataCryptoReady(): boolean {
  return isDataEncryptionConfigured() && isPatientLookupKeyConfigured();
}

function respondError(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

async function getScopedFacility(req: Request, res: Response, facilityId: number): Promise<FacilityRow | null> {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return null;
  }
  if (!canAccessFacility(principal, facilityId)) {
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "patient.facility_access",
      resourceType: "facility",
      resourceId: String(facilityId),
      outcome: "denied",
      ipAddress: req.ip,
    });
    respondError(res, 403, "FACILITY_ACCESS_DENIED", "You are not assigned to this facility.");
    return null;
  }

  const [facilities] = await pool.execute<FacilityRow[]>(
    "SELECT facility_code FROM facilities WHERE facility_id = ? AND status = 'active' LIMIT 1",
    [facilityId],
  );
  const facility = facilities[0];
  if (!facility) {
    respondError(res, 404, "FACILITY_NOT_FOUND", "The requested facility is unavailable.");
    return null;
  }
  return facility;
}

function decryptPatient(row: PatientRow): PatientDemographics {
  return JSON.parse(decryptData(row.demographics_ciphertext)) as PatientDemographics;
}

async function findDuplicateRows(
  connection: PoolConnection,
  facilityId: number,
  normalizedNameHash: Buffer,
  birthDateHash: Buffer,
): Promise<PatientRow[]> {
  const [rows] = await connection.execute<PatientRow[]>(
    `SELECT patient_id, facility_id, record_number, demographics_ciphertext,
            normalized_name_hmac, birth_date_hmac, created_at
     FROM patients
     WHERE facility_id = ? AND status = 'active'
       AND (normalized_name_hmac = ? OR birth_date_hmac = ?)
     ORDER BY created_at DESC
     LIMIT 21`,
    [facilityId, normalizedNameHash, birthDateHash],
  );
  return rows;
}

export const patientsRouter = Router();
patientsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
patientsRouter.use(requireSession);

patientsRouter.post("/duplicate-candidates", requirePermission("patient.mpi.search"), async (req, res, next) => {
  const principal = req.principal;
  const parsed = duplicateCandidatesSchema.safeParse(req.body);
  if (!parsed.success) {
    respondError(res, 400, "INVALID_REQUEST", "Check the patient identity fields.", parsed.error.flatten());
    return;
  }
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return;
  }
  if (!dataCryptoReady()) {
    respondError(res, 503, "PATIENT_DATA_KEYS_REQUIRED", "Patient encryption and lookup keys are not configured.");
    return;
  }

  try {
    const facility = await getScopedFacility(req, res, parsed.data.facilityId);
    if (!facility) return;

    const fullName = normalizeFullPatientName(parsed.data);
    const nameHash = createPatientLookupHash(fullName);
    const birthDateHash = createPatientLookupHash(parsed.data.dateOfBirth);
    const [rows] = await pool.execute<PatientRow[]>(
      `SELECT patient_id, facility_id, record_number, demographics_ciphertext,
              normalized_name_hmac, birth_date_hmac, created_at
       FROM patients
       WHERE facility_id = ? AND status = 'active'
         AND (normalized_name_hmac = ? OR birth_date_hmac = ?)
       ORDER BY created_at DESC
       LIMIT 21`,
      [parsed.data.facilityId, nameHash, birthDateHash],
    );
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "patient.mpi.duplicate_search",
      resourceType: "facility",
      resourceId: String(parsed.data.facilityId),
      outcome: "allowed",
      ipAddress: req.ip,
    });

    res.json({
      candidates: rows.slice(0, 20).map((row) => {
        const demographics = decryptPatient(row);
        return {
          patientId: row.patient_id,
          recordNumber: row.record_number,
          givenName: demographics.givenName,
          familyName: demographics.familyName,
          dateOfBirth: demographics.dateOfBirth,
          sameName: row.normalized_name_hmac.equals(nameHash),
          sameDateOfBirth: row.birth_date_hmac.equals(birthDateHash),
        };
      }),
      truncated: rows.length > 20,
      automaticMerge: false,
    });
  } catch (error) {
    next(error);
  }
});

patientsRouter.post("/", requirePermission("patient.registration.create"), async (req, res, next) => {
  const principal = req.principal;
  const parsed = patientRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    respondError(res, 400, "INVALID_REQUEST", "Check the patient registration fields.", parsed.error.flatten());
    return;
  }
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return;
  }
  if (!dataCryptoReady()) {
    respondError(res, 503, "PATIENT_DATA_KEYS_REQUIRED", "Patient encryption and lookup keys are not configured.");
    return;
  }

  const nameHash = createPatientLookupHash(normalizeFullPatientName(parsed.data));
  const birthDateHash = createPatientLookupHash(parsed.data.dateOfBirth);
  const lockNames = [
    `MPI-N-${nameHash.toString("hex").slice(0, 58)}`,
    `MPI-D-${birthDateHash.toString("hex").slice(0, 58)}`,
  ].sort();
  const connection = await pool.getConnection();
  const acquiredLocks: string[] = [];
  let transactionStarted = false;

  try {
    const facility = await getScopedFacility(req, res, parsed.data.facilityId);
    if (!facility) return;

    for (const lockName of lockNames) {
      const [lockRows] = await connection.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 5) AS acquired",
        [lockName],
      );
      if (Number(lockRows[0]?.acquired) !== 1) {
        respondError(res, 503, "MPI_BUSY", "The patient identity check is busy. Please retry.");
        return;
      }
      acquiredLocks.push(lockName);
    }

    await connection.beginTransaction();
    transactionStarted = true;
    const candidateRows = await findDuplicateRows(connection, parsed.data.facilityId, nameHash, birthDateHash);
    const candidates = candidateRows.slice(0, 20);
    if (candidateRows.length > 20) {
      await connection.rollback();
      transactionStarted = false;
      respondError(res, 409, "DUPLICATE_REVIEW_TOO_MANY", "Too many possible matches were found. Refine the identity or refer this case to records staff.");
      return;
    }

    const reviews = parsed.data.duplicateReviews ?? [];
    const reviewedIds = new Set(reviews.map((review) => review.candidatePatientId));
    const expectedIds = new Set(candidates.map((candidate) => candidate.patient_id));
    const reviewSetMatches = reviewedIds.size === expectedIds.size &&
      [...expectedIds].every((candidateId) => reviewedIds.has(candidateId));

    if (candidates.length > 0 && !reviewSetMatches) {
      await connection.rollback();
      transactionStarted = false;
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "patient.registration.duplicate_review_required",
        resourceType: "facility",
        resourceId: String(parsed.data.facilityId),
        outcome: "denied",
        ipAddress: req.ip,
      });
      respondError(res, 409, "DUPLICATE_CANDIDATES", "Review the possible matches before registering this patient.", {
        candidates: candidates.map((row) => {
          const demographics = decryptPatient(row);
          return {
            patientId: row.patient_id,
            recordNumber: row.record_number,
            givenName: demographics.givenName,
            familyName: demographics.familyName,
            dateOfBirth: demographics.dateOfBirth,
            sameName: row.normalized_name_hmac.equals(nameHash),
            sameDateOfBirth: row.birth_date_hmac.equals(birthDateHash),
          };
        }),
        automaticMerge: false,
      });
      return;
    }
    if (reviews.some((review) => !expectedIds.has(review.candidatePatientId))) {
      await connection.rollback();
      transactionStarted = false;
      respondError(res, 400, "INVALID_DUPLICATE_REVIEW", "Review only the candidate records returned by the current MPI check.");
      return;
    }
    if (reviews.some((review) => review.disposition === "same_person")) {
      for (const candidate of candidates) {
        const review = reviews.find((item) => item.candidatePatientId === candidate.patient_id);
        if (!review) throw new Error("MPI candidate review set changed during the registration transaction.");
        await connection.execute(
          `INSERT INTO patient_duplicate_reviews
            (facility_id, new_patient_id, possible_duplicate_patient_id, reviewer_user_id,
             disposition, reason, proposed_name_hmac, proposed_birth_date_hmac, occurred_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
          [
            parsed.data.facilityId,
            candidate.patient_id,
            principal.userId,
            review.disposition,
            review.reason,
            nameHash,
            birthDateHash,
          ],
        );
      }
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "patient.registration.existing_patient_identified",
        resourceType: "facility",
        resourceId: String(parsed.data.facilityId),
        outcome: "denied",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
      transactionStarted = false;
      respondError(res, 409, "POSSIBLE_EXISTING_PATIENT", "A reviewer identified an existing patient. Continue with the selected existing record; this workflow does not merge or create a duplicate.", {
        existingPatientIds: reviews.filter((review) => review.disposition === "same_person").map((review) => review.candidatePatientId),
      });
      return;
    }

    const recordNumber = `${facility.facility_code}-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const demographics: PatientDemographics = {
      givenName: parsed.data.givenName,
      familyName: parsed.data.familyName,
      dateOfBirth: parsed.data.dateOfBirth,
      sexAtRegistration: parsed.data.sexAtRegistration,
    };
    const [insertResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO patients
        (facility_id, record_number, demographics_ciphertext, normalized_name_hmac, birth_date_hmac,
         status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        parsed.data.facilityId,
        recordNumber,
        encryptData(JSON.stringify(demographics)),
        nameHash,
        birthDateHash,
        principal.userId,
      ],
    );
    const patientId = Number(insertResult.insertId);

    if (candidates.length > 0) {
      for (const candidate of candidates) {
        const review = reviews.find((item) => item.candidatePatientId === candidate.patient_id);
        if (!review) throw new Error("MPI candidate review set changed during the registration transaction.");
        await connection.execute(
          `INSERT INTO patient_duplicate_reviews
            (facility_id, new_patient_id, possible_duplicate_patient_id, reviewer_user_id,
             disposition, reason, proposed_name_hmac, proposed_birth_date_hmac, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
          [
            parsed.data.facilityId,
            patientId,
            candidate.patient_id,
            principal.userId,
            review.disposition,
            review.reason,
            nameHash,
            birthDateHash,
          ],
        );
      }
    }
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "patient.registration.create",
      resourceType: "patient",
      resourceId: String(patientId),
      outcome: "changed",
      ipAddress: req.ip,
    }, connection);
    await connection.commit();
    transactionStarted = false;

    res.status(201).json({
      patient: {
        patientId,
        facilityId: parsed.data.facilityId,
        recordNumber,
        ...demographics,
        createdAt: new Date().toISOString(),
      },
      duplicateReview: candidates.length > 0 ? "reviewed_as_different_people" : "no_candidates_found",
      automaticMerge: false,
    });
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    next(error);
  } finally {
    for (const lockName of acquiredLocks) {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", event: "mpi.lock.release.failed", error: error instanceof Error ? error.name : "UnknownError" }));
      });
    }
    connection.release();
  }
});

patientsRouter.post("/search", requirePermission("patient.mpi.search"), async (req, res, next) => {
  const principal = req.principal;
  const parsed = patientSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    respondError(res, 400, "INVALID_REQUEST", "Provide a record number or both given and family names.", parsed.error.flatten());
    return;
  }
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return;
  }
  if (!dataCryptoReady()) {
    respondError(res, 503, "PATIENT_DATA_KEYS_REQUIRED", "Patient encryption and lookup keys are not configured.");
    return;
  }

  try {
    const facility = await getScopedFacility(req, res, parsed.data.facilityId);
    if (!facility) return;

    let sql: string;
    let values: (string | number | Buffer)[];
    if (parsed.data.recordNumber) {
      sql = `SELECT patient_id, facility_id, record_number, demographics_ciphertext,
                    normalized_name_hmac, birth_date_hmac, created_at
             FROM patients
             WHERE facility_id = ? AND record_number = ? AND status = 'active'
             LIMIT 20`;
      values = [parsed.data.facilityId, parsed.data.recordNumber];
    } else {
      const normalizedName = normalizeFullPatientName({
        givenName: parsed.data.givenName!,
        familyName: parsed.data.familyName!,
      });
      const nameHash = createPatientLookupHash(normalizedName);
      if (parsed.data.dateOfBirth) {
        sql = `SELECT patient_id, facility_id, record_number, demographics_ciphertext,
                      normalized_name_hmac, birth_date_hmac, created_at
               FROM patients
               WHERE facility_id = ? AND normalized_name_hmac = ? AND birth_date_hmac = ? AND status = 'active'
               ORDER BY created_at DESC LIMIT 20`;
        values = [parsed.data.facilityId, nameHash, createPatientLookupHash(parsed.data.dateOfBirth)];
      } else {
        sql = `SELECT patient_id, facility_id, record_number, demographics_ciphertext,
                      normalized_name_hmac, birth_date_hmac, created_at
               FROM patients
               WHERE facility_id = ? AND normalized_name_hmac = ? AND status = 'active'
               ORDER BY created_at DESC LIMIT 20`;
        values = [parsed.data.facilityId, nameHash];
      }
    }

    const [rows] = await pool.execute<PatientRow[]>(sql, values);
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "patient.mpi.search",
      resourceType: "facility",
      resourceId: String(parsed.data.facilityId),
      outcome: "allowed",
      ipAddress: req.ip,
    });
    res.json({
      patients: rows.slice(0, 20).map((row) => ({
        patientId: row.patient_id,
        facilityId: row.facility_id,
        recordNumber: row.record_number,
        ...decryptPatient(row),
        createdAt: row.created_at,
      })),
      truncated: rows.length > 20,
      automaticMerge: false,
    });
  } catch (error) {
    next(error);
  }
});

patientsRouter.param("patientId", (req, res, next, patientId) => {
  if (!/^\d+$/u.test(patientId)) {
    respondError(res, 400, "INVALID_PATIENT_ID", "Patient identifier must be a numeric ID.");
    return;
  }
  next();
});

patientsRouter.get("/:patientId", requirePermission("patient.mpi.read"), async (req, res, next: NextFunction) => {
  const principal = req.principal;
  if (!principal) {
    respondError(res, 401, "UNAUTHENTICATED", "Sign in is required.");
    return;
  }
  if (!dataCryptoReady()) {
    respondError(res, 503, "PATIENT_DATA_KEYS_REQUIRED", "Patient encryption and lookup keys are not configured.");
    return;
  }
  const patientId = req.params.patientId;
  if (typeof patientId !== "string") {
    respondError(res, 400, "INVALID_PATIENT_ID", "Patient identifier must be a numeric ID.");
    return;
  }
  try {
    const [rows] = await pool.execute<PatientRow[]>(
      `SELECT patient_id, facility_id, record_number, demographics_ciphertext,
              normalized_name_hmac, birth_date_hmac, created_at
       FROM patients WHERE patient_id = ? AND status = 'active' LIMIT 1`,
      [patientId],
    );
    const patient = rows[0];
    if (!patient) {
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "patient.mpi.read",
        resourceType: "patient",
        resourceId: patientId,
        outcome: "denied",
        ipAddress: req.ip,
      });
      respondError(res, 404, "PATIENT_NOT_FOUND", "No accessible patient record was found.");
      return;
    }
    if (!canAccessFacility(principal, patient.facility_id)) {
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "patient.mpi.read",
        resourceType: "patient",
        resourceId: String(patient.patient_id),
        outcome: "denied",
        ipAddress: req.ip,
      });
      respondError(res, 404, "PATIENT_NOT_FOUND", "No accessible patient record was found.");
      return;
    }
    await writeAuditEvent({
      actorUserId: principal.userId,
      action: "patient.mpi.read",
      resourceType: "patient",
      resourceId: String(patient.patient_id),
      outcome: "allowed",
      ipAddress: req.ip,
    });
    res.json({
      patient: {
        patientId: patient.patient_id,
        facilityId: patient.facility_id,
        recordNumber: patient.record_number,
        ...decryptPatient(patient),
        createdAt: patient.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

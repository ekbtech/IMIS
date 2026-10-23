import { createHash, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { encryptData, isDataEncryptionConfigured } from "../security/data-encryption.js";
import { integrationOutboxMessageSchema, type IntegrationOutboxMessage } from "../validation/integration.js";

interface ConnectionRow extends RowDataPacket {
  connection_id: number;
  facility_id: number;
  specification_reference: string;
  approved_by: number;
  approved_at: Date;
}

interface ExistingMessageRow extends RowDataPacket {
  message_uuid: string;
  event_type: string;
  source_resource_type: string;
  source_resource_id: string;
  payload_hash: Buffer;
  created_by: number | null;
}

export class IntegrationDisabledError extends Error {
  readonly code = "INTEGRATION_DISABLED";
}

export class IntegrationIdempotencyConflictError extends Error {
  readonly code = "INTEGRATION_IDEMPOTENCY_CONFLICT";
}

/** Call within the domain transaction, after authorizing the actor for the facility. */
export async function enqueueIntegrationOutbox(
  connection: PoolConnection,
  facilityId: number,
  actorUserId: number | null,
  input: IntegrationOutboxMessage,
): Promise<{ messageId: string; idempotentReplay: boolean }> {
  const parsed = integrationOutboxMessageSchema.safeParse(input);
  if (!parsed.success) throw new TypeError("Integration outbox message is invalid.");
  if (!isDataEncryptionConfigured()) throw new Error("DATA_ENCRYPTION_KEY is required for integration payloads.");
  const message = parsed.data;
  const serializedPayload = JSON.stringify(message.payload);
  const payloadHash = createHash("sha256").update(serializedPayload, "utf8").digest();
  const [connectionRows] = await connection.execute<ConnectionRow[]>(
    `SELECT connection_id, facility_id, specification_reference, approved_by, approved_at
     FROM integration_connections
     WHERE facility_id = ? AND integration_code = ? AND status = 'enabled'
       AND specification_reference IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL
     LIMIT 1 FOR UPDATE`,
    [facilityId, message.integrationCode],
  );
  const configuredConnection = connectionRows[0];
  if (!configuredConnection) throw new IntegrationDisabledError("No approved active integration is configured for this facility.");

  const [existingRows] = await connection.execute<ExistingMessageRow[]>(
    `SELECT message_uuid, event_type, source_resource_type, source_resource_id,
            payload_hash, created_by
     FROM integration_outbox
     WHERE facility_id = ? AND integration_code = ? AND idempotency_key = ?
     LIMIT 1 FOR UPDATE`,
    [configuredConnection.facility_id, message.integrationCode, message.idempotencyKey],
  );
  const existing = existingRows[0];
  if (existing) {
    const matches = existing.event_type === message.eventType &&
      existing.source_resource_type === message.sourceResourceType &&
      existing.source_resource_id === message.sourceResourceId &&
      existing.payload_hash.equals(payloadHash) &&
      (existing.created_by === null ? actorUserId === null : Number(existing.created_by) === actorUserId);
    if (!matches) throw new IntegrationIdempotencyConflictError("The integration idempotency key was used for a different event.");
    return { messageId: existing.message_uuid, idempotentReplay: true };
  }

  const messageId = randomUUID();
  const [result] = await connection.execute<ResultSetHeader>(
    `INSERT INTO integration_outbox
      (message_uuid, facility_id, connection_id, integration_code, event_type,
       source_resource_type, source_resource_id, idempotency_key, payload_ciphertext,
       payload_hash, status, attempt_count, next_attempt_at, delivered_at,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, ?,
             UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
    [
      messageId, configuredConnection.facility_id, configuredConnection.connection_id,
      message.integrationCode, message.eventType, message.sourceResourceType,
      message.sourceResourceId, message.idempotencyKey, encryptData(serializedPayload),
      payloadHash, actorUserId,
    ],
  );
  await connection.execute(
    `INSERT INTO integration_reconciliation
      (facility_id, outbox_id, status, evidence_reference, reconciled_by, reconciled_at)
     VALUES (?, ?, 'pending', NULL, NULL, NULL)`,
    [configuredConnection.facility_id, result.insertId],
  );
  return { messageId, idempotentReplay: false };
}

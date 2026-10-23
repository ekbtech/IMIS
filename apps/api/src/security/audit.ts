import { randomUUID } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { pool } from "../db.js";

interface AuditEvent {
  actorUserId: number | null;
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome: "allowed" | "denied" | "changed" | "failed";
  ipAddress?: string | null;
}

export async function writeAuditEvent(event: AuditEvent, connection?: PoolConnection): Promise<void> {
  const executor = connection ?? pool;
  await executor.execute(
    `INSERT INTO audit_events
      (event_uuid, actor_user_id, action_code, resource_type, resource_id, outcome, ip_address, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
    [
      randomUUID(),
      event.actorUserId,
      event.action,
      event.resourceType,
      event.resourceId ?? null,
      event.outcome,
      event.ipAddress ?? null,
    ],
  );
}

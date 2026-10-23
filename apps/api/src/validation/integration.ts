import { z } from "zod";

export const integrationCodeSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
export const integrationEventTypeSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
export const integrationSourceTypeSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,79}$/);
export const integrationSourceIdSchema = z.string().trim().min(1).max(100);
export const integrationIdempotencyKeySchema = z.string().uuid();
const blockedPayloadKeys = /(?:endpoint|url|password|secret|token|authorization|credential|apikey)/;

function hasBlockedPayloadKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBlockedPayloadKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return blockedPayloadKeys.test(normalizedKey) || hasBlockedPayloadKey(nested);
  });
}

export const integrationPayloadSchema = z.record(z.string(), z.json()).superRefine((payload, context) => {
  if (hasBlockedPayloadKey(payload)) {
    context.addIssue({
      code: "custom",
      message: "Payloads cannot contain endpoint or credential fields.",
    });
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > 16000) {
    context.addIssue({
      code: "custom",
      message: "Integration event payload exceeds the encrypted storage limit.",
    });
  }
});

export const integrationOutboxMessageSchema = z.object({
  integrationCode: integrationCodeSchema,
  eventType: integrationEventTypeSchema,
  sourceResourceType: integrationSourceTypeSchema,
  sourceResourceId: integrationSourceIdSchema,
  idempotencyKey: integrationIdempotencyKeySchema,
  payload: integrationPayloadSchema,
}).strict();

export type IntegrationOutboxMessage = z.infer<typeof integrationOutboxMessageSchema>;

import { describe, expect, it } from "vitest";
import { integrationOutboxMessageSchema } from "../src/validation/integration.js";

const validMessage = {
  integrationCode: "local.health-record",
  eventType: "encounter.updated",
  sourceResourceType: "encounter",
  sourceResourceId: "c08cd541-3535-45d2-97d0-2b0ed80df990",
  idempotencyKey: "d9428888-122b-4e09-a6f7-6c8f8a4a9d01",
  payload: { synthetic: true, event: "test" },
};

describe("disconnected integration outbox validation", () => {
  it("accepts a bounded internal event contract", () => {
    expect(integrationOutboxMessageSchema.safeParse(validMessage).success).toBe(true);
  });

  it("rejects endpoint/credential-shaped fields and malformed identifiers", () => {
    expect(integrationOutboxMessageSchema.safeParse({
      ...validMessage,
      payload: { ...validMessage.payload, nested: { endpoint_url: "https://example.invalid", client_secret: "secret" } },
    }).success).toBe(false);
    expect(integrationOutboxMessageSchema.safeParse({
      ...validMessage,
      integrationCode: "Bad Code",
    }).success).toBe(false);
  });

  it("rejects non-JSON payload values", () => {
    expect(integrationOutboxMessageSchema.safeParse({
      ...validMessage,
      payload: { value: BigInt(1) },
    }).success).toBe(false);
  });

  it("rejects payloads that exceed the encrypted storage budget", () => {
    expect(integrationOutboxMessageSchema.safeParse({
      ...validMessage,
      payload: { text: "x".repeat(16000) },
    }).success).toBe(false);
  });
});

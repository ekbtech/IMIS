import type { PoolConnection } from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueIntegrationOutbox,
  IntegrationDisabledError,
} from "../src/integrations/outbox.js";
import type { IntegrationOutboxMessage } from "../src/validation/integration.js";

const message: IntegrationOutboxMessage = {
  integrationCode: "local.health-record",
  eventType: "encounter.updated",
  sourceResourceType: "encounter",
  sourceResourceId: "c08cd541-3535-45d2-97d0-2b0ed80df990",
  idempotencyKey: "d9428888-122b-4e09-a6f7-6c8f8a4a9d01",
  payload: { synthetic: true },
};

function createConnection(responses: [unknown, unknown][]) {
  const execute = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected database call in test.");
    return response;
  });
  return {
    connection: { execute } as unknown as PoolConnection,
    execute,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("integration outbox persistence helper", () => {
  it("binds the approved connection lookup to the requested facility", async () => {
    vi.stubEnv("DATA_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
    const facilityId = 41;
    const { connection, execute } = createConnection([
      [[{
        connection_id: 17,
        facility_id: facilityId,
        specification_reference: "approved-contract",
        approved_by: 8,
        approved_at: new Date(),
      }], []],
      [[], []],
      [{ insertId: 29 }, []],
      [{ affectedRows: 1 }, []],
    ]);

    const result = await enqueueIntegrationOutbox(connection, facilityId, 8, message);

    expect(result.idempotentReplay).toBe(false);
    expect(execute.mock.calls[0]?.[1]).toEqual([facilityId, message.integrationCode]);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("fails closed when no enabled, approved connection exists for the facility", async () => {
    vi.stubEnv("DATA_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
    const { connection, execute } = createConnection([[[], []]]);

    await expect(enqueueIntegrationOutbox(connection, 41, 8, message))
      .rejects.toBeInstanceOf(IntegrationDisabledError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

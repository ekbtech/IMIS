import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Facility = { facility_id: number; facility_code: string; name: string };
type Department = { department_id: number; name: string };
type InventoryItem = {
  inventoryItemId: number;
  itemCode: string;
  name: string;
  unitOfMeasure: string;
  lot: {
    stockLotId: number;
    batchCode: string;
    expiresOn: string | null;
    quantityOnHand: number;
  } | null;
};
type Movement = {
  movementId: string;
  type: "receipt" | "issue";
  quantity: number;
  reference: string;
  itemCode: string;
  itemName: string;
  unitOfMeasure: string;
  batchCode: string;
  destinationDepartment: string | null;
  actor: string;
  occurredAt: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null ? body.error : null;
    throw new Error(
      error && "message" in error && typeof error.message === "string"
        ? error.message
        : "The inventory request could not be completed.",
    );
  }
  return body as T;
}

export default function InventoryWorkspace({
  isSystemAdmin,
  canRead,
  canManageCatalog,
  canReceive,
  canIssue,
}: {
  isSystemAdmin: boolean;
  canRead: boolean;
  canManageCatalog: boolean;
  canReceive: boolean;
  canIssue: boolean;
}) {
  const queryClient = useQueryClient();
  const [facilityId, setFacilityId] = useState<number>();
  const [departmentId, setDepartmentId] = useState("");
  const [itemCode, setItemCode] = useState("");
  const [itemName, setItemName] = useState("");
  const [unitOfMeasure, setUnitOfMeasure] = useState("");
  const [movementType, setMovementType] = useState<"receipt" | "issue">(canReceive ? "receipt" : "issue");
  const [movementItemId, setMovementItemId] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [quantity, setQuantity] = useState("");
  const [reference, setReference] = useState("");
  const [issueToDepartmentId, setIssueToDepartmentId] = useState("");
  const [movementKey, setMovementKey] = useState(() => window.crypto.randomUUID());
  const [feedback, setFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const facilitiesQuery = useQuery({
    queryKey: ["assigned-facilities"],
    queryFn: () => request<{ facilities: Facility[] }>(
      isSystemAdmin ? "/api/v1/admin/facilities" : "/api/v1/facilities",
    ),
    retry: false,
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const selectedFacilityId = facilityId ?? facilities[0]?.facility_id;
  const departmentsQuery = useQuery({
    queryKey: ["inventory-departments", selectedFacilityId],
    queryFn: () => request<{ departments: Department[] }>(
      `/api/v1/inventory/facilities/${selectedFacilityId}/departments`,
    ),
    enabled: Boolean(selectedFacilityId && canRead),
    retry: false,
  });
  const departments = departmentsQuery.data?.departments ?? [];
  const selectedDepartmentId = Number(departmentId) || departments[0]?.department_id;
  const workspaceUrl = selectedFacilityId && selectedDepartmentId
    ? `/api/v1/inventory/facilities/${selectedFacilityId}/departments/${selectedDepartmentId}`
    : "";
  const workspaceQuery = useQuery({
    queryKey: ["inventory-workspace", selectedFacilityId, selectedDepartmentId],
    queryFn: () => request<{ items: InventoryItem[]; movements: Movement[]; truncated: boolean }>(workspaceUrl),
    enabled: Boolean(workspaceUrl && canRead),
    retry: false,
    refetchInterval: 30_000,
  });
  const issueTargetsQuery = useQuery({
    queryKey: ["inventory-issue-targets", selectedFacilityId, selectedDepartmentId],
    queryFn: () => request<{ departments: Department[] }>(
      `/api/v1/inventory/facilities/${selectedFacilityId}/departments/${selectedDepartmentId}/issue-targets`,
    ),
    enabled: Boolean(selectedFacilityId && selectedDepartmentId && canIssue),
    retry: false,
  });
  const items = workspaceQuery.data?.items ?? [];
  const movements = workspaceQuery.data?.movements ?? [];
  const selectedItem = items.find((item) => String(item.inventoryItemId) === movementItemId);

  const invalidateWorkspace = async () => {
    await queryClient.invalidateQueries({ queryKey: ["inventory-workspace", selectedFacilityId, selectedDepartmentId] });
  };
  const createItem = useMutation({
    mutationFn: () => request<{ item: InventoryItem }>(
      `/api/v1/inventory/facilities/${selectedFacilityId}/departments/${selectedDepartmentId}/items`,
      {
        method: "POST",
        body: JSON.stringify({ itemCode, name: itemName, unitOfMeasure }),
      },
    ),
    onSuccess: async (result) => {
      setFeedback(`Added ${result.item.name} to the facility inventory catalogue.`);
      setErrorMessage("");
      setItemCode("");
      setItemName("");
      setUnitOfMeasure("");
      await invalidateWorkspace();
    },
    onError: (error) => {
      setFeedback("");
      setErrorMessage(error.message);
    },
  });
  const saveMovement = useMutation({
    mutationFn: () => request<{ movementId: string; idempotentReplay: boolean }>(
      `/api/v1/inventory/facilities/${selectedFacilityId}/departments/${selectedDepartmentId}/movements`,
      {
        method: "POST",
        headers: { "Idempotency-Key": movementKey },
        body: JSON.stringify({
          movementType,
          inventoryItemId: Number(movementItemId),
          batchCode,
          ...(expiresOn && movementType === "receipt" ? { expiresOn } : {}),
          quantity: Number(quantity),
          reference,
          ...(movementType === "issue" ? { issueToDepartmentId: Number(issueToDepartmentId) } : {}),
        }),
      },
    ),
    onSuccess: async (result) => {
      setFeedback(`${result.idempotentReplay ? "Existing" : "New"} ${movementType} movement recorded.`);
      setErrorMessage("");
      setBatchCode("");
      setExpiresOn("");
      setQuantity("");
      setReference("");
      setIssueToDepartmentId("");
      setMovementKey(window.crypto.randomUUID());
      await invalidateWorkspace();
    },
    onError: (error) => {
      setFeedback("");
      setErrorMessage(error.message);
    },
  });

  if (facilitiesQuery.isPending) return <p className="muted">Loading assigned facilities…</p>;
  if (facilitiesQuery.isError) return <p className="form-error" role="alert">{facilitiesQuery.error.message}</p>;
  if (facilities.length === 0) return <p className="notice-card">No active facility is assigned to this account.</p>;

  return (
    <section className="inventory-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">STORES · INVENTORY</p>
          <h1>Stock ledger</h1>
          <p className="muted">Facility stock by item and batch, with auditable receipts and issues.</p>
        </div>
        <span className="access-tag">Department-scoped · audited</span>
      </div>
      <div className="notice-card">
        <span className="notice-icon" aria-hidden="true">i</span>
        <div>
          <strong>Stock movement records only</strong>
          <p>This slice does not value stock, connect to procurement, reserve stock, perform automatic FEFO allocation, or authorize clinical prescribing. Follow the facility-approved receiving, storage and issue procedures.</p>
        </div>
      </div>
      <section className="workflow-card">
        <div className="inventory-scope-fields">
          <label>
            Facility
            <select value={selectedFacilityId ?? ""} onChange={(event) => {
              setFacilityId(Number(event.target.value));
              setDepartmentId("");
              setMovementItemId("");
            }}>
              {facilities.map((facility) => <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>)}
            </select>
          </label>
          <label>
            Inventory department
            <select value={selectedDepartmentId ?? ""} onChange={(event) => {
              setDepartmentId(event.target.value);
              setMovementItemId("");
            }} disabled={departmentsQuery.isPending || departments.length === 0}>
              <option value="">Choose assigned inventory department</option>
              {departments.map((department) => (
                <option key={department.department_id} value={department.department_id}>{department.name}</option>
              ))}
            </select>
          </label>
        </div>
        {departmentsQuery.isError && <p className="form-error" role="alert">{departmentsQuery.error.message}</p>}
        {departmentsQuery.data?.departments.length === 0 && <p className="muted">No inventory department is assigned to your account at this facility.</p>}
        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        {feedback && <p className="inline-message" role="status">{feedback}</p>}
      </section>

      {selectedDepartmentId && (
        <>
          {canManageCatalog && (
            <section className="workflow-card">
              <h2>Add catalogue item</h2>
              <form className="inventory-form" onSubmit={(event) => {
                event.preventDefault();
                setErrorMessage("");
                createItem.mutate();
              }}>
                <label>Item code<input value={itemCode} onChange={(event) => setItemCode(event.target.value)} maxLength={64} pattern="[A-Za-z0-9._-]+" required /></label>
                <label>Item name<input value={itemName} onChange={(event) => setItemName(event.target.value)} minLength={2} maxLength={190} required /></label>
                <label>Unit of measure<input value={unitOfMeasure} onChange={(event) => setUnitOfMeasure(event.target.value)} maxLength={32} placeholder="e.g. box, each, litre" required /></label>
                <button className="primary-button" type="submit" disabled={createItem.isPending || !itemCode.trim() || !itemName.trim() || !unitOfMeasure.trim()}>
                  {createItem.isPending ? "Adding…" : "Add item"}
                </button>
              </form>
            </section>
          )}

          {(canReceive || canIssue) && (
            <section className="workflow-card">
              <h2>Record stock movement</h2>
              <form className="inventory-form" onSubmit={(event) => {
                event.preventDefault();
                setErrorMessage("");
                saveMovement.mutate();
              }}>
                <label>
                  Movement
                  <select value={movementType} onChange={(event) => {
                    const nextType = event.target.value;
                    if (nextType === "receipt" || nextType === "issue") {
                      setMovementType(nextType);
                      setMovementKey(window.crypto.randomUUID());
                    }
                  }}>
                    {canReceive && <option value="receipt">Receive into stock</option>}
                    {canIssue && <option value="issue">Issue to department</option>}
                  </select>
                </label>
                <label>
                  Item
                  <select value={movementItemId} onChange={(event) => {
                    setMovementItemId(event.target.value);
                    setMovementKey(window.crypto.randomUUID());
                  }} required>
                    <option value="">Choose item</option>
                    {items.map((item) => (
                      <option key={item.inventoryItemId} value={item.inventoryItemId}>{item.itemCode} · {item.name}</option>
                    ))}
                  </select>
                </label>
                {movementType === "issue" && (
                  <>
                    <label>
                      Available batch
                      <select value={batchCode} onChange={(event) => {
                        setBatchCode(event.target.value);
                        setMovementKey(window.crypto.randomUUID());
                      }} required>
                        <option value="">Choose a batch</option>
                        {items.filter((item) => item.inventoryItemId === Number(movementItemId) && item.lot && item.lot.quantityOnHand > 0).map((item) => (
                          <option key={item.lot!.stockLotId} value={item.lot!.batchCode}>
                            {item.lot!.batchCode} · {item.lot!.quantityOnHand} {item.unitOfMeasure}
                            {item.lot!.expiresOn ? ` · expires ${item.lot!.expiresOn}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Issue to
                      <select value={issueToDepartmentId} onChange={(event) => {
                        setIssueToDepartmentId(event.target.value);
                        setMovementKey(window.crypto.randomUUID());
                      }} required>
                        <option value="">Choose receiving department</option>
                        {(issueTargetsQuery.data?.departments ?? []).map((department) => (
                          <option key={department.department_id} value={department.department_id}>{department.name}</option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {movementType === "receipt" && (
                  <>
                    <label>Batch / lot code<input value={batchCode} onChange={(event) => {
                      setBatchCode(event.target.value);
                      setMovementKey(window.crypto.randomUUID());
                    }} maxLength={100} required /></label>
                    <label>Expiry date (optional)<input type="date" value={expiresOn} onChange={(event) => {
                      setExpiresOn(event.target.value);
                      setMovementKey(window.crypto.randomUUID());
                    }} /></label>
                  </>
                )}
                <label>Quantity {selectedItem ? `(${selectedItem.unitOfMeasure})` : ""}<input type="number" min="0.001" max="99999999999.999" step="0.001" value={quantity} onChange={(event) => {
                  setQuantity(event.target.value);
                  setMovementKey(window.crypto.randomUUID());
                }} required /></label>
                <label>Reference<input value={reference} onChange={(event) => {
                  setReference(event.target.value);
                  setMovementKey(window.crypto.randomUUID());
                }} minLength={2} maxLength={120} required placeholder="Delivery note or issue reference" /></label>
                <button className="primary-button" type="submit" disabled={
                  saveMovement.isPending || !movementKey || !movementItemId || !batchCode.trim() ||
                  Number(quantity) <= 0 || !reference.trim() ||
                  (movementType === "issue" && !issueToDepartmentId)
                }>
                  {saveMovement.isPending ? "Saving…" : movementType === "receipt" ? "Record receipt" : "Record issue"}
                </button>
              </form>
            </section>
          )}

          <section className="workflow-card">
            <div className="section-title">
              <div><h2>Stock by item and batch</h2><p>Quantities are stored by the unit entered in the item catalogue.</p></div>
              <button className="text-button" type="button" onClick={() => void workspaceQuery.refetch()}>Refresh</button>
            </div>
            {workspaceQuery.isPending && <p className="muted">Loading stock ledger…</p>}
            {workspaceQuery.isError && <p className="form-error" role="alert">{workspaceQuery.error.message}</p>}
            {issueTargetsQuery.isError && <p className="form-error" role="alert">{issueTargetsQuery.error.message}</p>}
            {workspaceQuery.data?.items.length === 0 && <p className="muted">No inventory items have been added to this facility catalogue.</p>}
            {workspaceQuery.data && workspaceQuery.data.items.length > 0 && (
              <div className="table-scroll">
                <table className="inventory-table">
                  <thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th>On hand</th></tr></thead>
                  <tbody>{workspaceQuery.data.items.map((item, index) => (
                    <tr key={`${item.inventoryItemId}-${item.lot?.stockLotId ?? index}`}>
                      <td>{item.itemCode} · {item.name}</td>
                      <td>{item.lot?.batchCode ?? "—"}</td>
                      <td>{item.lot?.expiresOn ?? "—"}</td>
                      <td>{item.lot?.quantityOnHand ?? 0} {item.unitOfMeasure}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>

          <section className="workflow-card">
            <div className="section-title"><div><h2>Recent stock movements</h2><p>Latest 100 receipts and issues for this department.</p></div></div>
            {workspaceQuery.data?.movements.length === 0 && <p className="muted">No stock movements have been recorded.</p>}
            {movements.map((movement) => (
              <article className="triage-arrival" key={movement.movementId}>
                <div>
                  <strong>{movement.type === "receipt" ? "Receipt" : "Issue"} · {movement.itemCode} · batch {movement.batchCode}</strong>
                  <p>{movement.quantity} {movement.unitOfMeasure} · {movement.reference}</p>
                  {movement.destinationDepartment && <p>Issued to {movement.destinationDepartment}</p>}
                  <p className="field-hint">{movement.actor} · {new Date(movement.occurredAt).toLocaleString()}</p>
                </div>
              </article>
            ))}
            {workspaceQuery.data?.truncated && <p className="field-hint">Movement history is limited to the latest 100 entries.</p>}
          </section>
        </>
      )}
    </section>
  );
}

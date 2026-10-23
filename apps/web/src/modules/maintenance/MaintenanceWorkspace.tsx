import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Facility = { facility_id: number; name: string };
type Department = { department_id: number; name: string };
type MaintenanceEvent = {
  type: string;
  previousStatus: string | null;
  status: string;
  note: string | null;
  actor: string;
  occurredAt: string;
};
type MaintenanceRequest = {
  requestId: string;
  reportingDepartmentId: number;
  reportingDepartment: string;
  assetTag: string;
  location: string;
  issue: string;
  status: "requested" | "acknowledged" | "in_progress" | "completed" | "cancelled";
  requestedBy: string;
  requestedAt: string;
  handledBy: string | null;
  handledAt: string | null;
  canCancel: boolean;
  events: MaintenanceEvent[];
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
        : "The maintenance request could not be completed.",
    );
  }
  return body as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function MaintenanceWorkspace({
  isSystemAdmin,
  canCreate,
  canRead,
  canManage,
  biomedicalFacilityIds,
}: {
  isSystemAdmin: boolean;
  canCreate: boolean;
  canRead: boolean;
  canManage: boolean;
  biomedicalFacilityIds: number[];
}) {
  const queryClient = useQueryClient();
  const [facilitySelection, setFacilitySelection] = useState("");
  const [departmentSelection, setDepartmentSelection] = useState("");
  const [assetTag, setAssetTag] = useState("");
  const [location, setLocation] = useState("");
  const [issue, setIssue] = useState("");
  const [note, setNote] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => window.crypto.randomUUID());
  const [feedback, setFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const facilitiesQuery = useQuery({
    queryKey: ["maintenance-facilities"],
    queryFn: () => request<{ facilities: Facility[] }>(
      isSystemAdmin ? "/api/v1/admin/facilities" : "/api/v1/facilities",
    ),
    retry: false,
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const selectedFacilityId = Number(facilitySelection) || facilities[0]?.facility_id;
  const canManageSelectedFacility = canManage && biomedicalFacilityIds.includes(selectedFacilityId);
  const departmentsQuery = useQuery({
    queryKey: ["maintenance-departments", selectedFacilityId],
    queryFn: () => request<{ departments: Department[] }>(
      `/api/v1/maintenance/facilities/${selectedFacilityId}/departments`,
    ),
    enabled: Boolean(selectedFacilityId && canCreate),
    retry: false,
  });
  const departments = departmentsQuery.data?.departments ?? [];
  const selectedDepartmentId = Number(departmentSelection) || departments[0]?.department_id;
  const requestsQuery = useQuery({
    queryKey: ["maintenance-requests", selectedFacilityId],
    queryFn: () => request<{ requests: MaintenanceRequest[]; truncated: boolean }>(
      `/api/v1/maintenance/facilities/${selectedFacilityId}/requests`,
    ),
    enabled: Boolean(selectedFacilityId && canRead),
    retry: false,
    refetchInterval: 30_000,
  });

  const invalidateRequests = async () => {
    await queryClient.invalidateQueries({ queryKey: ["maintenance-requests", selectedFacilityId] });
  };
  const createRequest = useMutation({
    mutationFn: () => request<{ idempotentReplay: boolean }>(
      `/api/v1/maintenance/facilities/${selectedFacilityId}/requests`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          reportingDepartmentId: selectedDepartmentId,
          assetTag,
          location,
          issue,
        }),
      },
    ),
    onSuccess: async (result) => {
      setFeedback(result.idempotentReplay ? "This report was already recorded." : "Maintenance request submitted to Biomedical Engineering.");
      setErrorMessage("");
      setAssetTag("");
      setLocation("");
      setIssue("");
      setIdempotencyKey(window.crypto.randomUUID());
      await invalidateRequests();
    },
    onError: (error) => {
      setFeedback("");
      setErrorMessage(error.message);
    },
  });
  const transition = useMutation({
    mutationFn: ({ requestId, action }: { requestId: string; action: "acknowledge" | "start" | "complete" | "cancel" }) =>
      request(`/api/v1/maintenance/requests/${requestId}/respond`, {
        method: "POST",
        body: JSON.stringify({ action, ...(note.trim() ? { note: note.trim() } : {}) }),
      }),
    onSuccess: async () => {
      setFeedback("Maintenance request status updated.");
      setErrorMessage("");
      setNote("");
      await invalidateRequests();
    },
    onError: (error) => {
      setFeedback("");
      setErrorMessage(error.message);
    },
  });

  const requests = requestsQuery.data?.requests ?? [];

  return (
    <section className="inventory-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">EQUIPMENT SUPPORT</p>
          <h1>Biomedical maintenance</h1>
          <p className="muted">Report equipment problems and follow their acknowledged maintenance status.</p>
        </div>
      </div>

      <section className="organization-section">
        <div className="section-title">
          <div><h2>Facility</h2><p>Requests are restricted to your facility and department assignments.</p></div>
        </div>
        {facilitiesQuery.isError ? <p className="form-error" role="alert">{facilitiesQuery.error.message}</p> : (
          <label className="field-label" htmlFor="maintenance-facility">
            Facility
            <select
              id="maintenance-facility"
              value={selectedFacilityId ?? ""}
              onChange={(event) => {
                setFacilitySelection(event.target.value);
                setDepartmentSelection("");
              }}
              disabled={facilities.length < 2}
            >
              {facilities.map((facility) => <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>)}
            </select>
          </label>
        )}
      </section>

      {canCreate && (
        <section className="organization-section">
          <div className="section-title"><div><h2>Report an equipment fault</h2><p>Describe the observed issue. Do not use this form to authorize equipment for clinical use or declare it safe.</p></div></div>
          {departmentsQuery.isError && <p className="form-error" role="alert">{departmentsQuery.error.message}</p>}
          {departments.length > 0 ? (
            <form className="inventory-form" onSubmit={(event) => {
              event.preventDefault();
              createRequest.mutate();
            }}>
              <label className="field-label" htmlFor="maintenance-department">
                Reporting department
                <select
                  id="maintenance-department"
                  value={selectedDepartmentId ?? ""}
                  onChange={(event) => setDepartmentSelection(event.target.value)}
                >
                  {departments.map((department) => <option key={department.department_id} value={department.department_id}>{department.name}</option>)}
                </select>
              </label>
              <label className="field-label" htmlFor="maintenance-asset-tag">
                Equipment identifier / asset tag
                <input id="maintenance-asset-tag" maxLength={100} required value={assetTag} onChange={(event) => setAssetTag(event.target.value)} />
              </label>
              <label className="field-label" htmlFor="maintenance-location">
                Location
                <input id="maintenance-location" maxLength={250} minLength={2} required value={location} onChange={(event) => setLocation(event.target.value)} />
              </label>
              <label className="field-label" htmlFor="maintenance-issue">
                Observed issue
                <textarea id="maintenance-issue" maxLength={1000} minLength={10} required rows={4} value={issue} onChange={(event) => setIssue(event.target.value)} />
              </label>
              <button className="primary-button" type="submit" disabled={createRequest.isPending || !selectedDepartmentId}>
                {createRequest.isPending ? "Submitting…" : "Submit maintenance request"}
              </button>
            </form>
          ) : !departmentsQuery.isPending && !departmentsQuery.isError ? (
            <p className="muted">Assign this account to a department before submitting a maintenance request.</p>
          ) : null}
        </section>
      )}

      {feedback && <p className="status-message" role="status">{feedback}</p>}
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}

      {canRead && (
        <section className="organization-section">
          <div className="section-title">
            <div><h2>Maintenance requests</h2><p>{canManageSelectedFacility ? "Biomedical Engineering queue and department reports." : "Requests submitted by your assigned departments."}</p></div>
            <span className="module-count">{requests.length} REQUEST{requests.length === 1 ? "" : "S"}</span>
          </div>
          {canManageSelectedFacility && requests.length > 0 && (
            <label className="field-label" htmlFor="maintenance-action-note">
              Status update note <span className="optional-label">optional</span>
              <input id="maintenance-action-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
          )}
          {requestsQuery.isPending ? <p className="muted">Loading maintenance requests…</p> : requestsQuery.isError ? (
            <p className="form-error" role="alert">{requestsQuery.error.message}</p>
          ) : requests.length === 0 ? (
            <p className="muted">No maintenance requests are available for this workspace.</p>
          ) : (
            <div className="inventory-table-wrap">
              <table className="inventory-table">
                <thead><tr><th>Equipment / location</th><th>Department / reported issue</th><th>Status</th><th>Requested by</th><th>History / actions</th></tr></thead>
                <tbody>
                  {requests.map((item) => (
                    <tr key={item.requestId}>
                      <td><strong>{item.assetTag}</strong><br />{item.location}</td>
                      <td><strong>{item.reportingDepartment}</strong><br />{item.issue}</td>
                      <td><span className={`organization-status organization-status-${item.status}`}>{item.status.replaceAll("_", " ")}</span></td>
                      <td>{item.requestedBy}<br /><small>{formatDate(item.requestedAt)}</small></td>
                      <td>
                        {item.events.map((event, index) => (
                          <p key={`${event.type}-${event.occurredAt}-${index}`}>
                            <small>{event.status.replaceAll("_", " ")} · {event.actor} · {formatDate(event.occurredAt)}{event.note ? ` — ${event.note}` : ""}</small>
                          </p>
                        ))}
                        {item.canCancel && <button className="text-button" type="button" disabled={transition.isPending} onClick={() => transition.mutate({ requestId: item.requestId, action: "cancel" })}>Cancel request</button>}
                        {canManageSelectedFacility && item.status === "requested" && <button className="text-button" type="button" disabled={transition.isPending} onClick={() => transition.mutate({ requestId: item.requestId, action: "acknowledge" })}>Acknowledge</button>}
                        {canManageSelectedFacility && item.status === "acknowledged" && <button className="text-button" type="button" disabled={transition.isPending} onClick={() => transition.mutate({ requestId: item.requestId, action: "start" })}>Start work</button>}
                        {canManageSelectedFacility && item.status === "in_progress" && <button className="text-button" type="button" disabled={transition.isPending} onClick={() => transition.mutate({ requestId: item.requestId, action: "complete" })}>Mark complete</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {requestsQuery.data?.truncated && <p className="muted">Showing the latest 100 requests.</p>}
            </div>
          )}
        </section>
      )}
    </section>
  );
}

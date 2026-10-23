import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Patient = {
  patientId: number;
  recordNumber: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
};

type Department = { department_id: number; name: string };
type Appointment = {
  appointmentId: string;
  patientId: number;
  recordNumber: string;
  departmentId: number;
  department: string;
  requestedAt: string;
  reason: string;
  status: "requested" | "confirmed" | "declined" | "cancelled";
  requestedBy: string;
  createdAt: string;
  respondedBy: string | null;
  respondedAt: string | null;
  canCancel: boolean;
  events: {
    type: string;
    previousStatus: string | null;
    status: string;
    note: string | null;
    actor: string;
    occurredAt: string;
  }[];
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
        : "The appointment request could not be completed.",
    );
  }
  return body as T;
}

function currentEatDateTime(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function formatEatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-KE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Nairobi",
  }).format(new Date(value));
}

export default function AppointmentRequestsPanel({
  facilityId,
  canRequest,
  canRead,
  canRespond,
}: {
  facilityId?: number;
  canRequest: boolean;
  canRead: boolean;
  canRespond: boolean;
}) {
  const queryClient = useQueryClient();
  const [recordNumber, setRecordNumber] = useState("");
  const [patient, setPatient] = useState<Patient>();
  const [departmentId, setDepartmentId] = useState("");
  const [requestedAt, setRequestedAt] = useState("");
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [feedback, setFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const departmentsQuery = useQuery({
    queryKey: ["appointment-departments", facilityId],
    queryFn: () => request<{ departments: Department[] }>(
      `/api/v1/appointments/facilities/${facilityId}/departments`,
    ),
    enabled: Boolean(facilityId && canRequest),
    retry: false,
  });
  const appointmentsQuery = useQuery({
    queryKey: ["appointment-requests", facilityId],
    queryFn: () => request<{ appointments: Appointment[]; truncated: boolean }>(
      `/api/v1/appointments/facilities/${facilityId}/requests`,
    ),
    enabled: Boolean(facilityId && canRead),
    retry: false,
    refetchInterval: 30_000,
  });
  const patientSearch = useMutation({
    mutationFn: (value: string) => request<{ patients: Patient[] }>("/api/v1/patients/search", {
      method: "POST",
      body: JSON.stringify({ facilityId, recordNumber: value }),
    }),
    onError: (error) => setErrorMessage(error.message),
  });
  const createRequest = useMutation({
    mutationFn: () => request<{ appointment: Appointment }>("/api/v1/appointments/facilities/" + facilityId + "/requests", {
      method: "POST",
      headers: { "Idempotency-Key": requestKey },
      body: JSON.stringify({
        patientId: patient?.patientId,
        departmentId: Number(departmentId),
        requestedAt,
        reason,
      }),
    }),
    onSuccess: async (result) => {
      setFeedback(`Appointment request saved for ${result.appointment.recordNumber}. It is pending department confirmation.`);
      setErrorMessage("");
      setPatient(undefined);
      setRecordNumber("");
      setDepartmentId("");
      setReason("");
      setRequestKey("");
      setRequestedAt("");
      await queryClient.invalidateQueries({ queryKey: ["appointment-requests", facilityId] });
    },
    onError: (error) => {
      setErrorMessage(error.message);
      setFeedback("");
    },
  });
  const respond = useMutation({
    mutationFn: ({ appointmentId, action, note }: { appointmentId: string; action: "confirm" | "decline"; note?: string }) =>
      request<{ appointment: Appointment }>(`/api/v1/appointments/requests/${encodeURIComponent(appointmentId)}/respond`, {
        method: "POST",
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      }),
    onSuccess: async (result) => {
      setFeedback(`Appointment ${result.appointment.status}.`);
      setErrorMessage("");
      await queryClient.invalidateQueries({ queryKey: ["appointment-requests", facilityId] });
    },
    onError: (error) => {
      setErrorMessage(error.message);
      setFeedback("");
    },
  });
  const cancel = useMutation({
    mutationFn: (appointmentId: string) =>
      request<{ appointment: Appointment }>(`/api/v1/appointments/requests/${encodeURIComponent(appointmentId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: async () => {
      setFeedback("Appointment request cancelled.");
      setErrorMessage("");
      await queryClient.invalidateQueries({ queryKey: ["appointment-requests", facilityId] });
    },
    onError: (error) => {
      setErrorMessage(error.message);
      setFeedback("");
    },
  });

  if (!facilityId) return null;
  const departments = departmentsQuery.data?.departments ?? [];
  const busy = createRequest.isPending || respond.isPending || cancel.isPending;
  const formatEAT = (value: string) => formatEatDateTime(value);

  return (
    <section className="workflow-card appointment-panel" aria-labelledby="appointment-requests-title">
      <div className="section-title">
        <div>
          <h2 id="appointment-requests-title">Appointment requests</h2>
          <p>Times are entered in East Africa Time (UTC+3). Requests do not reserve a slot; a department must check its schedule before confirming.</p>
        </div>
        {canRead && <button className="text-button" type="button" onClick={() => void appointmentsQuery.refetch()}>Refresh</button>}
      </div>
      {departmentsQuery.isError && <p className="form-error" role="alert">{departmentsQuery.error.message}</p>}
      {appointmentsQuery.isError && <p className="form-error" role="alert">{appointmentsQuery.error.message}</p>}
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {feedback && <p className="inline-message" role="status">{feedback}</p>}

      {canRequest && (
        <div className="triage-form">
          <h3>Request an appointment</h3>
          {!patient ? (
            <>
              <form className="inline-form appointment-patient-search" onSubmit={(event) => {
                event.preventDefault();
                setErrorMessage("");
                patientSearch.mutate(recordNumber.trim());
              }}>
                <label htmlFor="appointment-record-number">Patient record number</label>
                <input id="appointment-record-number" value={recordNumber} onChange={(event) => setRecordNumber(event.target.value)} maxLength={40} required placeholder="Facility record number" />
                <button className="secondary-button" type="submit" disabled={patientSearch.isPending || !recordNumber.trim()}>
                  {patientSearch.isPending ? "Searching…" : "Find patient"}
                </button>
              </form>
              {patientSearch.data?.patients.map((match) => (
                <button
                  className="patient-match appointment-patient-match"
                  type="button"
                  key={match.patientId}
                  onClick={() => {
                    setPatient(match);
                    setRequestKey(window.crypto.randomUUID());
                  }}
                >
                  <span><strong>{match.givenName} {match.familyName}</strong><small>{match.recordNumber} · DOB {match.dateOfBirth}</small></span>
                  <span>Select</span>
                </button>
              ))}
              {patientSearch.data?.patients.length === 0 && <p className="field-hint">No active patient record matched that number.</p>}
            </>
          ) : (
            <form className="appointment-form" onSubmit={(event) => {
              event.preventDefault();
              setErrorMessage("");
              createRequest.mutate();
            }}>
              <p className="field-hint">Patient: <strong>{patient.givenName} {patient.familyName}</strong> · {patient.recordNumber}</p>
              <label>
                Department
              <select value={departmentId} onChange={(event) => {
                setDepartmentId(event.target.value);
                setRequestKey(window.crypto.randomUUID());
              }} required>
                  <option value="">Choose an assigned department</option>
                  {departments.map((department) => (
                    <option key={department.department_id} value={department.department_id}>{department.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Requested date and time (EAT, UTC+3)
                <input
                  type="datetime-local"
                  min={currentEatDateTime()}
                  value={requestedAt}
                  onChange={(event) => {
                    setRequestedAt(event.target.value);
                    setRequestKey(window.crypto.randomUUID());
                  }}
                  required
                />
              </label>
              <label>
                Reason for appointment
                <textarea value={reason} onChange={(event) => {
                  setReason(event.target.value);
                  setRequestKey(window.crypto.randomUUID());
                }} minLength={10} maxLength={500} required />
              </label>
              <div className="triage-actions">
                <button className="primary-button" type="submit" disabled={
                  busy || !requestKey || !departmentId || !requestedAt || reason.trim().length < 10
                }>
                  {createRequest.isPending ? "Saving…" : "Submit appointment request"}
                </button>
                <button className="text-button" type="button" onClick={() => {
                  setPatient(undefined);
                  setRequestKey("");
                }}>Choose another patient</button>
              </div>
            </form>
          )}
        </div>
      )}

      {canRead && (
        <div className="triage-arrivals appointment-list">
          {appointmentsQuery.isPending && <p className="muted">Loading appointment requests…</p>}
          {appointmentsQuery.data?.appointments.length === 0 && <p className="muted">No appointment requests for your assigned departments.</p>}
          {appointmentsQuery.data?.appointments.map((appointment) => (
            <article className="triage-arrival" key={appointment.appointmentId}>
              <div>
                <strong>{appointment.department} · {appointment.recordNumber}</strong>
                <p>{formatEAT(appointment.requestedAt)} EAT · {appointment.status}</p>
                <p>{appointment.reason}</p>
                <p className="field-hint">Requested by {appointment.requestedBy}</p>
              </div>
              <div className="triage-actions">
                {canRespond && appointment.status === "requested" && (
                  <>
                    <button className="text-button" type="button" disabled={busy} onClick={() => {
                      if (window.confirm("Confirm only after checking the department schedule. This request does not reserve a slot.")) {
                        respond.mutate({ appointmentId: appointment.appointmentId, action: "confirm" });
                      }
                    }}>Confirm</button>
                    <button className="text-button" type="button" disabled={busy} onClick={() => {
                      const note = window.prompt("Provide a reason for declining this request (at least 10 characters).");
                      if (note?.trim() && note.trim().length >= 10) {
                        respond.mutate({ appointmentId: appointment.appointmentId, action: "decline", note: note.trim() });
                      }
                    }}>Decline</button>
                  </>
                )}
                {appointment.canCancel && appointment.status === "requested" && (
                  <button className="text-button" type="button" disabled={busy} onClick={() => cancel.mutate(appointment.appointmentId)}>Cancel</button>
                )}
                {appointment.respondedBy && <span className="field-hint">Handled by {appointment.respondedBy}</span>}
              </div>
              {appointment.events.map((event, index) => (
                <p className="field-hint appointment-event" key={`${event.occurredAt}-${index}`}>
                  {event.type}: {event.previousStatus ? `${event.previousStatus} → ` : ""}{event.status} · {event.actor} · {formatEAT(event.occurredAt)}
                  {event.note ? ` · ${event.note}` : ""}
                </p>
              ))}
            </article>
          ))}
          {appointmentsQuery.data?.truncated && <p className="field-hint">Showing the latest 100 department requests.</p>}
        </div>
      )}
    </section>
  );
}

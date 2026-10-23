import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import ClinicalNotesPanel from "../clinical/ClinicalNotesPanel";
import CareContextPanel from "../shared/CareContextPanel";
import EncounterWorkflowPanel from "../shared/EncounterWorkflowPanel";
import AppointmentRequestsPanel from "./AppointmentRequestsPanel";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";
const recordNumberSchema = z.string().trim().min(1, "Enter a facility record number.").max(40);
type Facility = { facility_id: number; facility_code: string; name: string };
type Patient = {
  patientId: number;
  recordNumber: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
};
type Encounter = {
  encounterId: string;
  patientId: number;
  recordNumber: string;
  encounterType: "outpatient" | "emergency";
  status: "open" | "closed" | "cancelled";
  openedAt: string;
};
type Observation = {
  observationId: string;
  encounterId: string;
  recordNumber: string;
  recordedBy: string;
  systolicBpMmhg: number | null;
  diastolicBpMmhg: number | null;
  pulseBpm: number | null;
  respiratoryRateBpm: number | null;
  temperatureCelsius: number | null;
  oxygenSaturationPercent: number | null;
  weightKg: number | null;
  heightCm: number | null;
  recordedAt: string;
};
type ApiError = Error & { code?: string };
const observationFields = [
  ["systolicBpMmhg", "Systolic blood pressure", "mmHg", "0", "1000", "1"],
  ["diastolicBpMmhg", "Diastolic blood pressure", "mmHg", "0", "1000", "1"],
  ["pulseBpm", "Pulse", "beats/min", "0", "1000", "1"],
  ["respiratoryRateBpm", "Respiratory rate", "breaths/min", "0", "1000", "1"],
  ["temperatureCelsius", "Temperature", "°C", "-100", "200", "0.1"],
  ["oxygenSaturationPercent", "Oxygen saturation", "%", "0", "100", "1"],
  ["weightKg", "Weight", "kg", "0", "99999.99", "0.01"],
  ["heightCm", "Height", "cm", "0", "9999.99", "0.01"],
] as const;
type ObservationField = typeof observationFields[number][0];
type ObservationValues = Record<ObservationField, string>;
const emptyObservationValues: ObservationValues = {
  systolicBpMmhg: "",
  diastolicBpMmhg: "",
  pulseBpm: "",
  respiratoryRateBpm: "",
  temperatureCelsius: "",
  oxygenSaturationPercent: "",
  weightKg: "",
  heightCm: "",
};

async function apiRequest<T>(path: string, options?: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string }): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: options?.method ?? "GET",
    credentials: "include",
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = typeof result === "object" && result !== null && "error" in result &&
      typeof result.error === "object" && result.error !== null ? result.error : null;
    const error = new Error(
      errorBody && "message" in errorBody && typeof errorBody.message === "string"
        ? errorBody.message
        : "The request could not be completed.",
    ) as ApiError;
    if (errorBody && "code" in errorBody && typeof errorBody.code === "string") error.code = errorBody.code;
    throw error;
  }
  return result as T;
}

export default function OutpatientWorkspace({
  canSearchPatients,
  canRegisterEncounters,
  canReadQueue,
  canReadObservations,
  canRecordObservations,
  canReadNotes,
  canCreateNotes,
  canSignNotes,
  canAmendNotes,
  canReadCareContext,
  canCreateWorkflowTasks,
  canRespondToWorkflowTasks,
  canRequestAppointments,
  canReadAppointments,
  canConfirmAppointments,
  userId,
  isSystemAdmin,
}: {
  canSearchPatients: boolean;
  canRegisterEncounters: boolean;
  canReadQueue: boolean;
  canReadObservations: boolean;
  canRecordObservations: boolean;
  canReadNotes: boolean;
  canCreateNotes: boolean;
  canSignNotes: boolean;
  canAmendNotes: boolean;
  canReadCareContext: boolean;
  canCreateWorkflowTasks: boolean;
  canRespondToWorkflowTasks: boolean;
  canRequestAppointments: boolean;
  canReadAppointments: boolean;
  canConfirmAppointments: boolean;
  userId: number;
  isSystemAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [facilityId, setFacilityId] = useState<number>();
  const [recordNumber, setRecordNumber] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<Patient>();
  const [encounterType, setEncounterType] = useState<"outpatient" | "emergency">("outpatient");
  const [requestKey, setRequestKey] = useState("");
  const [message, setMessage] = useState("");
  const [registrationSuccess, setRegistrationSuccess] = useState<{
    encounterType: Encounter["encounterType"];
    recordNumber: string;
    idempotentReplay: boolean;
  }>();
  const registrationDialogRef = useRef<HTMLDialogElement>(null);
  const [selectedObservationEncounter, setSelectedObservationEncounter] = useState<Encounter>();
  const [observationValues, setObservationValues] = useState<ObservationValues>(emptyObservationValues);
  const [observationKey, setObservationKey] = useState("");
  const [observationMessage, setObservationMessage] = useState("");
  const facilitiesQuery = useQuery({
    queryKey: ["assigned-facilities"],
    queryFn: () => apiRequest<{ facilities: Facility[] }>(
      isSystemAdmin ? "/api/v1/admin/facilities" : "/api/v1/facilities",
    ),
    retry: false,
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const selectedFacilityId = facilityId ?? facilities[0]?.facility_id;

  const patientSearch = useMutation({
    mutationFn: (value: string) => apiRequest<{ patients: Patient[] }>(
      "/api/v1/patients/search",
      {
        method: "POST",
        body: { facilityId: selectedFacilityId, recordNumber: value },
      },
    ),
    onSuccess: () => {
      setSelectedPatient(undefined);
      setRequestKey("");
      setMessage("");
    },
  });
  const queueQuery = useQuery({
    queryKey: ["encounter-queue", selectedFacilityId],
    queryFn: () => apiRequest<{ encounters: Encounter[]; truncated: boolean }>(
      `/api/v1/encounters?facilityId=${encodeURIComponent(String(selectedFacilityId))}`,
    ),
    enabled: Boolean(selectedFacilityId && canReadQueue),
    retry: false,
    refetchInterval: 30_000,
  });
  const registration = useMutation({
    mutationFn: ({ patient, kind, key }: { patient: Patient; kind: "outpatient" | "emergency"; key: string }) =>
      apiRequest<{ encounter: Encounter; idempotentReplay: boolean }>("/api/v1/encounters", {
        method: "POST",
        idempotencyKey: key,
        body: { facilityId: selectedFacilityId, patientId: patient.patientId, encounterType: kind },
      }),
    onSuccess: (result) => {
        setMessage("");
      setRegistrationSuccess({
        encounterType: result.encounter.encounterType,
        recordNumber: result.encounter.recordNumber,
          idempotentReplay: result.idempotentReplay,
        });
      setSelectedPatient(undefined);
      setRequestKey("");
      void queryClient.invalidateQueries({ queryKey: ["encounter-queue", selectedFacilityId] });
    },
  });
  useEffect(() => {
    if (registrationSuccess && registrationDialogRef.current && !registrationDialogRef.current.open) {
      registrationDialogRef.current.showModal();
    }
  }, [registrationSuccess]);
  const observationsQuery = useQuery({
    queryKey: ["encounter-observations", selectedObservationEncounter?.encounterId],
    queryFn: () => apiRequest<{ observations: Observation[]; truncated: boolean }>(
      `/api/v1/encounters/${encodeURIComponent(selectedObservationEncounter!.encounterId)}/observations`,
    ),
    enabled: Boolean(selectedObservationEncounter && canReadObservations),
    retry: false,
  });
  const recordObservation = useMutation({
    mutationFn: ({ encounter, values, key }: {
      encounter: Encounter;
      values: Partial<Record<ObservationField, number>>;
      key: string;
    }) => apiRequest<{ observation: Observation; idempotentReplay: boolean }>(
      `/api/v1/encounters/${encodeURIComponent(encounter.encounterId)}/observations`,
      { method: "POST", idempotencyKey: key, body: values },
    ),
    onSuccess: (result) => {
      setObservationMessage(
        `${result.idempotentReplay ? "Previously saved" : "Recorded"} observations for ${result.observation.recordNumber}.`,
      );
      setObservationValues(emptyObservationValues);
      setObservationKey(window.crypto.randomUUID());
      void queryClient.invalidateQueries({
        queryKey: ["encounter-observations", selectedObservationEncounter?.encounterId],
      });
    },
  });

  if (facilitiesQuery.isPending) return <p className="muted">Loading assigned facilities…</p>;
  if (facilitiesQuery.isError) return <p className="form-error" role="alert">Assigned facilities could not be loaded.</p>;
  if (facilities.length === 0) return <p className="notice-card">No active facility is assigned to this account. Ask an administrator to review its facility access.</p>;

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = recordNumberSchema.safeParse(recordNumber);
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Enter a valid record number.");
      return;
    }
    if (!selectedFacilityId) return;
    setMessage("");
    patientSearch.mutate(parsed.data);
  };

  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">OUTPATIENT CARE</p>
          <h1>Encounter registration</h1>
          <p className="muted">Register an OPD or emergency arrival and manage the facility queue.</p>
        </div>
        <div className="access-tag">Facility-scoped · audited</div>
      </div>

      <div className="notice-card">
        <span className="notice-icon" aria-hidden="true">i</span>
        <div>
          <strong>Arrival registration and measurement recording only</strong>
          <p>No triage acuity, interpretation, alerts, or treatment advice is generated. Use the facility-approved clinical protocol and emergency escalation process.</p>
        </div>
      </div>

      <nav className="encounter-tabs" aria-label="Encounter workspace sections">
        {canSearchPatients && canRegisterEncounters && <a href="#encounter-registration">Register arrival</a>}
        {canReadQueue && <a href="#encounter-queue">Open queue</a>}
      </nav>

      {canSearchPatients && canRegisterEncounters && (
        <section className="workflow-card" id="encounter-registration" aria-labelledby="encounter-registration-title">
          <p className="form-step-label">PATIENT AND VISIT</p>
          <h2 id="encounter-registration-title">Register an arrival</h2>
          <label className="field-label" htmlFor="encounter-facility">Facility</label>
          <select
            id="encounter-facility"
            className="workflow-select"
            value={selectedFacilityId ?? ""}
            onChange={(event) => {
              const nextFacilityId = Number(event.target.value);
              setFacilityId(nextFacilityId);
              setSelectedPatient(undefined);
              setRequestKey("");
              setMessage("");
            }}
          >
            {facilities.map((facility) => <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>)}
          </select>

          <form className="workflow-form" onSubmit={submitSearch}>
            <label className="field-label" htmlFor="encounter-record-number">Facility record number</label>
            <div className="inline-form">
              <input
                id="encounter-record-number"
                value={recordNumber}
                onChange={(event) => setRecordNumber(event.target.value)}
                maxLength={40}
                autoComplete="off"
                aria-describedby="encounter-search-help"
              />
              <button className="secondary-button" type="submit" disabled={patientSearch.isPending}>
                {patientSearch.isPending ? "Searching…" : "Find patient"}
              </button>
            </div>
            <p className="field-hint" id="encounter-search-help">Search is limited to the selected facility and records staff permissions.</p>
          </form>

          {patientSearch.isError && <p className="form-error" role="alert">{patientSearch.error.message}</p>}
          {patientSearch.data && patientSearch.data.patients.length === 0 && <p className="inline-message" role="status">No active record matched that facility number.</p>}
          {patientSearch.data && patientSearch.data.patients.length > 0 && (
            <div className="patient-match-list" aria-label="Patient search results">
              {patientSearch.data.patients.map((patient) => (
                <button
                  className={`patient-match ${selectedPatient?.patientId === patient.patientId ? "patient-match-selected" : ""}`}
                  type="button"
                  key={patient.patientId}
                  onClick={() => {
                    setSelectedPatient(patient);
                    setRequestKey(window.crypto.randomUUID());
                    setMessage("");
                  }}
                >
                  <span><strong>{patient.givenName} {patient.familyName}</strong><small>{patient.recordNumber} · DOB {patient.dateOfBirth}</small></span>
                  <span>{selectedPatient?.patientId === patient.patientId ? "Selected" : "Select"}</span>
                </button>
              ))}
            </div>
          )}

          {selectedPatient && (
            <div className="encounter-confirmation">
              <div className="patient-context-card">
                <span className="patient-context-icon" aria-hidden="true">{selectedPatient.givenName.slice(0, 1)}{selectedPatient.familyName.slice(0, 1)}</span>
                <div>
                  <p className="form-step-label">SELECTED PATIENT</p>
                  <strong>{selectedPatient.givenName} {selectedPatient.familyName}</strong>
                  <small>Record {selectedPatient.recordNumber} · Date of birth {selectedPatient.dateOfBirth}</small>
                </div>
              </div>
              <div className="encounter-form-section">
                <p className="form-step-label">VISIT DETAILS</p>
              <label className="field-label" htmlFor="encounter-type">Encounter type</label>
              <select
                id="encounter-type"
                className="workflow-select"
                value={encounterType}
                onChange={(event) => {
                  const nextType = event.target.value;
                  if (nextType === "outpatient" || nextType === "emergency") {
                    setEncounterType(nextType);
                    setRequestKey(window.crypto.randomUUID());
                  }
                }}
              >
                <option value="outpatient">Outpatient (OPD)</option>
                <option value="emergency">Emergency arrival</option>
              </select>
              </div>
              <button
                className="primary-button"
                type="button"
                disabled={registration.isPending || !requestKey}
                onClick={() => registration.mutate({ patient: selectedPatient, kind: encounterType, key: requestKey })}
              >
                {registration.isPending ? "Registering…" : "Register encounter"} <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
          {registration.isError && <p className="form-error" role="alert">{registration.error.message}</p>}
          {message && !registrationSuccess && <p className="inline-message" role="status">{message}</p>}
        </section>
      )}

      {canReadQueue && (
        <section className="workflow-card queue-card" id="encounter-queue" aria-labelledby="encounter-queue-title">
          <div className="section-title">
            <div><h2 id="encounter-queue-title">Open encounter queue</h2><p>Latest 100 open registrations · refreshes every 30 seconds</p></div>
            <button className="text-button" type="button" onClick={() => void queueQuery.refetch()}>Refresh</button>
          </div>
          {queueQuery.isPending && <p className="muted">Loading encounter queue…</p>}
          {queueQuery.isError && <p className="form-error" role="alert">{queueQuery.error.message}</p>}
          {queueQuery.data && queueQuery.data.encounters.length === 0 && <p className="muted">There are no open encounters in this facility queue.</p>}
          {queueQuery.data && queueQuery.data.encounters.length > 0 && (
            <div className="table-scroll">
              <table className="encounter-table">
                <thead><tr><th>Record number</th><th>Encounter</th><th>Status</th><th>Registered (EAT)</th>{(canReadObservations || canRecordObservations || canReadNotes || canCreateNotes || canSignNotes || canAmendNotes) && <th>Clinical record</th>}</tr></thead>
                <tbody>{queueQuery.data.encounters.map((encounter) => (
                  <tr key={encounter.encounterId}>
                    <td>{encounter.recordNumber}</td>
                    <td>{encounter.encounterType === "outpatient" ? "OPD" : "Emergency"}</td>
                    <td><span className="queue-status">{encounter.status}</span></td>
                    <td>{new Intl.DateTimeFormat("en-KE", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "Africa/Nairobi",
                    }).format(new Date(encounter.openedAt))}</td>
                    {(canReadObservations || canRecordObservations || canReadNotes || canCreateNotes || canSignNotes || canAmendNotes) && (
                      <td>
                        <button
                          className="table-action"
                          type="button"
                          onClick={() => {
                            setSelectedObservationEncounter(encounter);
                            setObservationValues(emptyObservationValues);
                            setObservationKey(window.crypto.randomUUID());
                            setObservationMessage("");
                          }}
                        >
                          {selectedObservationEncounter?.encounterId === encounter.encounterId ? "Selected" : "Open"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {queueQuery.data?.truncated && <p className="field-hint">Showing the latest 100 open encounters. Additional queue pagination is not yet implemented.</p>}
        </section>
      )}
      {selectedObservationEncounter && (
        <>
        <nav className="encounter-tabs clinical-record-tabs" aria-label="Selected encounter sections">
          {canReadCareContext && <a href="#encounter-context">Encounter summary</a>}
          {(canCreateWorkflowTasks || canRespondToWorkflowTasks) && <a href="#encounter-referrals">Requests and referrals</a>}
          {(canReadObservations || canRecordObservations) && <a href="#encounter-measurements">Measurements</a>}
          {(canReadNotes || canCreateNotes || canSignNotes || canAmendNotes) && <a href="#encounter-notes">Clinical notes</a>}
        </nav>
        {canReadCareContext && <div id="encounter-context"><CareContextPanel encounterId={selectedObservationEncounter.encounterId} /></div>}
        {(canCreateWorkflowTasks || canRespondToWorkflowTasks) && selectedFacilityId && (
          <div id="encounter-referrals">
            <EncounterWorkflowPanel
              encounterId={selectedObservationEncounter.encounterId}
              facilityId={selectedFacilityId}
              canCreate={canCreateWorkflowTasks}
              canRespond={canRespondToWorkflowTasks}
            />
          </div>
        )}
        {(canReadObservations || canRecordObservations) && (
        <section className="workflow-card" id="encounter-measurements" aria-labelledby="observations-title">
          <div className="section-title">
            <div>
              <h2 id="observations-title">Encounter measurements</h2>
              <p>{selectedObservationEncounter.recordNumber} · {selectedObservationEncounter.encounterType === "outpatient" ? "OPD" : "Emergency"} · values are stored as entered</p>
            </div>
            <button className="text-button" type="button" onClick={() => {
              const encounterId = selectedObservationEncounter.encounterId;
              setSelectedObservationEncounter(undefined);
              queryClient.removeQueries({ queryKey: ["encounter-observations", encounterId] });
              queryClient.removeQueries({ queryKey: ["encounter-notes", encounterId] });
              setObservationMessage("");
            }}>Close</button>
          </div>
          <p className="field-hint">Units are shown beside each field. Enter measurements from the approved device or workflow; this screen does not determine clinical normality or urgency.</p>

          {canRecordObservations && (
            <form className="observation-form" onSubmit={(event) => {
              event.preventDefault();
              if (!selectedObservationEncounter) return;
              const values: Partial<Record<ObservationField, number>> = {};
              for (const [field] of observationFields) {
                const raw = observationValues[field].trim();
                if (!raw) continue;
                const value = Number(raw);
                if (!Number.isFinite(value)) {
                  setObservationMessage("Enter a valid numeric value or leave the field empty.");
                  return;
                }
                values[field] = value;
              }
              if (Object.keys(values).length === 0) {
                setObservationMessage("Enter at least one measurement.");
                return;
              }
              if ((values.systolicBpMmhg === undefined) !== (values.diastolicBpMmhg === undefined)) {
                setObservationMessage("Record both systolic and diastolic blood pressure values.");
                return;
              }
              setObservationMessage("");
              recordObservation.mutate({
                encounter: selectedObservationEncounter,
                values,
                key: observationKey,
              });
            }}>
              <div className="observation-fields">
                {observationFields.map(([field, label, unit, min, max, step]) => (
                  <div key={field}>
                    <label className="field-label" htmlFor={`observation-${field}`}>{label} ({unit})</label>
                    <input
                      id={`observation-${field}`}
                      type="number"
                      inputMode="decimal"
                      min={min}
                      max={max}
                      step={step}
                      value={observationValues[field]}
                      disabled={recordObservation.isPending}
                      onChange={(event) => {
                        setObservationValues((previous) => ({
                          ...previous,
                          [field]: event.target.value,
                        }));
                        setObservationKey(window.crypto.randomUUID());
                      }}
                    />
                  </div>
                ))}
              </div>
              {recordObservation.isError && <p className="form-error" role="alert">{recordObservation.error.message}</p>}
              {observationMessage && <p className={recordObservation.isError ? "form-error" : "inline-message"} role={recordObservation.isError ? "alert" : "status"}>{observationMessage}</p>}
              <button className="primary-button observation-submit" type="submit" disabled={recordObservation.isPending || !observationKey}>
                {recordObservation.isPending ? "Saving measurements…" : "Record measurements"} <span aria-hidden="true">→</span>
              </button>
            </form>
          )}

          {canReadObservations && (
            <div className="observation-history">
              <h3>Recorded measurements</h3>
              {observationsQuery.isPending && <p className="muted">Loading encounter measurements…</p>}
              {observationsQuery.isError && <p className="form-error" role="alert">{observationsQuery.error.message}</p>}
              {observationsQuery.data && observationsQuery.data.observations.length === 0 && <p className="muted">No measurements have been recorded for this encounter.</p>}
              {observationsQuery.data?.observations.map((observation) => (
                <article className="observation-entry" key={observation.observationId}>
                  <p className="field-hint">
                    Recorded by {observation.recordedBy} at {new Intl.DateTimeFormat("en-KE", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: "Africa/Nairobi",
                    }).format(new Date(observation.recordedAt))} (EAT)
                  </p>
                  <dl className="observation-values">
                    {observation.systolicBpMmhg !== null && <div><dt>Blood pressure</dt><dd>{observation.systolicBpMmhg}/{observation.diastolicBpMmhg} mmHg</dd></div>}
                    {observation.pulseBpm !== null && <div><dt>Pulse</dt><dd>{observation.pulseBpm} beats/min</dd></div>}
                    {observation.respiratoryRateBpm !== null && <div><dt>Respiratory rate</dt><dd>{observation.respiratoryRateBpm} breaths/min</dd></div>}
                    {observation.temperatureCelsius !== null && <div><dt>Temperature</dt><dd>{observation.temperatureCelsius} °C</dd></div>}
                    {observation.oxygenSaturationPercent !== null && <div><dt>Oxygen saturation</dt><dd>{observation.oxygenSaturationPercent}%</dd></div>}
                    {observation.weightKg !== null && <div><dt>Weight</dt><dd>{observation.weightKg} kg</dd></div>}
                    {observation.heightCm !== null && <div><dt>Height</dt><dd>{observation.heightCm} cm</dd></div>}
                  </dl>
                </article>
              ))}
              {observationsQuery.data?.truncated && <p className="field-hint">Showing the latest 100 measurement sets. Additional pagination is not yet implemented.</p>}
            </div>
          )}
        </section>
        )}
        {(canReadNotes || canCreateNotes || canSignNotes || canAmendNotes) && (
          <div id="encounter-notes">
            <ClinicalNotesPanel
              encounter={selectedObservationEncounter}
              userId={userId}
              canRead={canReadNotes}
              canCreate={canCreateNotes}
              canSign={canSignNotes}
              canAmend={canAmendNotes}
              onClose={() => {
                const encounterId = selectedObservationEncounter.encounterId;
                setSelectedObservationEncounter(undefined);
                queryClient.removeQueries({ queryKey: ["encounter-observations", encounterId] });
                queryClient.removeQueries({ queryKey: ["encounter-notes", encounterId] });
              }}
            />
          </div>
        )}
        </>
      )}
      <dialog
        ref={registrationDialogRef}
        className="success-dialog"
        aria-labelledby="encounter-success-title"
        aria-describedby="encounter-success-message"
        onClose={() => setRegistrationSuccess(undefined)}
      >
        {registrationSuccess && (
          <>
            <div className="success-dialog-heading">
              <span className="success-dialog-icon" aria-hidden="true">✓</span>
              <div>
                <p className="form-step-label">ARRIVAL REGISTRATION</p>
                <h2 id="encounter-success-title">Success</h2>
              </div>
            </div>
            <p id="encounter-success-message">
              {registrationSuccess.idempotentReplay ? "Existing" : "New"} {registrationSuccess.encounterType === "outpatient" ? "outpatient" : "emergency"} encounter registered for record <strong>{registrationSuccess.recordNumber}</strong>.
            </p>
            <div className="success-dialog-actions">
              {canReadQueue && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    registrationDialogRef.current?.close();
                    document.getElementById("encounter-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  Open encounter queue
                </button>
              )}
              <button className="primary-button" type="button" autoFocus onClick={() => registrationDialogRef.current?.close()}>
                {canReadQueue ? "Continue" : "Register another"}
              </button>
            </div>
          </>
        )}
      </dialog>
      {!canReadQueue && !canRegisterEncounters && !canReadObservations && !canRecordObservations && !canReadNotes && !canCreateNotes && !canSignNotes && !canAmendNotes && <p className="notice-card">Your account does not have access to outpatient registration or encounter permissions.</p>}
      {(canRequestAppointments || canReadAppointments || canConfirmAppointments) && (
        <AppointmentRequestsPanel
          facilityId={selectedFacilityId}
          canRequest={canRequestAppointments}
          canRead={canReadAppointments}
          canRespond={canConfirmAppointments}
        />
      )}
    </section>
  );
}

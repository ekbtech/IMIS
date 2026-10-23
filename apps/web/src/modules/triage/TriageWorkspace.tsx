import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import CareContextPanel from "../shared/CareContextPanel";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Facility = { facility_id: number; name: string };
type Arrival = {
  encounterId: string;
  recordNumber: string;
  encounterType: "outpatient" | "emergency";
  openedAt: string;
};
type TriageAssessment = {
  triageId: string;
  encounterId: string;
  recordNumber: string;
  capturedAt: string;
  capturedBy: string;
  observations: Record<string, number | null>;
};
type QueueResponse = {
  arrivals: Arrival[];
  assessments: TriageAssessment[];
  truncated: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null && "message" in body.error &&
      typeof body.error.message === "string"
      ? body.error.message
      : "The request could not be completed.";
    throw new Error(message);
  }
  return body as T;
}

const measurementFields = [
  ["systolicBpMmhg", "Systolic BP (mmHg)"],
  ["diastolicBpMmhg", "Diastolic BP (mmHg)"],
  ["pulseBpm", "Pulse (bpm)"],
  ["respiratoryRateBpm", "Respiratory rate (/min)"],
  ["temperatureCelsius", "Temperature (°C)"],
  ["oxygenSaturationPercent", "Oxygen saturation (%)"],
  ["weightKg", "Weight (kg)"],
  ["heightCm", "Height (cm)"],
] as const;

type MeasurementName = typeof measurementFields[number][0];
type MeasurementInput = Record<MeasurementName, string>;

const emptyMeasurements: MeasurementInput = {
  systolicBpMmhg: "",
  diastolicBpMmhg: "",
  pulseBpm: "",
  respiratoryRateBpm: "",
  temperatureCelsius: "",
  oxygenSaturationPercent: "",
  weightKg: "",
  heightCm: "",
};

export default function TriageWorkspace({
  canCapture,
  canReview,
  canReadCareContext,
}: {
  canCapture: boolean;
  canReview: boolean;
  canReadCareContext: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedFacility, setSelectedFacility] = useState("");
  const [selectedEncounter, setSelectedEncounter] = useState<Arrival | null>(null);
  const [contextEncounterId, setContextEncounterId] = useState<string>();
  const [measurements, setMeasurements] = useState(emptyMeasurements);
  const [errorMessage, setErrorMessage] = useState("");
  const facilitiesQuery = useQuery({
    queryKey: ["facilities"],
    queryFn: () => request<{ facilities: Facility[] }>("/api/v1/facilities"),
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const facilityId = Number(selectedFacility || facilities[0]?.facility_id || 0);
  const queueQuery = useQuery({
    queryKey: ["triage-queue", facilityId],
    queryFn: () => request<QueueResponse>(`/api/v1/triage/queue?facilityId=${facilityId}`),
    enabled: facilityId > 0,
    refetchInterval: 30_000,
  });

  const refreshQueue = async () => {
    await queryClient.invalidateQueries({ queryKey: ["triage-queue", facilityId] });
  };

  const capture = useMutation({
    mutationFn: async () => {
      if (!selectedEncounter) throw new Error("Select an open encounter first.");
      const observations = Object.fromEntries(measurementFields.flatMap(([field]) => {
        const value = measurements[field].trim();
        return value === "" ? [] : [[field, Number(value)]];
      }));
      return request<{ triageId: string }>("/api/v1/triage/encounters/" + selectedEncounter.encounterId + "/assessments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(observations),
      });
    },
    onSuccess: async () => {
      setErrorMessage("");
      setSelectedEncounter(null);
      setMeasurements(emptyMeasurements);
      await refreshQueue();
    },
    onError: (error) => setErrorMessage(error.message),
  });

  const review = useMutation({
    mutationFn: (triageId: string) => request(`/api/v1/triage/assessments/${triageId}/review`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
    onSuccess: async () => {
      setErrorMessage("");
      await refreshQueue();
    },
    onError: (error) => setErrorMessage(error.message),
  });

  const queue = queueQuery.data;

  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">TRIAGE DEPARTMENT</p>
          <h1>Triage capture and review</h1>
          <p className="muted">Observations are recorded for clinician review. This workspace does not calculate acuity or recommend care.</p>
        </div>
        {facilities.length > 1 && (
          <select
            aria-label="Facility"
            value={facilityId || ""}
            onChange={(event) => setSelectedFacility(event.target.value)}
          >
            {facilities.map((facility) => (
              <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="notice-card">
        <span className="notice-icon">i</span>
        <div><strong>Demo workflow; approval required</strong><p>Capture measurements and route the encounter for review. No urgency score, diagnosis or treatment advice is produced.</p></div>
      </div>

      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {facilitiesQuery.isError && <p className="form-error" role="alert">Facility list could not be loaded.</p>}
      {queueQuery.isError && <p className="form-error" role="alert">{queueQuery.error.message}</p>}
      {queueQuery.isPending && facilityId > 0 && <p className="muted">Loading triage queues…</p>}

      {canCapture && (
        <div className="module-card triage-section">
          <div className="section-title"><div><h2>Open encounters awaiting triage capture</h2><p>Select an encounter, then record the measurements available to you.</p></div></div>
          {(queue?.arrivals ?? []).length === 0
            ? <p className="muted">No open encounters are available.</p>
            : <div className="triage-arrivals">
              {queue?.arrivals.map((arrival) => (
                <article className="triage-arrival" key={arrival.encounterId}>
                  <div>
                    <strong>{arrival.recordNumber}</strong>
                    <p>{arrival.encounterType} · {new Date(arrival.openedAt).toLocaleString()}</p>
                  </div>
                  <button className="text-button" type="button" onClick={() => setSelectedEncounter(arrival)}>Record observations</button>
                  {canReadCareContext && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setContextEncounterId(arrival.encounterId)}
                    >
                      View shared record
                    </button>
                  )}
                </article>
              ))}
            </div>}
          {contextEncounterId && (
            <CareContextPanel encounterId={contextEncounterId} />
          )}
          {selectedEncounter && (
            <form className="triage-form" onSubmit={(event) => { event.preventDefault(); capture.mutate(); }}>
              <h3>Encounter {selectedEncounter.recordNumber}</h3>
              <div className="triage-fields">
                {measurementFields.map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <input
                      type="number"
                      step="0.01"
                      value={measurements[field]}
                      onChange={(event) => setMeasurements((current) => ({ ...current, [field]: event.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <p className="field-hint">Record measurements as observed. Blood pressure requires both systolic and diastolic values. No interpretation is applied.</p>
              <button className="primary-button" type="submit" disabled={capture.isPending}>
                {capture.isPending ? "Saving…" : "Save and send for clinician review"} <span aria-hidden="true">→</span>
              </button>
            </form>
          )}
        </div>
      )}

      <div className="module-card triage-section">
        <div className="section-title"><div><h2>Awaiting clinician review</h2><p>Review acknowledges the observation record; it does not assign acuity.</p></div></div>
        {(queue?.assessments ?? []).length === 0
          ? <p className="muted">No assessments are awaiting review.</p>
          : <div className="triage-arrivals">
            {queue?.assessments.map((assessment) => (
              <article className="triage-assessment" key={assessment.triageId}>
                <div>
                  <strong>{assessment.recordNumber}</strong>
                  <p>Captured by {assessment.capturedBy} · {new Date(assessment.capturedAt).toLocaleString()}</p>
                  <p>{measurementFields.flatMap(([field, label]) => {
                    const value = assessment.observations[field];
                    return value === null ? [] : [`${label}: ${value}`];
                  }).join(" · ")}</p>
                </div>
                {canReview && (
                  <button className="text-button" type="button" disabled={review.isPending} onClick={() => review.mutate(assessment.triageId)}>
                    Mark reviewed
                  </button>
                )}
              </article>
            ))}
          </div>}
        {queue?.truncated && <p className="field-hint">Showing the first 100 items. Continue review to see older arrivals.</p>}
      </div>
    </section>
  );
}

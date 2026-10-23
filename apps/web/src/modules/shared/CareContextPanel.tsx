import { useQuery } from "@tanstack/react-query";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

type Observation = {
  observationId: string;
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

type CareEncounter = {
  encounterId: string;
  encounterType: "outpatient" | "emergency";
  status: "open" | "closed" | "cancelled";
  openedAt: string;
  observations?: Observation[];
  triageAssessments?: Array<{
    triageId: string;
    status: "awaiting_review" | "reviewed";
    capturedAt: string;
    reviewedAt: string | null;
  }>;
  diagnosticOrders?: Array<{
    orderId: string;
    serviceCode: string;
    serviceName: string;
    status: "ordered" | "cancelled";
    requestedAt: string;
  }>;
  admissions?: Array<{
    admissionId: string;
    status: "active" | "discharged";
    admittedAt: string;
    dischargedAt: string | null;
    wardCode: string | null;
    bedCode: string | null;
  }>;
};

type CareContext = {
  patient: { patientId: number; recordNumber: string };
  encounters: CareEncounter[];
  sections: string[];
  truncated: boolean;
};

const observationLabels: Array<[keyof Observation, string, string]> = [
  ["systolicBpMmhg", "Systolic BP", "mmHg"],
  ["diastolicBpMmhg", "Diastolic BP", "mmHg"],
  ["pulseBpm", "Pulse", "bpm"],
  ["respiratoryRateBpm", "Respiratory rate", "/min"],
  ["temperatureCelsius", "Temperature", "°C"],
  ["oxygenSaturationPercent", "Oxygen saturation", "%"],
  ["weightKg", "Weight", "kg"],
  ["heightCm", "Height", "cm"],
];

async function fetchCareContext(encounterId: string): Promise<CareContext> {
  const response = await fetch(
    `${apiBase}/api/v1/encounters/${encodeURIComponent(encounterId)}/care-context`,
    { credentials: "include", cache: "no-store" },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null && "message" in body.error &&
      typeof body.error.message === "string"
      ? body.error.message
      : "Shared clinical context could not be loaded.";
    throw new Error(message);
  }
  return body as CareContext;
}

export default function CareContextPanel({ encounterId }: { encounterId: string }) {
  const query = useQuery({
    queryKey: ["care-context", encounterId],
    queryFn: () => fetchCareContext(encounterId),
    retry: false,
    staleTime: 15_000,
  });

  if (query.isPending) return <p className="muted">Loading shared patient record…</p>;
  if (query.isError) return <p className="form-error" role="alert">{query.error.message}</p>;
  const context = query.data;

  return (
    <section className="module-card" aria-labelledby="care-context-title">
      <div className="section-title">
        <div>
          <h2 id="care-context-title">Shared patient record · {context.patient.recordNumber}</h2>
          <p>Authorized cross-department history, recorded as entered. No clinical interpretation is generated.</p>
        </div>
      </div>
      {context.sections.length === 0 && <p className="muted">No additional department sections are available to this role.</p>}
      {context.encounters.length === 0 && <p className="muted">No encounter history is available.</p>}
      <div className="care-context-list">
        {context.encounters.map((encounter) => (
          <article className="observation-entry" key={encounter.encounterId}>
            <strong>{encounter.encounterType === "outpatient" ? "OPD" : "Emergency"} · {encounter.status}</strong>
            <p className="field-hint">Opened {new Date(encounter.openedAt).toLocaleString()}</p>
            {encounter.observations?.map((observation) => (
              <div key={observation.observationId}>
                <p className="field-hint">Measurements · {new Date(observation.recordedAt).toLocaleString()}</p>
                <ul>
                  {observationLabels.flatMap(([field, label, unit]) => {
                    const value = observation[field];
                    return typeof value === "number" ? [`${label}: ${value} ${unit}`] : [];
                  }).map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ))}
            {encounter.triageAssessments?.map((assessment) => (
              <p className="field-hint" key={assessment.triageId}>
                Triage review: {assessment.status} · captured {new Date(assessment.capturedAt).toLocaleString()}
              </p>
            ))}
            {encounter.diagnosticOrders?.map((order) => (
              <p className="field-hint" key={order.orderId}>
                Diagnostic order: {order.serviceCode} · {order.serviceName} · {order.status}
              </p>
            ))}
            {encounter.admissions?.map((admission) => (
              <p className="field-hint" key={admission.admissionId}>
                Inpatient: {admission.status}
                {admission.wardCode ? ` · ward ${admission.wardCode}` : ""}
                {admission.bedCode ? ` · bed ${admission.bedCode}` : ""}
                {admission.dischargedAt ? ` · discharged ${new Date(admission.dischargedAt).toLocaleString()}` : ""}
              </p>
            ))}
          </article>
        ))}
      </div>
      {context.truncated && <p className="field-hint">Showing the 50 most recent encounters.</p>}
    </section>
  );
}

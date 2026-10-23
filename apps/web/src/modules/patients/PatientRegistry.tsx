import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { z } from "zod";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";

const identitySchema = z.object({
  givenName: z.string().trim().min(1, "Enter the given name.").max(100),
  familyName: z.string().trim().min(1, "Enter the family name.").max(100),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Use a valid date.").refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value &&
      date.getTime() <= Date.now();
  }, "Enter a valid date of birth that is not in the future."),
  sexAtRegistration: z.enum(["female", "male", "intersex", "unknown", "not_recorded"]),
});

const searchSchema = z.object({
  recordNumber: z.string().trim().optional(),
  givenName: z.string().trim().optional(),
  familyName: z.string().trim().optional(),
  dateOfBirth: z.string().optional(),
}).refine((value) => Boolean(value.recordNumber) || Boolean(value.givenName && value.familyName), {
  message: "Enter a record number, or both given and family names.",
});

type IdentityValues = z.infer<typeof identitySchema>;
type SearchValues = z.infer<typeof searchSchema>;
type Facility = { facility_id: number; facility_code: string; name: string };
type Candidate = {
  patientId: number;
  recordNumber: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sameName: boolean;
  sameDateOfBirth: boolean;
};
type Patient = IdentityValues & {
  patientId: number;
  recordNumber: string;
  facilityId: number;
  createdAt: string;
};
type ApiError = Error & { code?: string; details?: { candidates?: Candidate[]; existingPatientIds?: number[] } };

async function apiRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = typeof result === "object" && result !== null && "error" in result &&
      typeof result.error === "object" && result.error !== null
      ? result.error
      : null;
    const error = new Error(
      errorBody && "message" in errorBody && typeof errorBody.message === "string"
        ? errorBody.message
        : "The request could not be completed.",
    ) as ApiError;
    if (errorBody) {
      if ("code" in errorBody && typeof errorBody.code === "string") error.code = errorBody.code;
      if ("details" in errorBody) error.details = errorBody.details as ApiError["details"];
    }
    throw error;
  }
  return result as T;
}

export default function PatientRegistry({ canRegister, isSystemAdmin }: { canRegister: boolean; isSystemAdmin: boolean }) {
  const [facilityId, setFacilityId] = useState<number>();
  const [registrationType, setRegistrationType] = useState<"new" | "existing">(canRegister ? "new" : "existing");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [reviewDisposition, setReviewDisposition] = useState<Record<number, "different_person" | "same_person">>({});
  const [reviewReasons, setReviewReasons] = useState<Record<number, string>>({});
  const [message, setMessage] = useState("");
  const [checkedIdentity, setCheckedIdentity] = useState("");
  const [tooManyMatches, setTooManyMatches] = useState(false);
  const facilitiesQuery = useQuery({
    queryKey: ["assigned-facilities"],
    queryFn: () => apiRequest<{ facilities: Facility[] }>(
      isSystemAdmin ? "/api/v1/admin/facilities" : "/api/v1/facilities",
    ),
    retry: false,
  });
  const facilities = facilitiesQuery.data?.facilities ?? [];
  const selectedFacilityId = facilityId ?? facilities[0]?.facility_id;

  const registrationForm = useForm<IdentityValues>({
    resolver: zodResolver(identitySchema),
    defaultValues: { givenName: "", familyName: "", dateOfBirth: "", sexAtRegistration: "unknown" },
  });
  const searchForm = useForm<SearchValues>({ resolver: zodResolver(searchSchema) });
  const identity = registrationForm.watch();

  const duplicateCheck = useMutation({
    mutationFn: async (values: IdentityValues) => apiRequest<{ candidates: Candidate[]; truncated: boolean }>(
      "/api/v1/patients/duplicate-candidates",
      { ...values, facilityId: selectedFacilityId },
    ),
    onSuccess: (result, values) => {
      setCandidates(result.candidates);
      setCheckedIdentity(JSON.stringify(values));
      setTooManyMatches(result.truncated);
      setReviewDisposition({});
      setReviewReasons({});
      setMessage(result.truncated
        ? "More than 20 possible identity matches were found. Refine the details or ask records staff to review."
        : result.candidates.length
          ? "Possible matches require an individual human decision before registration."
          : "No exact name/date-of-birth candidates found. You may continue with registration.");
    },
  });

  const registration = useMutation({
    mutationFn: (values: IdentityValues) => apiRequest<{ patient: Patient; duplicateReview: string }>(
      "/api/v1/patients",
      {
        ...values,
        facilityId: selectedFacilityId,
        ...(candidates.length > 0 ? {
          duplicateReviews: candidates.map((candidate) => ({
            candidatePatientId: candidate.patientId,
            disposition: reviewDisposition[candidate.patientId],
            reason: reviewReasons[candidate.patientId],
          })),
        } : {}),
      },
    ),
    onSuccess: (result) => {
      setCandidates([]);
      registrationForm.reset({ givenName: "", familyName: "", dateOfBirth: "", sexAtRegistration: "unknown" });
      setMessage(`Patient registered. Facility record number: ${result.patient.recordNumber}.`);
    },
    onError: (error, values) => {
      const apiError = error as ApiError;
      if (apiError.code === "POSSIBLE_EXISTING_PATIENT") {
        const existing = apiError.details?.existingPatientIds
          ?.map((patientId) => candidates.find((candidate) => candidate.patientId === patientId))
          .filter((candidate): candidate is Candidate => candidate !== undefined);
        setMessage(existing?.length
          ? `Use the existing patient record${existing.length === 1 ? "" : "s"}: ${existing.map((candidate) => candidate.recordNumber).join(", ")}. No new record was created.`
          : "An existing patient was selected. No new record was created.");
        return;
      }
      if (apiError.code === "DUPLICATE_CANDIDATES" && apiError.details?.candidates) {
        setCandidates(apiError.details.candidates);
        setCheckedIdentity(JSON.stringify(values));
        setTooManyMatches(false);
        setReviewDisposition({});
        setReviewReasons({});
        setMessage("Possible matches were found. Review each one before deciding whether to continue.");
      }
    },
  });

  const search = useMutation({
    mutationFn: (values: SearchValues) => apiRequest<{ patients: Patient[]; truncated: boolean }>(
      "/api/v1/patients/search",
      {
        facilityId: selectedFacilityId,
        ...(values.recordNumber ? { recordNumber: values.recordNumber } : {
          givenName: values.givenName,
          familyName: values.familyName,
          ...(values.dateOfBirth ? { dateOfBirth: values.dateOfBirth } : {}),
        }),
      },
    ),
  });

  if (facilitiesQuery.isPending) return <p className="muted">Loading assigned facilities…</p>;
  if (facilitiesQuery.isError) return <p className="form-error" role="alert">Assigned facilities could not be loaded.</p>;
  if (facilities.length === 0) return <p className="notice-card">No active facility is assigned to this account. Ask an administrator to review its facility access.</p>;

  const canSubmitRegistration = !candidates.length || candidates.every((candidate) =>
    reviewDisposition[candidate.patientId] &&
    reviewReasons[candidate.patientId]?.trim().length >= 10,
  );
  const currentIdentity = JSON.stringify(identity);
  const identityWasChecked = checkedIdentity === currentIdentity && !tooManyMatches;
  const candidateError = duplicateCheck.isError ? duplicateCheck.error.message : "";
  const registrationError = registration.isError ? registration.error.message : "";
  const searchError = search.isError ? search.error.message : "";

  return (
    <section className="patient-registry">
      <div className="page-heading registry-heading">
        <div>
          <p className="eyebrow">MASTER PATIENT INDEX</p>
          <Link className="registry-back-link" to="/">← Back to Dashboard</Link>
          <h1>{canRegister ? "Register patient" : "Patient identity"}</h1>
          <p className="muted">Create a patient record or find an existing facility record. Potential matches are never merged automatically.</p>
        </div>
        <label className="facility-select-label" htmlFor="facility-select">Facility
          <select id="facility-select" value={selectedFacilityId} onChange={(event) => {
            setFacilityId(Number(event.target.value));
            search.reset();
            duplicateCheck.reset();
            registration.reset();
            setCandidates([]);
            setMessage("");
            setCheckedIdentity("");
            setTooManyMatches(false);
          }}>
            {facilities.map((facility) => <option key={facility.facility_id} value={facility.facility_id}>{facility.name}</option>)}
          </select>
        </label>
      </div>

      <section className="registry-panel registry-main-panel">
        {canRegister && (
          <fieldset className="patient-registration-type">
            <legend><span className="registry-section-icon" aria-hidden="true">i</span> Registration type</legend>
            <div className="patient-registration-options">
              <label className={registrationType === "new" ? "patient-registration-selected" : ""}>
                <input
                  type="radio"
                  name="registration-type"
                  value="new"
                  checked={registrationType === "new"}
                  onChange={() => setRegistrationType("new")}
                />
                <span><strong>New patient</strong><small>Enter identity details to create a new record.</small></span>
              </label>
              <label className={registrationType === "existing" ? "patient-registration-selected" : ""}>
                <input
                  type="radio"
                  name="registration-type"
                  value="existing"
                  checked={registrationType === "existing"}
                  onChange={() => setRegistrationType("existing")}
                />
                <span><strong>Existing patient</strong><small>Find an existing facility record.</small></span>
              </label>
            </div>
          </fieldset>
        )}

        {(!canRegister || registrationType === "existing") && (
          <div className="registry-main-section">
          <div className="registry-panel-heading">
            <div><h2>Find an existing patient</h2><p>Search by facility record number or full name.</p></div>
          </div>
          <form className="registry-form" onSubmit={searchForm.handleSubmit((values) => search.mutate(values))} noValidate>
            <fieldset className="registry-form-section">
              <legend>Patient details</legend>
              <label htmlFor="search-record">Facility record number</label>
              <input id="search-record" placeholder="Enter a facility record number" {...searchForm.register("recordNumber")} />
              <div className="form-divider"><span>OR SEARCH BY NAME</span></div>
              <div className="form-row">
                <div><label htmlFor="search-given">Given name</label><input id="search-given" {...searchForm.register("givenName")} /></div>
                <div><label htmlFor="search-family">Family name</label><input id="search-family" {...searchForm.register("familyName")} /></div>
              </div>
              <label htmlFor="search-dob">Date of birth <span>optional</span></label>
              <input id="search-dob" type="date" {...searchForm.register("dateOfBirth")} />
            </fieldset>
            {searchForm.formState.errors.root && <p className="form-error" role="alert">{searchForm.formState.errors.root.message}</p>}
            {searchError && <p className="form-error" role="alert">{searchError}</p>}
            <button className="primary-button" type="submit" disabled={search.isPending}>
              {search.isPending ? "Searching…" : "Search patient index"} <span aria-hidden="true">→</span>
            </button>
          </form>
          {search.data && (
            <div className="search-results" aria-live="polite">
              <h3>{search.data.patients.length} matching record{search.data.patients.length === 1 ? "" : "s"}</h3>
              {search.data.truncated && <p className="form-error">Results are limited; refine your search.</p>}
              {search.data.patients.map((patient) => (
                <article className="patient-result" key={patient.patientId}>
                  <div><strong>{patient.givenName} {patient.familyName}</strong><span>{patient.dateOfBirth} · {patient.sexAtRegistration.replace("_", " ")}</span></div>
                  <code>{patient.recordNumber}</code>
                </article>
              ))}
            </div>
          )}
          </div>
        )}

        {canRegister && registrationType === "new" && (
          <div className="registry-main-section">
            <div className="registry-panel-heading">
              <div><h2>Patient information</h2><p>Check for possible matches before creating a new identity record.</p></div>
            </div>
            <form className="registry-form" onSubmit={registrationForm.handleSubmit((values) => registration.mutate(values))} noValidate>
              <fieldset className="registry-form-section">
                <legend>Patient details</legend>
                <div className="form-row">
                  <div>
                    <label htmlFor="given-name">Given name <span aria-hidden="true">*</span></label>
                    <input id="given-name" autoComplete="given-name" {...registrationForm.register("givenName")} aria-invalid={Boolean(registrationForm.formState.errors.givenName)} />
                    {registrationForm.formState.errors.givenName && <span className="field-error">{registrationForm.formState.errors.givenName.message}</span>}
                  </div>
                  <div>
                    <label htmlFor="family-name">Family name <span aria-hidden="true">*</span></label>
                    <input id="family-name" autoComplete="family-name" {...registrationForm.register("familyName")} aria-invalid={Boolean(registrationForm.formState.errors.familyName)} />
                    {registrationForm.formState.errors.familyName && <span className="field-error">{registrationForm.formState.errors.familyName.message}</span>}
                  </div>
                </div>
                <div className="form-row registry-detail-row">
                  <div>
                    <label htmlFor="date-of-birth">Date of birth <span aria-hidden="true">*</span></label>
                    <input id="date-of-birth" type="date" max={new Date().toISOString().slice(0, 10)} {...registrationForm.register("dateOfBirth")} aria-invalid={Boolean(registrationForm.formState.errors.dateOfBirth)} />
                    {registrationForm.formState.errors.dateOfBirth && <span className="field-error">{registrationForm.formState.errors.dateOfBirth.message}</span>}
                  </div>
                  <fieldset className="registry-sex-options">
                    <legend>Sex recorded at registration <span aria-hidden="true">*</span></legend>
                    {(["female", "male", "intersex", "unknown", "not_recorded"] as const).map((sex) => (
                      <label key={sex}>
                        <input type="radio" value={sex} {...registrationForm.register("sexAtRegistration")} />
                        {sex === "not_recorded" ? "Not recorded" : sex.replace("_", " ").replace(/^\w/u, (letter) => letter.toUpperCase())}
                      </label>
                    ))}
                  </fieldset>
                </div>
              </fieldset>
              <button
                className="secondary-button"
                type="button"
                disabled={duplicateCheck.isPending || !identity.givenName || !identity.familyName || !identity.dateOfBirth}
                onClick={() => {
                  setCheckedIdentity("");
                  setTooManyMatches(false);
                  registration.reset();
                  duplicateCheck.mutate(identity);
                }}
              >
                {duplicateCheck.isPending ? "Checking…" : "Check for possible matches"}
              </button>
              {(message || candidateError) && <p className="inline-message" role="status">{candidateError || message}</p>}
              {tooManyMatches && <p className="form-error" role="alert">Too many possible matches. Registration is blocked until records staff review the identity.</p>}
              {candidates.length > 0 && (
                <div className="candidate-list">
                  <h3>Review each possible match</h3>
                  {candidates.map((candidate) => (
                    <div className="candidate-card" key={candidate.patientId}>
                      <div className="candidate-identity">
                        <strong>{candidate.givenName} {candidate.familyName}</strong>
                        <span>{candidate.dateOfBirth} · {candidate.recordNumber}</span>
                        <small>Match evidence: {[
                          candidate.sameName ? "same normalized name" : "",
                          candidate.sameDateOfBirth ? "same date of birth" : "",
                        ].filter(Boolean).join(" · ")}</small>
                      </div>
                      <label>Review decision
                        <select
                          value={reviewDisposition[candidate.patientId] ?? ""}
                          onChange={(event) => setReviewDisposition((current) => ({
                            ...current,
                            [candidate.patientId]: event.target.value as "different_person" | "same_person",
                          }))}
                        >
                          <option value="">Choose…</option>
                          <option value="same_person">Same person — use existing record</option>
                          <option value="different_person">Different person — continue registration</option>
                        </select>
                      </label>
                      <label>Reason for this decision
                        <textarea
                          rows={2}
                          minLength={10}
                          maxLength={500}
                          value={reviewReasons[candidate.patientId] ?? ""}
                          onChange={(event) => setReviewReasons((current) => ({
                            ...current,
                            [candidate.patientId]: event.target.value,
                          }))}
                          placeholder="Record the identifier or evidence reviewed."
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
              {registrationError && (registration.error as ApiError).code !== "POSSIBLE_EXISTING_PATIENT" &&
                <p className="form-error" role="alert">{registrationError}</p>}
              <div className="registry-form-actions">
                <button
                  className="secondary-button registry-clear-button"
                  type="button"
                  onClick={() => {
                    registrationForm.reset({ givenName: "", familyName: "", dateOfBirth: "", sexAtRegistration: "unknown" });
                    duplicateCheck.reset();
                    registration.reset();
                    setCandidates([]);
                    setMessage("");
                    setCheckedIdentity("");
                    setTooManyMatches(false);
                    setReviewDisposition({});
                    setReviewReasons({});
                  }}
                >
                  Clear form
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={registration.isPending || !identityWasChecked || !canSubmitRegistration || tooManyMatches}
                >
                  {registration.isPending ? "Registering…" : "Register patient"} <span aria-hidden="true">→</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </section>
      <div className="notice-card registry-important-note">
        <span className="notice-icon" aria-hidden="true">i</span>
        <div>
          <strong>Important</strong>
          <p>Possible duplicate identities require staff review. A unique facility record number is generated only after registration succeeds.</p>
        </div>
      </div>
    </section>
  );
}

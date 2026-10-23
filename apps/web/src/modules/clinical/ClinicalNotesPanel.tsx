import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4000";
const noteSchema = z.object({
  noteType: z.enum(["clinical", "nursing", "handover", "other"]),
  title: z.string().trim().min(1, "Enter a note title.").max(160),
  content: z.string().trim().min(1, "Enter note content.").max(8000),
});
const amendmentReasonSchema = z.string().trim().min(10, "Explain the reason for amendment (at least 10 characters).").max(1000);

type Encounter = {
  encounterId: string;
  recordNumber: string;
  encounterType: "outpatient" | "emergency";
};
type Note = {
  noteId: string;
  rootNoteId: string;
  parentNoteId: string | null;
  encounterId: string;
  recordNumber: string;
  noteType: "clinical" | "nursing" | "handover" | "other";
  title: string;
  content: string;
  status: "draft" | "signed";
  version: number;
  amendmentReason: string | null;
  authoredByUserId: number;
  authoredBy: string;
  signedByUserId: number | null;
  signedBy: string | null;
  signedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type DraftValues = { noteType: Note["noteType"]; title: string; content: string };
type ApiError = Error & { code?: string };

const emptyDraft: DraftValues = { noteType: "clinical", title: "", content: "" };

async function apiRequest<T>(
  path: string,
  options?: { method?: "GET" | "POST" | "PUT"; body?: unknown; idempotencyKey?: string },
): Promise<T> {
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-KE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Nairobi",
  }).format(new Date(value));
}

export default function ClinicalNotesPanel({
  encounter,
  userId,
  canRead,
  canCreate,
  canSign,
  canAmend,
  onClose,
}: {
  encounter: Encounter;
  userId: number;
  canRead: boolean;
  canCreate: boolean;
  canSign: boolean;
  canAmend: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draftValues, setDraftValues] = useState<DraftValues>(emptyDraft);
  const [editingNote, setEditingNote] = useState<Note>();
  const [amendingNote, setAmendingNote] = useState<Note>();
  const [amendmentReason, setAmendmentReason] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [createKey, setCreateKey] = useState(() => window.crypto.randomUUID());
  const [amendmentKey, setAmendmentKey] = useState(() => window.crypto.randomUUID());
  const notesQuery = useQuery({
    queryKey: ["encounter-notes", encounter.encounterId],
    queryFn: () => apiRequest<{ notes: Note[]; truncated: boolean }>(
      `/api/v1/encounters/${encodeURIComponent(encounter.encounterId)}/notes`,
    ),
    enabled: canRead,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const refreshNotes = () => queryClient.invalidateQueries({
    queryKey: ["encounter-notes", encounter.encounterId],
  });
  const createNote = useMutation({
    mutationFn: (values: DraftValues) => apiRequest<{ note: Note; idempotentReplay: boolean }>(
      `/api/v1/encounters/${encodeURIComponent(encounter.encounterId)}/notes`,
      { method: "POST", body: values, idempotencyKey: createKey },
    ),
    onSuccess: async () => {
      setDraftValues(emptyDraft);
      setCreateKey(window.crypto.randomUUID());
      setFormMessage("Draft saved. Review it before signing.");
      await refreshNotes();
    },
  });
  const updateDraft = useMutation({
    mutationFn: ({ noteId, values }: { noteId: string; values: DraftValues }) =>
      apiRequest(`/api/v1/encounters/${encodeURIComponent(encounter.encounterId)}/notes/${encodeURIComponent(noteId)}`, {
        method: "PUT",
        body: values,
      }),
    onSuccess: async () => {
      setEditingNote(undefined);
      setFormMessage("Draft updated.");
      await refreshNotes();
    },
  });
  const signNote = useMutation({
    mutationFn: (noteId: string) => apiRequest(
      `/api/v1/encounters/${encodeURIComponent(encounter.encounterId)}/notes/${encodeURIComponent(noteId)}/sign`,
      { method: "POST", body: {} },
    ),
    onSuccess: async () => {
      setFormMessage("Note signed and locked. Further changes require an amendment.");
      await refreshNotes();
    },
  });
  const createAmendment = useMutation({
    mutationFn: ({ note, values, reason }: { note: Note; values: DraftValues; reason: string }) =>
      apiRequest(`/api/v1/encounters/${encodeURIComponent(encounter.encounterId)}/notes/${encodeURIComponent(note.noteId)}/amendments`, {
        method: "POST",
        idempotencyKey: amendmentKey,
        body: { ...values, reason },
      }),
    onSuccess: async () => {
      setAmendingNote(undefined);
      setAmendmentReason("");
      setDraftValues(emptyDraft);
      setAmendmentKey(window.crypto.randomUUID());
      setFormMessage("Amendment draft saved. The signed note remains unchanged.");
      await refreshNotes();
    },
  });

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = noteSchema.safeParse(draftValues);
    if (!parsed.success) {
      setFormMessage(parsed.error.issues[0]?.message ?? "Check the note fields.");
      return;
    }
    setFormMessage("");
    createNote.mutate(parsed.data);
  };

  const handleUpdate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingNote) return;
    const parsed = noteSchema.safeParse(draftValues);
    if (!parsed.success) {
      setFormMessage(parsed.error.issues[0]?.message ?? "Check the note fields.");
      return;
    }
    setFormMessage("");
    updateDraft.mutate({ noteId: editingNote.noteId, values: parsed.data });
  };

  const handleAmendment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!amendingNote) return;
    const parsed = noteSchema.safeParse(draftValues);
    const reason = amendmentReasonSchema.safeParse(amendmentReason);
    if (!parsed.success || !reason.success) {
      setFormMessage(parsed.error?.issues[0]?.message ?? reason.error?.issues[0]?.message ?? "Check the amendment fields.");
      return;
    }
    setFormMessage("");
    createAmendment.mutate({ note: amendingNote, values: parsed.data, reason: reason.data });
  };

  return (
    <section className="workflow-card clinical-notes-panel" aria-labelledby="clinical-notes-title">
      <div className="section-title">
        <div>
          <h2 id="clinical-notes-title">Clinical notes</h2>
          <p>Encrypted drafts · signed versions are immutable · amendments preserve prior versions</p>
        </div>
        <div className="note-actions">
          {canRead && <button className="text-button" type="button" onClick={() => void notesQuery.refetch()}>Refresh notes</button>}
          <button className="text-button" type="button" onClick={onClose}>Close record</button>
        </div>
      </div>
      <p className="field-hint">Enter only information supported by the encounter and your authorized role. This workspace does not generate diagnoses or treatment plans.</p>

      {canCreate && !editingNote && !amendingNote && (
        <form className="clinical-note-form" onSubmit={handleCreate}>
          <h3>New note draft</h3>
          <NoteFields values={draftValues} onChange={(next) => {
            setDraftValues(next);
            setCreateKey(window.crypto.randomUUID());
          }} idPrefix="new-note" />
          <button className="primary-button clinical-note-submit" type="submit" disabled={createNote.isPending}>
            {createNote.isPending ? "Saving draft…" : "Save draft"} <span aria-hidden="true">→</span>
          </button>
        </form>
      )}

      {editingNote && (
        <form className="clinical-note-form" onSubmit={handleUpdate}>
          <h3>Edit unsigned draft</h3>
          <NoteFields values={draftValues} onChange={setDraftValues} idPrefix="edit-note" />
          <div className="note-actions">
            <button className="secondary-button" type="button" onClick={() => {
              setEditingNote(undefined);
              setDraftValues(emptyDraft);
              setFormMessage("");
            }}>Cancel</button>
            <button className="primary-button clinical-note-submit" type="submit" disabled={updateDraft.isPending}>
              {updateDraft.isPending ? "Saving…" : "Save draft changes"} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      )}

      {amendingNote && (
        <form className="clinical-note-form" onSubmit={handleAmendment}>
          <h3>Amend signed version {amendingNote.version}</h3>
          <p className="field-hint">A new draft will be linked to this signed version. The signed content will not be changed.</p>
          <label className="field-label" htmlFor="amendment-reason">Reason for amendment</label>
          <textarea
            id="amendment-reason"
            value={amendmentReason}
            maxLength={1000}
            rows={3}
            onChange={(event) => {
              setAmendmentReason(event.target.value);
              setAmendmentKey(window.crypto.randomUUID());
            }}
          />
          <NoteFields values={draftValues} onChange={(next) => {
            setDraftValues(next);
            setAmendmentKey(window.crypto.randomUUID());
          }} idPrefix="amendment" />
          <div className="note-actions">
            <button className="secondary-button" type="button" onClick={() => {
              setAmendingNote(undefined);
              setDraftValues(emptyDraft);
              setAmendmentReason("");
              setFormMessage("");
            }}>Cancel</button>
            <button className="primary-button clinical-note-submit" type="submit" disabled={createAmendment.isPending}>
              {createAmendment.isPending ? "Saving amendment…" : "Save amendment draft"} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      )}

      {formMessage && <p className="inline-message" role="status">{formMessage}</p>}
      {createNote.isError && <p className="form-error" role="alert">{createNote.error.message}</p>}
      {updateDraft.isError && <p className="form-error" role="alert">{updateDraft.error.message}</p>}
      {signNote.isError && <p className="form-error" role="alert">{signNote.error.message}</p>}
      {createAmendment.isError && <p className="form-error" role="alert">{createAmendment.error.message}</p>}

      {canRead && (
        <div className="clinical-note-history">
          <h3>Note history</h3>
          {notesQuery.isPending && <p className="muted">Loading clinical notes…</p>}
          {notesQuery.isError && <p className="form-error" role="alert">{notesQuery.error.message}</p>}
          {notesQuery.data && notesQuery.data.notes.length === 0 && <p className="muted">No notes have been recorded for this encounter.</p>}
          {notesQuery.data?.notes.map((note) => (
            <article className={`clinical-note-entry ${note.status === "signed" ? "clinical-note-signed" : ""}`} key={note.noteId}>
              <div className="clinical-note-heading">
                <div>
                  <h4>{note.title} <span className="note-version">v{note.version}</span></h4>
                  <p>{note.noteType} · {note.status} · by {note.authoredBy} · {formatDate(note.createdAt)} EAT</p>
                </div>
                {note.status === "signed" && <span className="queue-status">Signed</span>}
              </div>
              {note.amendmentReason && <p className="amendment-reason"><strong>Amendment reason:</strong> {note.amendmentReason}</p>}
              <pre className="clinical-note-content">{note.content}</pre>
              {note.signedAt && <p className="field-hint">Signed by {note.signedBy} at {formatDate(note.signedAt)} EAT</p>}
              <div className="note-actions">
                {note.status === "draft" && note.authoredByUserId === userId && canCreate && (
                  <button className="secondary-button" type="button" onClick={() => {
                    setEditingNote(note);
                    setDraftValues({ noteType: note.noteType, title: note.title, content: note.content });
                    setFormMessage("");
                  }}>Edit draft</button>
                )}
                {note.status === "draft" && note.authoredByUserId === userId && canSign && (
                  <button className="table-action" type="button" disabled={signNote.isPending} onClick={() => {
                    if (window.confirm("Signing locks this note. Further changes require a reasoned amendment. Sign this note?")) {
                      signNote.mutate(note.noteId);
                    }
                  }}>Sign note</button>
                )}
                {note.status === "signed" && canAmend && (
                  <button className="secondary-button" type="button" onClick={() => {
                    setAmendingNote(note);
                    setDraftValues({ noteType: note.noteType, title: note.title, content: "" });
                    setAmendmentReason("");
                    setAmendmentKey(window.crypto.randomUUID());
                    setFormMessage("");
                  }}>Create amendment</button>
                )}
              </div>
            </article>
          ))}
          {notesQuery.data?.truncated && <p className="field-hint">Showing the first 100 note versions. Note-history pagination is not yet implemented.</p>}
        </div>
      )}
    </section>
  );
}

function NoteFields({
  values,
  onChange,
  idPrefix,
}: {
  values: DraftValues;
  onChange: (values: DraftValues) => void;
  idPrefix: string;
}) {
  return (
    <>
      <label className="field-label" htmlFor={`${idPrefix}-type`}>Note type</label>
      <select
        id={`${idPrefix}-type`}
        className="workflow-select"
        value={values.noteType}
        onChange={(event) => {
          const noteType = event.target.value;
          if (noteType === "clinical" || noteType === "nursing" || noteType === "handover" || noteType === "other") {
            onChange({ ...values, noteType });
          }
        }}
      >
        <option value="clinical">Clinical</option>
        <option value="nursing">Nursing</option>
        <option value="handover">Handover</option>
        <option value="other">Other</option>
      </select>
      <label className="field-label" htmlFor={`${idPrefix}-title`}>Title</label>
      <input
        id={`${idPrefix}-title`}
        className="clinical-note-title"
        value={values.title}
        maxLength={160}
        onChange={(event) => onChange({ ...values, title: event.target.value })}
      />
      <label className="field-label" htmlFor={`${idPrefix}-content`}>Note content</label>
      <textarea
        id={`${idPrefix}-content`}
        className="clinical-note-textarea"
        value={values.content}
        maxLength={8000}
        rows={7}
        spellCheck
        onChange={(event) => onChange({ ...values, content: event.target.value })}
      />
    </>
  );
}

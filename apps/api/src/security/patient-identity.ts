export interface PatientIdentityInput {
  givenName: string;
  familyName: string;
  dateOfBirth: string;
}

export interface DuplicateEvidence {
  nameMatches: boolean;
  dateOfBirthMatches: boolean;
}

export function normalizePatientName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en");
}

export function normalizeFullPatientName(input: Pick<PatientIdentityInput, "givenName" | "familyName">): string {
  return `${normalizePatientName(input.givenName)} ${normalizePatientName(input.familyName)}`;
}

export function getDuplicateEvidence(
  newPatient: PatientIdentityInput,
  existingPatient: PatientIdentityInput,
): DuplicateEvidence {
  return {
    nameMatches: normalizeFullPatientName(newPatient) === normalizeFullPatientName(existingPatient),
    dateOfBirthMatches: newPatient.dateOfBirth === existingPatient.dateOfBirth,
  };
}

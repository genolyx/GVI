const INTERNAL_CASE_NUMBER = /^[a-f0-9]{64}$/;

/** Portal jobs store a hash as the case number. The order id is the name people use. */
export function caseDisplayName(caseNumber: string, alias?: string | null): string {
  const name = alias?.trim();
  if (name && INTERNAL_CASE_NUMBER.test(caseNumber)) return name;
  return caseNumber;
}

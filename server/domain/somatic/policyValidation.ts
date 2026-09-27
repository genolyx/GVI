const SHA256 = /^[a-f0-9]{64}$/i;

export type NegativeReportingPolicyValidation = {
  valid: boolean;
  validationArtifactHash: string | null;
};

/**
 * Negative reporting is a separately validated capability. A policy flag alone
 * is insufficient; activation requires the immutable validation artifact hash
 * under this canonical policy key.
 */
export function validateNegativeReportingPolicy(
  allowNegativeReporting: boolean,
  policy: Record<string, unknown>
): NegativeReportingPolicyValidation {
  if (!allowNegativeReporting) {
    return { valid: true, validationArtifactHash: null };
  }

  const candidate = policy.negativeReportingValidationArtifactHash;
  if (typeof candidate !== "string" || !SHA256.test(candidate)) {
    return { valid: false, validationArtifactHash: null };
  }

  return {
    valid: true,
    validationArtifactHash: candidate.toLowerCase(),
  };
}

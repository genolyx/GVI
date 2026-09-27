export type PolicyImpactInput = {
  contentHash: string;
  allowNegativeReporting: boolean;
  enableOncoKb: boolean;
};

export function classifyPolicyImpact(
  previous: PolicyImpactInput | null,
  target: PolicyImpactInput
) {
  if (!previous) {
    return { changed: false, changedControls: [] as string[] };
  }

  const changedControls = [
    previous.allowNegativeReporting !== target.allowNegativeReporting
      ? "negative_reporting"
      : null,
    previous.enableOncoKb !== target.enableOncoKb
      ? "oncokb_enablement"
      : null,
    previous.contentHash !== target.contentHash ? "policy_content" : null,
  ].filter((value): value is string => Boolean(value));

  return { changed: changedControls.length > 0, changedControls };
}

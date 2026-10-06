import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { SomaticAssayReview } from "@/pages/workbench/SomaticAssayReview";
import {
  AMP_LEVELS,
  ONCOGENICITY_CLASSIFICATIONS,
  SOMATIC_TIERS,
} from "@shared/clinical-standards";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Play,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

export default function SomaticWorkbenchPage({ caseId }: { caseId: number }) {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [finalTier, setFinalTier] =
    useState<(typeof SOMATIC_TIERS)[number]>("Tier III");
  const [finalLevel, setFinalLevel] = useState<
    (typeof AMP_LEVELS)[number] | ""
  >("");
  const [oncogenicity, setOncogenicity] =
    useState<(typeof ONCOGENICITY_CLASSIFICATIONS)[number]>("Not Evaluated");
  const [rationale, setRationale] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const canRead = hasPermission("variant:read");

  const review = trpc.somatic.caseReview.useQuery(
    { organizationId: activeOrganizationId || 0, caseId },
    {
      enabled: Boolean(activeOrganizationId && caseId && canRead),
      refetchInterval: 2500,
    }
  );
  const detail = trpc.somatic.assertionDetail.useQuery(
    {
      organizationId: activeOrganizationId || 0,
      assertionId: selectedId || 0,
    },
    { enabled: Boolean(activeOrganizationId && selectedId && canRead) }
  );
  useEffect(() => {
    if (!selectedId && review.data?.assertions[0]) {
      setSelectedId(review.data.assertions[0].assertion.id);
    }
  }, [review.data?.assertions, selectedId]);
  useEffect(() => {
    const assertion = detail.data?.assertion;
    if (!assertion) return;
    setFinalTier(assertion.finalTier || assertion.systemTier || "Tier III");
    setFinalLevel(assertion.finalLevel || assertion.systemLevel || "");
    setOncogenicity(assertion.oncogenicity || "Not Evaluated");
    setRationale(assertion.rationale);
    setOverrideReason(assertion.overrideReason || "");
  }, [detail.data?.assertion]);
  useEffect(() => {
    setShowAllEvidence(false);
  }, [selectedId]);

  const start = trpc.somatic.start.useMutation({
    onSuccess: async () => {
      await review.refetch();
      toast.success("Somatic interpretation started.");
    },
    onError: error => toast.error(error.message),
  });
  const reviewAssertion = trpc.somatic.reviewAssertion.useMutation({
    onSuccess: async (_, variables) => {
      await Promise.all([review.refetch(), detail.refetch()]);
      toast.success(
        variables.decision === "approve"
          ? "Assertion approved."
          : variables.decision === "reject"
            ? "Assertion marked not reportable."
            : "Review saved."
      );
    },
    onError: error => toast.error(error.message),
  });

  if (!canRead) {
    return (
      <StatePanel
        type="forbidden"
        title="Somatic workbench access required"
        description="Your organization role cannot read variant interpretations."
      />
    );
  }
  if (review.isLoading) {
    return (
      <StatePanel
        type="loading"
        title="Loading somatic workbench"
        description="Loading tumor context, panel metadata, and clinical assertions."
      />
    );
  }
  if (review.isError || !review.data) {
    return (
      <StatePanel
        type="error"
        title="Failed to load somatic workbench"
        description={review.error?.message || "Somatic context is unavailable."}
        onRetry={() => void review.refetch()}
      />
    );
  }

  const data = review.data;
  const active =
    data.latestRun &&
    ["queued", "validating", "normalizing", "annotating"].includes(
      data.latestRun.status
    );

  const save = (decision: "save" | "approve" | "reject") => {
    if (!activeOrganizationId || !selectedId) return;
    reviewAssertion.mutate({
      organizationId: activeOrganizationId,
      assertionId: selectedId,
      finalTier,
      finalLevel: finalLevel || null,
      oncogenicity,
      rationale,
      overrideReason: overrideReason || undefined,
      decision,
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Somatic cancer interpretation"
        title={`${data.case.caseNumber} · Somatic Workbench`}
        description={`${data.tumor.label} · ${data.panel.manufacturer} ${data.panel.name} ${data.panelVersion.version}`}
        badge={data.latestRun?.status || "not started"}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => navigate(`/cases/${caseId}`)}
            >
              <ArrowLeft className="mr-2 size-4" />
              Case
            </Button>
            {hasPermission("interpretation:edit") ? (
              <Button
                disabled={Boolean(active) || start.isPending}
                onClick={() =>
                  start.mutate({
                    organizationId: activeOrganizationId!,
                    caseId,
                  })
                }
              >
                {start.isPending || active ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Play className="mr-2 size-4" />
                )}
                {data.latestRun
                  ? "Run new interpretation"
                  : "Start interpretation"}
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <ContextCard
          title="Primary tumor"
          value={data.tumor.label}
          detail={`${data.tumor.ontologySystem} ${data.tumor.ontologyVersion} · ${data.tumor.code}`}
        />
        <ContextCard
          title="Specimen"
          value={data.context.specimenCollectionSite}
          detail={data.context.diseaseStatus || "Disease status not recorded"}
        />
        <ContextCard
          title="Target panel"
          value={`${data.panel.manufacturer} ${data.panel.name}`}
          detail={`${data.panelVersion.version} · ${data.panelVersion.genomeBuild}`}
        />
      </div>

      <SomaticAssayReview
        caseId={caseId}
        panelVersion={data.panelVersion}
        onPanelRefresh={() => review.refetch()}
      />

      {!data.latestRun ? (
        <StatePanel
          type="empty"
          title="Somatic interpretation has not started"
          description="Start the isolated somatic pipeline to validate target-panel variants and collect source-native evidence."
        />
      ) : active ? (
        <StatePanel
          type="loading"
          title="Somatic interpretation is running"
          description="Normalization, QC, and licensed evidence collection are in progress."
        />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
          <Card className="clinical-card shadow-none xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">
                Variant QC and normalization
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="outline">{data.analyses.length} analyzed</Badge>
                <Badge variant="outline">
                  {data.analyses.filter(row => row.analysis.candidate).length}{" "}
                  candidates
                </Badge>
                <Badge variant="outline">
                  {
                    data.analyses.filter(
                      row => row.analysis.qcStatus !== "pass"
                    ).length
                  }{" "}
                  require attention
                </Badge>
              </div>
              {data.analyses.some(row => row.analysis.qcStatus !== "pass") ? (
                <div className="max-h-64 overflow-y-auto rounded-xl border border-border/70">
                  {data.analyses
                    .filter(row => row.analysis.qcStatus !== "pass")
                    .map(row => (
                      <div
                        key={row.analysis.id}
                        className="grid gap-2 border-b border-border/60 p-3 text-xs last:border-b-0 sm:grid-cols-[1fr_auto]"
                      >
                        <div>
                          <p className="font-mono font-semibold">
                            {row.variant.gene || "—"}{" "}
                            {row.variant.hgvsP ||
                              row.variant.hgvsC ||
                              row.variant.normalizedId}
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            {row.analysis.normalizationError ||
                              row.analysis.qcReasons.join(", ") ||
                              "Review required"}
                          </p>
                        </div>
                        <Badge variant="outline">{row.analysis.qcStatus}</Badge>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  All analyzed variants passed the Phase 1 candidate QC checks.
                </p>
              )}
            </CardContent>
          </Card>
          <Card className="clinical-card shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Clinical assertions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[650px]">
                {data.assertions.length ? (
                  data.assertions.map(row => (
                    <button
                      key={row.assertion.id}
                      className={`w-full border-t border-border/60 p-4 text-left transition-colors ${
                        selectedId === row.assertion.id
                          ? "bg-primary/8"
                          : "hover:bg-muted/50"
                      }`}
                      onClick={() => setSelectedId(row.assertion.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold">
                          {row.variant.gene || "—"}{" "}
                          {row.variant.hgvsP || row.variant.hgvsC || ""}
                        </span>
                        <Badge variant="outline">{row.assertion.status}</Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {row.assertion.clinicalDomain} ·{" "}
                        {row.assertion.finalTier || "Unclassified"}
                        {row.assertion.finalLevel
                          ? ` / Level ${row.assertion.finalLevel}`
                          : ""}
                      </p>
                    </button>
                  ))
                ) : (
                  <p className="p-5 text-sm text-muted-foreground">
                    No candidate assertions were created. Review the run
                    limitations and variant QC.
                  </p>
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          {detail.data ? (
            <div className="space-y-5">
              <Card className="clinical-card shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">
                    {detail.data.variant.gene}{" "}
                    {detail.data.variant.hgvsP || detail.data.variant.hgvsC}
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
                  <Value
                    label="Transcript"
                    value={detail.data.variant.transcript || "Not provided"}
                  />
                  <Value
                    label="VAF"
                    value={
                      detail.data.variant.vaf
                        ? `${(Number(detail.data.variant.vaf) * 100).toFixed(2)}%`
                        : "Not provided"
                    }
                  />
                  <Value
                    label="Depth"
                    value={
                      detail.data.variant.readDepth?.toString() ||
                      "Not provided"
                    }
                  />
                </CardContent>
              </Card>

              <Card className="clinical-card shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">
                    Review-only system proposal
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {detail.data.assertion.proposalFlags.conflict ? (
                    <div
                      role="alert"
                      className="flex gap-3 rounded-xl border border-red-300 bg-red-50/70 p-4 text-sm text-red-950"
                    >
                      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                      Supporting and contradicting evidence are both present. No
                      guideline proposal may resolve this conflict
                      automatically.
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {detail.data.assertion.systemTier || "No system tier"}
                      {detail.data.assertion.systemLevel
                        ? ` / Level ${detail.data.assertion.systemLevel}`
                        : ""}
                    </Badge>
                    {detail.data.assertion.proposalFlags.reasonCodes.map(
                      reason => (
                        <Badge key={reason} variant="secondary">
                          {reason}
                        </Badge>
                      )
                    )}
                  </div>
                  {detail.data.assertion.proposalFlags.appliedRule ? (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Rule{" "}
                      {
                        detail.data.assertion.proposalFlags.appliedRule
                          .recordKey
                      }{" "}
                      ·{" "}
                      {
                        detail.data.assertion.proposalFlags.appliedRule
                          .providerCode
                      }{" "}
                      {
                        detail.data.assertion.proposalFlags.appliedRule
                          .releaseVersion
                      }
                    </p>
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Provider-native evidence levels are not copied into AMP. A
                      proposal requires exactly one active, validated,
                      disease-pinned guideline rule.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="clinical-card shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">
                    NCCN classification steps
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {detail.data.assertion.proposalFlags.nccn ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {detail.data.assertion.proposalFlags.nccn
                            .provisionalTier
                            ? `Provisional Tier ${detail.data.assertion.proposalFlags.nccn.provisionalTier}`
                            : "No provisional tier"}
                        </Badge>
                        <Badge variant="secondary">
                          {detail.data.assertion.proposalFlags.nccn.nccnMatchStatus}
                        </Badge>
                        <Badge variant="secondary">
                          {
                            detail.data.assertion.proposalFlags.nccn
                              .classificationStatus
                          }
                        </Badge>
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        Rule {detail.data.assertion.proposalFlags.nccn.ruleVersion}
                        . The overall tier stays unset until a reviewer finalizes
                        it. An NCCN category is not copied into an AMP level.
                      </p>
                      <ol className="space-y-2">
                        {detail.data.assertion.proposalFlags.nccn.steps.map(
                          step => (
                            <li
                              key={step.id}
                              className="rounded-xl border border-border/70 p-3"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-semibold">
                                  {step.order}. {step.label}
                                </p>
                                <Badge variant="outline">{step.outcome}</Badge>
                              </div>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                {step.detail}
                              </p>
                              {step.reasonCodes.length ? (
                                <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                                  {step.reasonCodes.join(" · ")}
                                </p>
                              ) : null}
                            </li>
                          )
                        )}
                      </ol>
                      {detail.data.assertion.proposalFlags.nccn.assertionResults
                        .length ? (
                        <div className="space-y-2">
                          {detail.data.assertion.proposalFlags.nccn.assertionResults.map(
                            item => (
                              <div
                                key={item.evidenceId}
                                className="rounded-xl border border-border/70 p-3 text-xs leading-5"
                              >
                                <p className="font-semibold">
                                  {item.assertionId} · {item.location}
                                </p>
                                <p className="text-muted-foreground">
                                  Guideline {item.guidelineVersion} · category{" "}
                                  {item.nccnCategory || "not applied"} ·
                                  candidate level {item.candidateLevel || "none"}
                                </p>
                                {item.regimenId ? (
                                  <p className="text-muted-foreground">
                                    Regimen {item.regimenId} ·{" "}
                                    {item.combinationType} ·{" "}
                                    {(item.drugIds ?? []).join(", ") || "no drug id"}
                                  </p>
                                ) : null}
                                {item.fdaApproval || item.mfdsApproval ? (
                                  <p className="text-muted-foreground">
                                    FDA {item.fdaApproval} · MFDS {item.mfdsApproval}
                                    {item.offLabel ? " · off-label" : ""} · KR{" "}
                                    {item.regionalApproval || "not recorded"}. Approval
                                    is separate from the AMP level.
                                  </p>
                                ) : null}
                                <p className="font-mono text-[11px] text-muted-foreground">
                                  {item.ruleIds.join(" · ") || "no rule"} ·{" "}
                                  {item.reasonCodes.join(" · ")}
                                </p>
                              </div>
                            )
                          )}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">
                      This assertion was saved before the NCCN step trace. Start
                      somatic interpretation again to record the classification
                      order.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="clinical-card shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">
                    Source-native evidence
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {detail.data.evidence.length ? (
                    <>
                      {(showAllEvidence
                        ? detail.data.evidence
                        : detail.data.evidence.slice(0, 5)
                      ).map(item => (
                        <div
                          key={item.id}
                          className="rounded-xl border border-border/70 p-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold">
                                {item.sourceName}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Native level{" "}
                                {item.sourceNativeLevel || "not stated"} ·
                                disease match {item.diseaseMatch}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {item.payload?.researchOnly === true ? (
                                <Badge className="border-amber-300 bg-amber-50 text-amber-800">
                                  Research only
                                </Badge>
                              ) : null}
                              <Badge
                                variant="outline"
                                className={
                                  item.direction === "contradicting"
                                    ? "border-red-300 text-red-700"
                                    : item.direction === "supporting"
                                      ? "border-emerald-300 text-emerald-700"
                                      : ""
                                }
                              >
                                {item.direction}
                              </Badge>
                              {item.sourceUrl ? (
                                <a
                                  href={item.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-primary"
                                  aria-label={`Open ${item.sourceName} evidence`}
                                >
                                  <ExternalLink className="size-4" />
                                </a>
                              ) : null}
                            </div>
                          </div>
                          <p className="mt-3 text-xs leading-5 text-muted-foreground">
                            {item.summary}
                          </p>
                          {item.sourceName.toLowerCase() === "oncokb" ? (
                            <p className="mt-2 text-[11px] text-muted-foreground">
                              Data version{" "}
                              {String(
                                item.payload?.dataVersion ||
                                  item.sourceVersion ||
                                  "not stated"
                              )}{" "}
                              · retrieved{" "}
                              {new Date(item.retrievedAt).toLocaleString()}
                            </p>
                          ) : null}
                        </div>
                      ))}
                      {detail.data.evidence.length > 5 ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full"
                          onClick={() => setShowAllEvidence(value => !value)}
                        >
                          {showAllEvidence
                            ? "Show fewer evidence records"
                            : `Show all ${detail.data.evidence.length} evidence records`}
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4 text-sm">
                      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700" />
                      No accepted licensed evidence was collected. This does not
                      imply benignity.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="clinical-card shadow-none">
                <CardHeader>
                  <CardTitle className="text-base">
                    Expert classification
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Final AMP Tier">
                      <select
                        value={finalTier}
                        onChange={e =>
                          setFinalTier(e.target.value as typeof finalTier)
                        }
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                      >
                        {SOMATIC_TIERS.map(value => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Final AMP Level">
                      <select
                        value={finalLevel}
                        onChange={e =>
                          setFinalLevel(e.target.value as typeof finalLevel)
                        }
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                      >
                        <option value="">Not applicable</option>
                        {AMP_LEVELS.map(value => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Oncogenicity">
                      <select
                        value={oncogenicity}
                        onChange={e =>
                          setOncogenicity(e.target.value as typeof oncogenicity)
                        }
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                      >
                        {ONCOGENICITY_CLASSIFICATIONS.map(value => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Reviewer rationale">
                    <Textarea
                      value={rationale}
                      onChange={e => setRationale(e.target.value)}
                      rows={5}
                    />
                  </Field>
                  <Field label="Override reason">
                    <Textarea
                      value={overrideReason}
                      onChange={e => setOverrideReason(e.target.value)}
                      rows={3}
                      placeholder="Required when final values differ from a system proposal."
                    />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      disabled={
                        reviewAssertion.isPending ||
                        rationale.trim().length < 20
                      }
                      onClick={() => save("save")}
                    >
                      Save review
                    </Button>
                    {hasPermission("interpretation:approve") ? (
                      <>
                        <Button
                          variant="outline"
                          disabled={
                            reviewAssertion.isPending ||
                            rationale.trim().length < 20
                          }
                          onClick={() => save("reject")}
                        >
                          Mark not reportable
                        </Button>
                        <Button
                          disabled={
                            reviewAssertion.isPending ||
                            rationale.trim().length < 20
                          }
                          onClick={() => save("approve")}
                        >
                          <CheckCircle2 className="mr-2 size-4" />
                          Approve assertion
                        </Button>
                      </>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <StatePanel
              type="empty"
              title="Select a clinical assertion"
              description="Choose an assertion to review its evidence and final classification."
            />
          )}
        </div>
      )}
    </div>
  );
}

function ContextCard({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <Card className="clinical-card shadow-none">
      <CardContent className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        <p className="mt-2 text-sm font-semibold">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

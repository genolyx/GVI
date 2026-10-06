import { ClinicalStatus } from "@/components/ClinicalStatus";
import { PageHeader } from "@/components/PageHeader";
import { UploadProgress } from "@/components/UploadProgress";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Database,
  Dna,
  FileArchive,
  FileUp,
  FlaskConical,
  Loader2,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { caseDisplayName } from "@/lib/caseLabel";
import { formatDateTime } from "@/lib/datetime";
import { putFileWithProgress } from "@/lib/uploadFile";
import { GENE_SCOPE_REQUIRED, hasGeneScopeChoice } from "@shared/geneScope";
import { isVcfFileName } from "@/lib/readVcfHeader";
import { GermlineOrderFields } from "./GermlineOrderFields";
import { HpoTermField } from "./HpoTermField";
import {
  CaseVcfFilters,
  FilterTestTypeField,
  FrequencyRules,
  GeneListField,
  filtersFromJobManifest,
  GeneSymbolList,
  defaultVcfFilters,
  vcfFiltersPayload,
  type CaseVcfFilterValues,
} from "./CaseVcfFilters";
import { frequencyTrackForOrder, FREQUENCY_TRACK_LABEL, type FrequencyTrack } from "@shared/germlineFrequency";
import {
  defaultGermlineOrder,
  GERMLINE_SERVICE_LABEL,
  GERMLINE_TEST_CATEGORY_LABEL,
  germlineServiceFromStored,
  normalizeGermlineOrder,
  type GermlineOrderInput,
} from "@shared/germlineOrder";
import { parseGeneList } from "@shared/geneList";

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

function filterSteps(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return [];
  const steps = (metadata as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap(step => {
    if (!step || typeof step !== "object") return [];
    const row = step as {
      label?: unknown;
      removed?: unknown;
      remaining?: unknown;
      detail?: unknown;
    };
    if (
      typeof row.label !== "string" ||
      typeof row.removed !== "number" ||
      typeof row.remaining !== "number"
    ) {
      return [];
    }
    return [
      {
        label: row.label,
        removed: row.removed,
        remaining: row.remaining,
        detail: typeof row.detail === "string" ? row.detail : null,
      },
    ];
  });
}

function FilterStepList({ metadata }: { metadata: unknown }) {
  const steps = filterSteps(metadata);
  if (!steps.length) return null;
  return (
    <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6">
      {steps.map(step => (
        <li key={step.label}>
          <span className="font-medium">{step.label}</span>
          <span className="text-muted-foreground">
            {" "}
            — {step.removed.toLocaleString()} removed, {step.remaining.toLocaleString()} remain
          </span>
          {step.detail ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">{step.detail}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function detailLines(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const lines = (metadata as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return [];
  return lines.filter(
    (line): line is string => typeof line === "string" && line.trim().length > 0
  );
}

function logPhase(status: string): string {
  if (status === "queued") return "Queued";
  if (status === "failed") return "Failed";
  if (status === "review_ready") return "Ready";
  if (status === "running") return "Running";
  return status;
}

type TimelineEvent = {
  id: number;
  jobId: number;
  status: string;
  message: string;
  createdAt: Date | string;
  metadata: unknown;
};

function AnalysisRunLog({ events }: { events: TimelineEvent[] }) {
  const ordered = [...events].sort((left, right) => {
    const time =
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return time || left.id - right.id;
  });
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <Terminal className="size-3.5" />
        Analysis log
      </div>
      <div className="max-h-72 space-y-2 overflow-auto px-3 py-2 font-mono text-[12px] leading-5">
        {ordered.map(event => {
          const failed = event.status === "failed";
          const lines = detailLines(event.metadata);
          return (
            <div key={event.id}>
              <p className={failed ? "text-rose-800 dark:text-rose-200" : "text-foreground/80"}>
                <span className="text-muted-foreground">{formatDateTime(event.createdAt)}</span>
                {"  "}
                <span className={failed ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-400"}>
                  {logPhase(event.status)}
                </span>
                {"  "}
                {event.message}
              </p>
              {lines.map((line, index) => (
                <p key={`${event.id}-${index}`} className="pl-4 text-foreground/80">
                  {line}
                </p>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>();
  const caseId = Number(params.id);
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [trackRunning, setTrackRunning] = useState(false);
  const query = trpc.cases.get.useQuery(
    { organizationId: activeOrganizationId || 0, caseId },
    {
      enabled: Boolean(
        activeOrganizationId && caseId && hasPermission("case:read")
      ),
      refetchInterval: trackRunning ? 2000 : false,
    }
  );
  useEffect(() => {
    const status = query.data?.status;
    setTrackRunning(status === "queued" || status === "running");
  }, [query.data?.status]);
  const timeline = trpc.cases.timeline.useQuery(
    { organizationId: activeOrganizationId || 0, caseId },
    {
      enabled: Boolean(
        activeOrganizationId && caseId && hasPermission("case:read")
      ),
    }
  );
  const createReport = trpc.somaticReports.createDraft.useMutation({
    onSuccess: result => navigate(`/reports/${result.id}`),
    onError: error => toast.error(error.message),
  });
  const [editingOrder, setEditingOrder] = useState(false);
  const [requestDraft, setRequestDraft] = useState<CaseRequestDraft>({
    panelName: "",
    phenotypeText: "",
    indication: "",
  });
  const [logJobId, setLogJobId] = useState<number | null>(null);
  const [orderDraft, setOrderDraft] =
    useState<GermlineOrderInput>(defaultGermlineOrder);
  const [draftVcf, setDraftVcf] = useState<File | null>(null);
  const [draftFilters, setDraftFilters] =
    useState<CaseVcfFilterValues>(defaultVcfFilters);
  const [draftTrack, setDraftTrack] = useState<FrequencyTrack | "">("");
  const [submittingDraft, setSubmittingDraft] = useState(false);
  const [uploadLabel, setUploadLabel] = useState("Uploading");
  const [uploadPercent, setUploadPercent] = useState(0);
  const utils = trpc.useUtils();
  const requestUpload = trpc.cases.requestUpload.useMutation();
  const completeUpload = trpc.cases.completeUpload.useMutation();
  const submitCase = trpc.cases.submit.useMutation();
  const resetTimeline = trpc.cases.resetTimeline.useMutation({
    onSuccess: async () => {
      setLogJobId(null);
      toast.success("Analysis timeline cleared.");
      await timeline.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const stop = trpc.cases.stop.useMutation({
    onSuccess: async () => {
      toast.success("Analysis stopped.");
      await Promise.all([
        query.refetch(),
        timeline.refetch(),
        utils.cases.list.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });
  const applyPanel = trpc.cases.applyPanel.useMutation();
  const saveOrder = trpc.cases.updateGermlineOrder.useMutation({
    onSuccess: async () => {
      toast.success("Order details saved.");
      setEditingOrder(false);
      await query.refetch();
    },
    onError: error => toast.error(error.message),
  });
  if (!hasPermission("case:read"))
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Case management"
          title="Cases"
          description="View clinical cases within the organization boundary."
        />
        <StatePanel
          type="forbidden"
          title="You do not have permission to view cases"
          description="Ask your organization administrator for a role that includes the case:read action."
          action={
            <Button variant="outline" onClick={() => navigate("/")}>
              Dashboard
            </Button>
          }
        />
      </div>
    );
  if (query.isLoading)
    return (
      <div className="space-y-5">
        <Skeleton className="h-24" />
        <Skeleton className="h-80" />
      </div>
    );
  if (query.isError)
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Case management"
          title="Case error"
          description="Unable to verify the requested case and organization access boundary."
        />
        <StatePanel
          type="error"
          title="Failed to load case"
          description={query.error.message}
          onRetry={() => {
            void query.refetch();
          }}
          action={
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
          }
        />
      </div>
    );
  if (!query.data)
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Case management"
          title="Case not found"
          description="Please verify the requested case identifier."
        />
        <StatePanel
          type="empty"
          title="Case not found"
          description="Cases that have been deleted or do not belong to the current organization are not shown."
          action={
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
          }
        />
      </div>
    );
  const item = query.data;
  const caseName = caseDisplayName(item.caseNumber, item.patientAlias);
  const draftHasVcf = item.files.some(file => file.kind === "vcf");
  const draftHasGeneScope =
    item.purpose !== "germline" ||
    hasGeneScopeChoice({
      panelGenes: item.germlinePanel?.geneCount ?? 0,
      panelRegions: item.germlinePanel?.regionCount ?? 0,
      hpo: item.phenotypeText ?? "",
      genes: draftFilters.genes,
    });
  const applyScope = async (scope: {
    panelId?: number;
    genesText?: string;
    maxAf?: number | null;
    minQual?: number | null;
    minGenotypeQuality?: number | null;
    minDepth?: number | null;
    passOnly?: boolean;
    track?: FrequencyTrack;
  }) => {
    if (!activeOrganizationId) return;
    const canRun = item.status === "review_ready" || item.status === "failed";
    const changingPanel = scope.panelId != null || Boolean(scope.genesText);
    const scopeReady =
      item.purpose !== "germline" ||
      hasGeneScopeChoice({
        panelGenes: changingPanel ? 1 : item.germlinePanel?.geneCount ?? 0,
        panelRegions: changingPanel ? 0 : item.germlinePanel?.regionCount ?? 0,
        hpo: requestDraft.phenotypeText,
        genes: scope.genesText,
      });
    if (!scopeReady) {
      toast.error(GENE_SCOPE_REQUIRED);
      return;
    }
    if (
      canRun &&
      draftHasVcf &&
      !window.confirm(
        changingPanel
          ? `Replace the panel on ${caseName} and run the existing VCF with these filters? Stored variants will be replaced.`
          : `Run ${caseName} again with these filters? The current panel stays. Stored variants will be replaced.`
      )
    ) {
      return;
    }
    try {
      await saveOrder.mutateAsync({
        organizationId: activeOrganizationId,
        caseId: item.id,
        ...orderDraft,
        phenotypeText: requestDraft.phenotypeText,
        indication: requestDraft.indication,
        panelName: requestDraft.panelName,
      });
      const result = await applyPanel.mutateAsync({
        organizationId: activeOrganizationId,
        caseId: item.id,
        ...scope,
      });
      toast.success(
        result.jobId
          ? `${result.name} is running on the existing VCF.`
          : `${result.name} is attached to this order.`
      );
      setEditingOrder(false);
      await Promise.all([query.refetch(), timeline.refetch()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not attach that panel.");
    }
  };
  const submitDraft = async () => {
    if (!activeOrganizationId || submittingDraft) return;
    if (!draftHasVcf && !draftVcf) return;
    try {
      setSubmittingDraft(true);
      setUploadPercent(0);
      if (!draftHasVcf && draftVcf) {
        const sampleId = item.samples[0]?.id;
        setUploadLabel("Preparing upload");
        const ticket = await requestUpload.mutateAsync({
          organizationId: activeOrganizationId,
          caseId: item.id,
          sampleId,
          kind: "vcf",
          fileName: draftVcf.name,
        });
        setUploadLabel("Reading the file");
        const digest = await sha256(draftVcf);
        setUploadLabel(`Uploading ${draftVcf.name}`);
        setUploadPercent(0);
        await putFileWithProgress(ticket.uploadUrl, draftVcf, (loaded, total) => {
          setUploadPercent(total > 0 ? (loaded / total) * 100 : 0);
        });
        setUploadLabel("Saving the file");
        await completeUpload.mutateAsync({
          organizationId: activeOrganizationId,
          caseId: item.id,
          sampleId,
          kind: "vcf",
          fileName: draftVcf.name,
          storageKey: ticket.key,
          accessUrl: ticket.accessUrl,
          mimeType: draftVcf.type || "application/octet-stream",
          byteSize: draftVcf.size,
          sha256: digest,
        });
      }
      setUploadLabel("Submitting");
      setUploadPercent(100);
      await submitCase.mutateAsync({
        organizationId: activeOrganizationId,
        caseId: item.id,
        vcfFilters:
          item.purpose === "germline" && draftTrack
            ? vcfFiltersPayload(draftFilters, item.phenotypeText ?? "", draftTrack)
            : undefined,
      });
      toast.success("Analysis request submitted.");
      setDraftVcf(null);
      await Promise.all([query.refetch(), timeline.refetch(), utils.cases.list.invalidate()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit this case.");
    } finally {
      setSubmittingDraft(false);
    }
  };
  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow={`${item.purpose} · ${item.inputType}`}
        title={caseName}
        description={`${caseName === item.patientAlias ? "" : `${item.patientAlias} · `}${item.referenceBuild} · ${item.panelName || "No panel"}${item.germlinePanel ? ` · ${item.germlinePanel.geneCount.toLocaleString()} genes${item.germlinePanel.regionCount ? `, ${item.germlinePanel.regionCount.toLocaleString()} intervals` : ""}` : ""}`}
        badge={item.status}
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
            {item.status === "draft" && hasPermission("case:edit") ? (
              <Button
                disabled={
                  submittingDraft ||
                  (!item.files.some(file => file.kind === "vcf") && !draftVcf)
                }
                onClick={() => {
                  void submitDraft();
                }}
              >
                {submittingDraft ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 size-4" />
                )}
                {submittingDraft ? "Submitting…" : "Submit analysis request"}
              </Button>
            ) : null}
            {item.variantCount > 0 ? (
              <>
                {item.purpose === "somatic" && hasPermission("report:draft") ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      createReport.mutate({
                        organizationId: activeOrganizationId!,
                        caseId: item.id,
                      })
                    }
                    disabled={createReport.isPending}
                  >
                    Draft Somatic Report
                  </Button>
                ) : null}
                <Button onClick={() => navigate(`/workbench/${item.id}`)}>
                  <FlaskConical className="mr-2 size-4" />
                  {item.variantCount.toLocaleString()} variants
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {createReport.error ? (
        <StatePanel
          compact
          type="error"
          title="Failed to create report draft"
          description={createReport.error.message}
          onRetry={() =>
            createReport.mutate({
              organizationId: activeOrganizationId!,
              caseId: item.id,
            })
          }
        />
      ) : null}
      {item.status === "draft" && hasPermission("case:edit") ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="font-display text-base">Submit analysis</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-sm leading-6 text-muted-foreground">
              This case is still a draft.
              {item.germlinePanel
                ? ` ${item.germlinePanel.name} (${item.germlinePanel.geneCount.toLocaleString()} genes) is already attached and limits the variants.`
                : ""}{" "}
              Choose the VCF, then submit. Intronic changes stay. FILTER PASS stays on unless you turn it off below.
            </p>
            {draftHasVcf ? (
              <p className="text-sm">A VCF is already on this case.</p>
            ) : (
              <label
                className={`flex cursor-pointer items-center gap-4 rounded-xl border border-dashed p-4 ${
                  draftVcf
                    ? "border-primary/40 bg-primary/[0.035]"
                    : "border-border hover:border-primary/30"
                }`}
              >
                <div className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
                  <FileUp className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {draftVcf ? draftVcf.name : "VCF or VCF.GZ"}
                    {!draftVcf ? <span className="text-destructive"> *</span> : null}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                    {draftVcf
                      ? `${(draftVcf.size / 1024 / 1024).toFixed(2)} MB`
                      : "Click to select a .vcf or .vcf.gz file"}
                  </p>
                </div>
                {draftVcf ? <CheckCircle2 className="size-4 text-emerald-600" /> : null}
                <input
                  type="file"
                  className="hidden"
                  onChange={event => {
                    const chosen = event.target.files?.[0] || null;
                    event.target.value = "";
                    if (chosen && !isVcfFileName(chosen.name)) {
                      setDraftVcf(null);
                      toast.error("Choose a .vcf or .vcf.gz file.");
                      return;
                    }
                    setDraftVcf(chosen);
                  }}
                />
              </label>
            )}
            {activeOrganizationId &&
            (item.referenceBuild === "GRCh37" || item.referenceBuild === "GRCh38") ? (
              <CaseVcfFilters
                organizationId={activeOrganizationId}
                referenceBuild={item.referenceBuild}
                file={draftVcf}
                hpo={item.phenotypeText ?? ""}
                values={draftFilters}
                onChange={setDraftFilters}
                panelScope={
                  item.germlinePanel?.panelId
                    ? { panelId: item.germlinePanel.panelId }
                    : null
                }
                track={draftTrack}
                onTrackChange={setDraftTrack}
              />
            ) : null}
            {submittingDraft ? (
              <UploadProgress label={uploadLabel} percent={uploadPercent} />
            ) : null}
            {draftHasGeneScope ? null : (
              <p className="text-sm text-destructive">{GENE_SCOPE_REQUIRED}</p>
            )}
            <div className="flex justify-end border-t border-border/70 pt-5">
              <Button
                size="lg"
                disabled={
                  submittingDraft ||
                  (!draftHasVcf && !draftVcf) ||
                  !draftHasGeneScope ||
                  (item.purpose === "germline" && !draftTrack)
                }
                onClick={() => {
                  void submitDraft();
                }}
              >
                {submittingDraft ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 size-4" />
                )}
                {submittingDraft ? "Submitting…" : "Submit analysis request"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Analysis status",
            value: <ClinicalStatus status={item.status} />,
            icon: Dna,
          },
          {
            label: "Variants",
            value: item.variantCount.toLocaleString(),
            icon: Database,
          },
          { label: "Samples", value: item.samples.length, icon: FlaskConical },
          { label: "Files", value: item.files.length, icon: FileArchive },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label} className="clinical-card shadow-none">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <div className="mt-2 text-lg font-semibold">
                  {value}
                  {label === "Analysis status" && item.status === "failed" ? (
                    <button
                      type="button"
                      className="mt-1 block text-xs font-medium text-primary hover:underline"
                      onClick={() => {
                        const failed = timeline.data?.find(
                          event => event.status === "failed"
                        );
                        if (failed) setLogJobId(failed.jobId);
                        document
                          .getElementById("analysis-timeline")
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      View log
                    </button>
                  ) : null}
                  {label === "Analysis status" &&
                  hasPermission("case:edit") &&
                  (item.status === "queued" || item.status === "running") ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      disabled={stop.isPending}
                      onClick={() => {
                        if (!window.confirm(`Stop analysis for ${caseName}?`)) return;
                        stop.mutate({
                          organizationId: activeOrganizationId!,
                          caseId: item.id,
                        });
                      }}
                    >
                      {stop.isPending ? "Stopping…" : "Stop"}
                    </Button>
                  ) : null}
                </div>
              </div>
              <Icon className="size-5 text-primary" />
            </CardContent>
          </Card>
        ))}
      </section>
      {item.purpose === "germline" ? (
        <GermlineOrderSection
          order={item.germlineOrder}
          patientAlias={item.patientAlias}
          canEdit={hasPermission("case:edit")}
          editing={editingOrder}
          draft={orderDraft}
          saving={saveOrder.isPending}
          onEdit={() => {
            setOrderDraft(normalizeGermlineOrder({
              ...defaultGermlineOrder,
              ...(item.germlineOrder ?? {}),
              service: germlineServiceFromStored(item.germlineOrder ?? {}),
              patientName: item.germlineOrder?.patientName || item.patientAlias,
              testCategory:
                (item.germlineOrder?.testCategory as GermlineOrderInput["testCategory"]) ||
                defaultGermlineOrder.testCategory,
              reportMode:
                item.germlineOrder?.reportMode === "couples" ? "couples" : "single",
              patientGender:
                (item.germlineOrder?.patientGender as GermlineOrderInput["patientGender"]) ||
                "",
              patient2Gender:
                (item.germlineOrder?.patient2Gender as GermlineOrderInput["patient2Gender"]) ||
                "",
              patient3Gender:
                (item.germlineOrder?.patient3Gender as GermlineOrderInput["patient3Gender"]) ||
                "",
              patient2Affected:
                (item.germlineOrder?.patient2Affected as GermlineOrderInput["patient2Affected"]) ||
                "",
              patient3Affected:
                (item.germlineOrder?.patient3Affected as GermlineOrderInput["patient3Affected"]) ||
                "",
              affected:
                (item.germlineOrder?.affected as GermlineOrderInput["affected"]) || "",
              reportLanguage:
                (item.germlineOrder?.reportLanguage as GermlineOrderInput["reportLanguage"]) ||
                "",
              reportType:
                (item.germlineOrder?.reportType as GermlineOrderInput["reportType"]) || "",
              specimenType:
                (item.germlineOrder?.specimenType as GermlineOrderInput["specimenType"]) ||
                "Blood",
            }));
            setRequestDraft({
              panelName: item.panelName ?? "",
              phenotypeText: item.phenotypeText ?? "",
              indication: item.indication ?? "",
            });
            setEditingOrder(true);
          }}
          onCancel={() => setEditingOrder(false)}
          onChange={setOrderDraft}
          request={{
            project: item.projectName,
            patientAlias: item.patientAlias,
            referenceBuild: item.referenceBuild,
            panelName: item.panelName ?? "",
            phenotypeText: item.phenotypeText ?? "",
            indication: item.indication ?? "",
            filters: appliedFilterRows(item.jobs),
          }}
          hpoGenes={item.hpoGenes}
          panelGenes={item.germlinePanel?.genes ?? []}
          panelListName={item.germlinePanel?.name ?? ""}
          requestDraft={requestDraft}
          onRequestChange={patch =>
            setRequestDraft(current => ({ ...current, ...patch }))
          }
          onSave={() =>
            saveOrder.mutate({
              organizationId: activeOrganizationId!,
              caseId: item.id,
              ...orderDraft,
              phenotypeText: requestDraft.phenotypeText,
              indication: requestDraft.indication,
              panelName: requestDraft.panelName,
            })
          }
          organizationId={activeOrganizationId || 0}
          currentPanel={
            item.germlinePanel
              ? `${item.germlinePanel.name} · ${item.germlinePanel.geneCount.toLocaleString()} genes`
              : null
          }
          caseStatus={item.status}
          hasVcf={draftHasVcf}
          applyingScope={applyPanel.isPending || saveOrder.isPending}
          savedManifest={item.jobs[0]?.manifest}
          onApplyScope={scope => {
            void applyScope(scope);
          }}
        />
      ) : null}
      <section id="analysis-timeline" className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <Card className="clinical-card shadow-none">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="font-display text-base">
              Analysis timeline
            </CardTitle>
            {hasPermission("case:edit") && timeline.data?.length ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  resetTimeline.isPending ||
                  item.status === "queued" ||
                  item.status === "running"
                }
                onClick={() => {
                  if (
                    !window.confirm(
                      "Clear the analysis timeline? Stored variants and the case status stay as they are."
                    )
                  ) {
                    return;
                  }
                  resetTimeline.mutate({
                    organizationId: activeOrganizationId!,
                    caseId: item.id,
                  });
                }}
              >
                {resetTimeline.isPending ? "Resetting…" : "Reset"}
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-0">
            {timeline.isError ? (
              <StatePanel
                compact
                type="error"
                title="Failed to load timeline"
                description={timeline.error.message}
                onRetry={() => {
                  void timeline.refetch();
                }}
              />
            ) : timeline.data?.length ? (
              timeline.data.map((event, index) => (
                <div key={event.id} className="grid grid-cols-[28px_1fr] gap-3">
                  <div className="flex flex-col items-center">
                    <div
                      className={`grid size-7 place-items-center rounded-full ${index === 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                    >
                      {index === 0 ? (
                        <CheckCircle2 className="size-3.5" />
                      ) : (
                        <Clock3 className="size-3.5" />
                      )}
                    </div>
                    {index < timeline.data.length - 1 ? (
                      <div className="h-full w-px bg-border" />
                    ) : null}
                  </div>
                  <div className="pb-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <ClinicalStatus status={event.status} />
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {event.progressPercent}%
                      </span>
                      {event.status === "failed" ? (
                        <button
                          type="button"
                          className="text-xs font-medium text-primary hover:underline"
                          onClick={() =>
                            setLogJobId(current =>
                              current === event.jobId ? null : event.jobId
                            )
                          }
                        >
                          {logJobId === event.jobId ? "Hide log" : "View log"}
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm leading-6">{event.message}</p>
                    <FilterStepList metadata={event.metadata} />
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </p>
                    {timeline.data?.find(
                      entry => entry.status === "failed" && entry.jobId === logJobId
                    )?.id === event.id ? (
                      <AnalysisRunLog
                        events={timeline.data.filter(entry => entry.jobId === event.jobId)}
                      />
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <StatePanel
                compact
                type="empty"
                title="No timeline entries"
                description="Status change history will appear here once analysis begins."
              />
            )}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Card className="clinical-card shadow-none">
            <CardHeader>
              <CardTitle className="font-display text-base">Samples</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {item.samples.map(sample => (
                <div
                  key={sample.id}
                  className="flex items-center justify-between rounded-xl border border-border/70 px-4 py-3"
                >
                  <div>
                    <p className="font-mono text-xs font-medium">
                      {sample.sampleCode}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {sample.specimenType}
                    </p>
                  </div>
                  <span className="text-xs capitalize text-muted-foreground">
                    {sample.role}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="clinical-card shadow-none">
            <CardHeader>
              <CardTitle className="font-display text-base">
                Input files
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {item.files.map(file => (
                <div
                  key={file.id}
                  className="rounded-xl border border-border/70 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-xs font-medium">
                      {file.fileName}
                    </p>
                    <span className="font-mono text-[9px] uppercase text-muted-foreground">
                      {file.kind === "annotated_vcf" ? "Annotated VCF" : file.kind}
                    </span>
                  </div>
                  <p className="mt-2 truncate font-mono text-[9px] text-muted-foreground">
                    SHA-256 {file.sha256}
                  </p>
                  {file.kind === "annotated_vcf" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      onClick={() => {
                        void utils.cases.downloadFile
                          .fetch({
                            organizationId: activeOrganizationId!,
                            caseId: item.id,
                            fileId: file.id,
                          })
                          .then(result => {
                            window.open(result.url, "_blank", "noopener,noreferrer");
                          })
                          .catch(error => {
                            toast.error(error instanceof Error ? error.message : "Download failed");
                          });
                      }}
                    >
                      Download
                    </Button>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}

function GeneListValue({ text }: { text: string }) {
  const genes = parseGeneList(text);
  if (!genes?.size) return <span>{dash(text)}</span>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{genes.size.toLocaleString()} genes</p>
      <GeneSymbolList genes={[...genes]} />
    </div>
  );
}

function dash(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
}

function readLimit(
  value: string,
  label: string,
  max: number,
  integer = false
): number | null | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  ) {
    toast.error(`${label} must be a number from 0 to ${max}.`);
    return "invalid";
  }
  return parsed;
}

function LimitField({
  id,
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  hint: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        inputMode="decimal"
        placeholder={placeholder}
        className="font-mono"
      />
      <p className="text-xs leading-5 text-muted-foreground">{hint}</p>
    </div>
  );
}

function numberOrBlank(value: unknown, blank: string) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : blank;
}

function appliedFilterRows(jobs: Array<{ manifest: unknown }>): Array<[string, string]> {
  const manifest = jobs[0]?.manifest;
  if (!manifest || typeof manifest !== "object") return [];
  const raw = (manifest as { vcfFilters?: unknown }).vcfFilters;
  if (!raw || typeof raw !== "object") return [];
  const filters = raw as Record<string, unknown>;
  const rows: Array<[string, string]> = [
    ["Maximum allele frequency", numberOrBlank(filters.maxAf, "No maximum")],
    ["FILTER is PASS", filters.passOnly === true ? "Yes" : "No"],
    ["Coding changes only", filters.codingOnly === true ? "Yes" : "No"],
    ["Minimum QUAL", numberOrBlank(filters.minQual, "No minimum")],
    ["Minimum genotype quality", numberOrBlank(filters.minGenotypeQuality, "No minimum")],
    ["Minimum read depth", numberOrBlank(filters.minDepth, "No minimum")],
  ];
  const track = filters.track;
  if (typeof track === "string" && track in FREQUENCY_TRACK_LABEL) {
    rows.unshift(["Frequency track", FREQUENCY_TRACK_LABEL[track as FrequencyTrack]]);
  } else {
    if (typeof filters.excludeClinvarBenign === "boolean") {
      rows.splice(3, 0, [
        "ClinVar benign calls excluded",
        filters.excludeClinvarBenign ? "Yes" : "No",
      ]);
    }
    if (typeof filters.excludeClinvarVus === "boolean") {
      const benignShown = typeof filters.excludeClinvarBenign === "boolean";
      rows.splice(benignShown ? 4 : 3, 0, [
        "ClinVar VUS excluded",
        filters.excludeClinvarVus ? "Yes" : "No",
      ]);
    }
  }
  if (typeof filters.genes === "string" && filters.genes.trim()) {
    rows.push(["Gene list", filters.genes.trim()]);
  }
  return rows;
}

type CaseRequestDraft = {
  panelName: string;
  phenotypeText: string;
  indication: string;
};

function PanelGeneList({ name, genes }: { name: string; genes: string[] }) {
  const [geneQuery, setGeneQuery] = useState("");
  if (!genes.length) return null;
  const needle = geneQuery.trim().toLowerCase();
  const shown = needle
    ? genes.filter(gene => gene.toLowerCase().includes(needle))
    : genes;
  return (
    <Card className="clinical-card shadow-none lg:col-span-2">
      <CardHeader>
        <CardTitle className="font-display text-base">Panel gene list</CardTitle>
        <p className="text-xs text-muted-foreground">
          {name ? `${name} · ` : ""}
          {genes.length.toLocaleString()} {genes.length === 1 ? "gene" : "genes"}. This list is the gene filter for the run.
        </p>
      </CardHeader>
      <CardContent>
        <label className="grid max-w-sm gap-1.5 text-xs font-medium text-muted-foreground">
          Search genes
          <Input
            aria-label="Search panel genes"
            value={geneQuery}
            onChange={event => setGeneQuery(event.target.value)}
            placeholder="Search genes"
          />
        </label>
        <ul className="mt-4 grid max-h-[28rem] grid-cols-6 gap-x-4 gap-y-1 overflow-y-auto">
          {shown.length ? (
            shown.map(gene => (
              <li key={gene} className="truncate font-mono text-xs" title={gene}>
                {gene}
              </li>
            ))
          ) : (
            <li className="col-span-6 text-sm text-muted-foreground">No genes match that search.</li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

function HpoGeneList({
  groups,
}: {
  groups: Array<{ query: string; id: string; label: string; genes: string[] }>;
}) {
  const [geneQuery, setGeneQuery] = useState("");
  const [termKey, setTermKey] = useState("all");
  if (!groups.length) return null;
  const total = groups.reduce((sum, group) => sum + group.genes.length, 0);
  const unique = new Set(groups.flatMap(group => group.genes)).size;
  const needle = geneQuery.trim().toLowerCase();
  const selected =
    termKey === "all" ? groups : groups.filter(group => `${group.query}:${group.id}` === termKey);
  const shownGroups = selected
    .map(group => ({
      ...group,
      genes: needle
        ? group.genes.filter(gene => gene.toLowerCase().includes(needle))
        : group.genes,
    }))
    .filter(group => group.genes.length > 0);
  return (
    <Card className="clinical-card shadow-none lg:col-span-2">
      <CardHeader>
        <CardTitle className="font-display text-base">HPO gene list</CardTitle>
        <p className="text-xs text-muted-foreground">
          Total {total.toLocaleString()} genes · Unique {unique.toLocaleString()}. A gene listed under more than one HPO term is counted again in Total.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            HPO term
            <Select value={termKey} onValueChange={setTermKey}>
              <SelectTrigger className="w-full" aria-label="HPO term">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All HPO terms</SelectItem>
                {groups.map(group => (
                  <SelectItem key={`${group.query}:${group.id}`} value={`${group.query}:${group.id}`}>
                    {group.label} · {group.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Search genes
            <Input
              aria-label="Search genes"
              value={geneQuery}
              onChange={event => setGeneQuery(event.target.value)}
              placeholder="Search genes"
            />
          </label>
        </div>
        <div className="mt-4 max-h-[28rem] space-y-5 overflow-y-auto">
          {shownGroups.length ? (
            shownGroups.map(group => (
              <section key={`${group.query}:${group.id}`}>
                <h3 className="text-sm font-medium">
                  {group.label}
                  <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
                    {group.id}
                  </span>
                </h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  From “{group.query}” · {group.genes.length.toLocaleString()}{" "}
                  {group.genes.length === 1 ? "gene" : "genes"}
                </p>
                <ul className="mt-2 grid grid-cols-6 gap-x-4 gap-y-1">
                  {group.genes.map(gene => (
                    <li key={gene} className="truncate font-mono text-xs">
                      {gene}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No genes match that search.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function OrderCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string]>;
}) {
  return (
    <Card className="clinical-card shadow-none">
      <CardHeader>
        <CardTitle className="font-display text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className={
                label === "Clinical information" ||
                label === "HPO terms" ||
                label === "Clinical indication" ||
                label === "Gene list"
                  ? "sm:col-span-2"
                  : ""
              }
            >
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-1 text-sm">
                {label === "Gene list" ? (
                  <GeneListValue text={value} />
                ) : (
                  <span className="whitespace-pre-wrap">{dash(value)}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function GermlineOrderSection({
  order,
  patientAlias,
  canEdit,
  editing,
  draft,
  saving,
  onEdit,
  onCancel,
  onChange,
  request,
  requestDraft,
  onRequestChange,
  onSave,
  hpoGenes,
  panelGenes,
  panelListName,
  organizationId,
  currentPanel,
  caseStatus,
  hasVcf,
  applyingScope,
  savedManifest,
  onApplyScope,
}: {
  order: { [K in keyof Omit<GermlineOrderInput, "service">]: string } | null;
  patientAlias: string;
  canEdit: boolean;
  editing: boolean;
  draft: GermlineOrderInput;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onChange: (value: GermlineOrderInput) => void;
  request: {
    project: string;
    patientAlias: string;
    referenceBuild: string;
    panelName: string;
    phenotypeText: string;
    indication: string;
    filters: Array<[string, string]>;
  };
  requestDraft: CaseRequestDraft;
  onRequestChange: (patch: Partial<CaseRequestDraft>) => void;
  onSave: () => void;
  hpoGenes: Array<{ query: string; id: string; label: string; genes: string[] }>;
  panelGenes: string[];
  panelListName: string;
  organizationId: number;
  currentPanel: string | null;
  caseStatus: string;
  hasVcf: boolean;
  applyingScope: boolean;
  savedManifest: unknown;
  onApplyScope: (scope: {
    panelId?: number;
    genesText?: string;
    maxAf?: number | null;
    minQual?: number | null;
    minGenotypeQuality?: number | null;
    minDepth?: number | null;
    passOnly?: boolean;
    track?: FrequencyTrack;
  }) => void;
}) {
  const [scopeFilters, setScopeFilters] = useState<CaseVcfFilterValues>(defaultVcfFilters);
  const [scopePanelId, setScopePanelId] = useState("");
  const [scopeTrack, setScopeTrack] = useState<FrequencyTrack | "">("");
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing && !wasEditing.current) {
      const saved = filtersFromJobManifest(savedManifest);
      setScopeFilters(saved.values);
      setScopePanelId("");
      setScopeTrack(saved.track ?? "");
    }
    wasEditing.current = editing;
  }, [editing, savedManifest]);
  const canRun = caseStatus === "review_ready" || caseStatus === "failed";
  const scopeReady = Boolean(
    scopeTrack && ((hasVcf && canRun) || scopePanelId || scopeFilters.genes.trim())
  );
  const empty: Record<keyof GermlineOrderInput, string> = {
    ...defaultGermlineOrder,
    service: "",
    testCategory: "",
    reportMode: "",
    packageCode: "",
    patientName: patientAlias,
    reportLanguage: "",
    reportType: "",
    specimenType: "",
  };
  const current = order ?? empty;
  const category =
    order && order.testCategory in GERMLINE_TEST_CATEGORY_LABEL
      ? GERMLINE_TEST_CATEGORY_LABEL[
          order.testCategory as GermlineOrderInput["testCategory"]
        ]
      : "";
  const serviceLabel = order
    ? GERMLINE_SERVICE_LABEL[germlineServiceFromStored(order)]
    : "";
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-semibold">Order details</h2>
        {canEdit ? (
          editing ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={onSave} disabled={saving}>
                Save order
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={onEdit}>
              Edit order
            </Button>
          )
        ) : null}
      </div>
      {editing ? (
        <div className="space-y-5">
          <section className="space-y-4 rounded-xl border border-border/70 p-4">
            <h3 className="text-sm font-semibold">Case request</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              Saving the order does not re-run the VCF. Apply and run uses the filters below on the VCF already stored here.
              A panel or gene list is the gene filter. HPO terms stay on the order and do not remove variants.
            </p>
            <div className="space-y-3 rounded-xl border border-border/70 p-4">
              <p className="text-sm font-medium">Panel or gene list</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {currentPanel ? `Current panel: ${currentPanel}.` : "No panel is attached."}
                {" "}Choose a gene list saved in Settings. The existing VCF stays on the case.
              </p>
              <GeneListField
                organizationId={organizationId}
                values={scopeFilters}
                hpo=""
                onChange={values => {
                  setScopeFilters(values);
                  setScopePanelId("");
                }}
                onListId={setScopePanelId}
              />
              <FilterTestTypeField
                id="case-rerun-track"
                track={scopeTrack}
                onChange={setScopeTrack}
              />
              {scopeTrack ? <FrequencyRules track={scopeTrack} showTitle={false} /> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <LimitField
                  id="case-rerun-af"
                  label="Maximum allele frequency"
                  value={scopeFilters.maxAf}
                  placeholder="0.001"
                  hint="Blank skips the limit. 0.001 is 0.1%. 0.05 is 5%."
                  onChange={maxAf => setScopeFilters(current => ({ ...current, maxAf }))}
                />
                <LimitField
                  id="case-rerun-qual"
                  label="Minimum QUAL"
                  value={scopeFilters.minQual}
                  placeholder="30"
                  hint="Blank skips QUAL."
                  onChange={minQual => setScopeFilters(current => ({ ...current, minQual }))}
                />
                <LimitField
                  id="case-rerun-gq"
                  label="Minimum genotype quality (GQ)"
                  value={scopeFilters.minGq}
                  placeholder="20"
                  hint="Blank skips GQ."
                  onChange={minGq => setScopeFilters(current => ({ ...current, minGq }))}
                />
                <LimitField
                  id="case-rerun-dp"
                  label="Minimum read depth (DP)"
                  value={scopeFilters.minDepth}
                  placeholder="10"
                  hint="Blank skips read depth."
                  onChange={minDepth => setScopeFilters(current => ({ ...current, minDepth }))}
                />
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2.5 text-sm">
                  <Checkbox
                    checked={scopeFilters.passOnly}
                    onCheckedChange={checked =>
                      setScopeFilters(current => ({ ...current, passOnly: checked === true }))
                    }
                  />
                  FILTER is PASS
                </label>
                <p className="text-xs leading-5 text-muted-foreground">
                  PASS means the caller did not flag the site. Uncheck this to also keep sites marked LowQual or another filter name.
                </p>
              </div>
              <Button
                type="button"
                disabled={!scopeReady || applyingScope || caseStatus === "queued" || caseStatus === "running"}
                onClick={() => {
                  const maxAf = readLimit(scopeFilters.maxAf, "Maximum allele frequency", 1);
                  const minQual = readLimit(scopeFilters.minQual, "Minimum QUAL", 1_000_000);
                  const minGq = readLimit(scopeFilters.minGq, "Minimum genotype quality", 100);
                  const minDepth = readLimit(scopeFilters.minDepth, "Minimum read depth", 100_000, true);
                  if (
                    maxAf === "invalid" ||
                    minQual === "invalid" ||
                    minGq === "invalid" ||
                    minDepth === "invalid"
                  ) {
                    return;
                  }
                  onApplyScope({
                    panelId: scopePanelId ? Number(scopePanelId) : undefined,
                    genesText: scopeFilters.genes.trim() || undefined,
                    maxAf,
                    minQual,
                    minGenotypeQuality: minGq,
                    minDepth,
                    passOnly: scopeFilters.passOnly,
                    track: scopeTrack || undefined,
                  });
                }}
              >
                {applyingScope
                  ? "Applying…"
                  : hasVcf && canRun
                    ? "Apply and run the existing VCF"
                    : "Attach to this order"}
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="text-sm font-medium">Assay</p>
                <Input
                  value={requestDraft.panelName}
                  onChange={event => onRequestChange({ panelName: event.target.value })}
                  placeholder="WES"
                />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">HPO terms</p>
              <HpoTermField
                value={requestDraft.phenotypeText}
                onChange={phenotypeText => onRequestChange({ phenotypeText })}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Clinical indication</p>
              <Textarea
                value={requestDraft.indication}
                onChange={event => onRequestChange({ indication: event.target.value })}
                placeholder="Clinical indication and key question"
              />
            </div>
          </section>
          <GermlineOrderFields value={draft} onChange={onChange} />
        </div>
      ) : (
        <div className="space-y-5">
          <FrequencyRules
            track={frequencyTrackForOrder({
              testCategory: current.testCategory,
              packageCode: current.packageCode,
              otherTestType: current.otherTestType,
            })}
          />
        <div className="grid gap-5 lg:grid-cols-2">
          <OrderCard
            title="Case request"
            rows={[
              ["Project", request.project],
              ["Patient alias", request.patientAlias],
              ["Reference build", request.referenceBuild],
              ["Assay", request.panelName],
              ["Panel", currentPanel ?? ""],
              ["HPO terms", request.phenotypeText],
              ["Clinical indication", request.indication],
            ]}
          />
          <OrderCard
            title="Filters used for this analysis"
            rows={
              request.filters.length
                ? request.filters
                : [["Filters", "No analysis has been submitted"]]
            }
          />
          <PanelGeneList name={panelListName} genes={panelGenes} />
          <HpoGeneList groups={hpoGenes} />
          <OrderCard
            title="Test type and report pairing"
            rows={[
              ["Service", serviceLabel],
              ["Test category", category],
              ["Other test type", current.otherTestType],
              ["Package code (test type)", current.packageCode],
              ["Report mode", current.reportMode],
              ["Partner order ID", current.partnerCaseNumber],
              ["Prior order (follow-up)", current.priorCaseNumber],
            ]}
          />
          <OrderCard
            title="Hospital and identifiers"
            rows={[
              ["Hospital name", current.hospitalName],
              ["Doctor", current.doctor],
              ["Medical record ID", current.medicalRecordId],
              ["Sample ID", current.sampleId],
              ["Affected", current.affected],
              ["Clinical information", current.clinicalInformation],
            ]}
          />
          <OrderCard
            title="Patient"
            rows={[
              ["Patient name", current.patientName || patientAlias],
              ["Patient birth", current.patientBirth],
              ["Patient gender", current.patientGender],
              ...(current.patient2Name || current.patient2Gender
                ? ([
                    ["Patient 2", current.patient2Name],
                    ["Patient 2 birth", current.patient2Birth],
                    ["Patient 2 gender", current.patient2Gender],
                    ["Affected 2", current.patient2Affected],
                  ] as Array<[string, string]>)
                : []),
              ...(current.patient3Name || current.patient3Gender
                ? ([
                    ["Patient 3", current.patient3Name],
                    ["Patient 3 birth", current.patient3Birth],
                    ["Patient 3 gender", current.patient3Gender],
                    ["Affected 3", current.patient3Affected],
                  ] as Array<[string, string]>)
                : []),
            ]}
          />
          <OrderCard
            title="Sample and report details"
            rows={[
              ["Sample collection date", current.sampleCollectionDate],
              ["Receipt date", current.receiptDate],
              ["Report language", current.reportLanguage],
              ["Report type", current.reportType],
              ["Sample specimen type", current.specimenType],
              ["Sample barcode", current.sampleBarcode],
            ]}
          />
        </div>
        </div>
      )}
    </section>
  );
}

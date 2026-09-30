import { ClinicalStatus } from "@/components/ClinicalStatus";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  FlaskConical,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/datetime";
import { GermlineOrderFields } from "./GermlineOrderFields";
import { HpoTermField } from "./HpoTermField";
import {
  defaultGermlineOrder,
  GERMLINE_SERVICE_LABEL,
  GERMLINE_TEST_CATEGORY_LABEL,
  germlineServiceFromStored,
  normalizeGermlineOrder,
  type GermlineOrderInput,
} from "@shared/germlineOrder";

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
  const utils = trpc.useUtils();
  const rerun = trpc.cases.rerun.useMutation({
    onSuccess: async () => {
      toast.success("Analysis queued again.");
      await Promise.all([
        query.refetch(),
        timeline.refetch(),
        utils.cases.list.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });
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
  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow={`${item.purpose} · ${item.inputType}`}
        title={item.caseNumber}
        description={`${item.patientAlias} · ${item.referenceBuild} · ${item.panelName || "No panel"}${item.germlinePanel ? ` · ${item.germlinePanel.geneCount.toLocaleString()} genes${item.germlinePanel.regionCount ? `, ${item.germlinePanel.regionCount.toLocaleString()} intervals` : ""}` : ""}`}
        badge={item.status}
        actions={
          <>
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Back
            </Button>
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
                  {label === "Analysis status" && hasPermission("case:edit") &&
                  (item.status === "failed" ||
                    item.status === "review_ready" ||
                    item.status === "queued" ||
                    item.status === "running") ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={
                        item.status === "queued" || item.status === "running"
                          ? "outline"
                          : "default"
                      }
                      className="mt-2"
                      disabled={rerun.isPending || stop.isPending}
                      onClick={() => {
                        if (item.status === "queued" || item.status === "running") {
                          if (!window.confirm(`Stop analysis for ${item.caseNumber}?`)) return;
                          stop.mutate({
                            organizationId: activeOrganizationId!,
                            caseId: item.id,
                          });
                          return;
                        }
                        if (
                          item.status === "review_ready" &&
                          !window.confirm(
                            `Run ${item.caseNumber} again from the original VCF? Stored variants will be replaced.`
                          )
                        ) {
                          return;
                        }
                        rerun.mutate({
                          organizationId: activeOrganizationId!,
                          caseId: item.id,
                        });
                      }}
                    >
                      {rerun.isPending
                        ? "Running…"
                        : stop.isPending
                          ? "Stopping…"
                          : item.status === "queued" || item.status === "running"
                            ? "Stop"
                            : "Run"}
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
            project: [item.projectCode, item.projectName].filter(Boolean).join(" · "),
            patientAlias: item.patientAlias,
            referenceBuild: item.referenceBuild,
            panelName: item.panelName ?? "",
            phenotypeText: item.phenotypeText ?? "",
            indication: item.indication ?? "",
            filters: appliedFilterRows(item.jobs),
          }}
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

function dash(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
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
              <dd className="mt-1 whitespace-pre-wrap text-sm">{dash(value)}</dd>
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
}) {
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
              Project, reference build, and the filters already used stay as they were for this analysis.
              Assay, HPO terms, and clinical indication can be corrected here. Saving them does not re-run the VCF.
            </p>
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
        <div className="grid gap-5 lg:grid-cols-2">
          <OrderCard
            title="Case request"
            rows={[
              ["Project", request.project],
              ["Patient alias", request.patientAlias],
              ["Reference build", request.referenceBuild],
              ["Assay", request.panelName],
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
      )}
    </section>
  );
}

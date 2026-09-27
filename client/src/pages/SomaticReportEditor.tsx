import { ClinicalStatus } from "@/components/ClinicalStatus";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { formatDate, formatSignatureTimestamp } from "@/lib/datetime";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  CheckCircle2,
  FileCheck2,
  Hash,
  LockKeyhole,
  PenLine,
  Printer,
  Save,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type EditableContent = {
  summary: string;
  interpretation: string;
  methodology: string;
  limitations: string;
  recommendations: string;
};

type Finding = {
  assertionId: number;
  gene: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  transcript: string | null;
  vaf: string | null;
  depth: number | null;
  tier: "Tier I" | "Tier II" | "Tier III" | "Tier IV";
  level: "A" | "B" | "C" | "D" | null;
  oncogenicity: string;
  clinicalDomain: string;
  clinicalEffect: string | null;
  rationale: string;
  evidenceIds: number[];
};

type AssayFinding = {
  id: number;
  findingType: "CNV" | "FUSION" | "MSI" | "TMB" | "HRD";
  status: "detected" | "not_detected" | "not_tested" | "indeterminate";
  result: Record<string, unknown> | null;
  coverageSummaryId: number | null;
  reportable: boolean;
  reviewedAt: string | Date | null;
};

type CoverageSummary = {
  id: number;
  validationStatus: "pending" | "passed" | "failed";
  completeRegionCount: number;
  expectedRegionCount: number;
  sourceArtifactHash: string | null;
  validationHash: string | null;
  validatedAt: string | Date | null;
};

const emptyEditable: EditableContent = {
  summary: "",
  interpretation: "",
  methodology: "",
  limitations: "",
  recommendations: "",
};

export default function SomaticReportEditorPage({ reportId }: { reportId: number }) {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const query = trpc.somaticReports.get.useQuery(
    { organizationId: activeOrganizationId || 0, reportId },
    {
      enabled: Boolean(
        activeOrganizationId && reportId && hasPermission("report:read")
      ),
    }
  );
  const [title, setTitle] = useState("");
  const [editable, setEditable] = useState<EditableContent>(emptyEditable);
  const [attestation, setAttestation] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [amendOpen, setAmendOpen] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    const content = query.data.report.content as {
      editable?: Partial<EditableContent>;
    };
    setTitle(query.data.report.title);
    setEditable({ ...emptyEditable, ...(content.editable || {}) });
  }, [query.data]);

  const update = trpc.somaticReports.update.useMutation({
    onSuccess: async () => {
      await query.refetch();
      toast.success("Somatic report draft saved.");
    },
    onError: error => toast.error(error.message),
  });
  const review = trpc.somaticReports.submitReview.useMutation({
    onSuccess: async () => {
      await query.refetch();
      toast.success("Somatic report moved to clinical review.");
    },
    onError: error => toast.error(error.message),
  });
  const returnToDraft = trpc.somaticReports.returnToDraft.useMutation({
    onSuccess: async () => {
      await query.refetch();
      toast.success("Somatic report returned to draft.");
    },
    onError: error => toast.error(error.message),
  });
  const sign = trpc.somaticReports.sign.useMutation({
    onSuccess: async result => {
      await query.refetch();
      toast.success(`Electronic signature complete · ${result.snapshotHash.slice(0, 12)}…`);
    },
    onError: error => toast.error(error.message),
  });
  const amend = trpc.somaticReports.amend.useMutation({
    onSuccess: result => {
      setAmendOpen(false);
      setAmendReason("");
      navigate(`/reports/${result.id}`);
    },
    onError: error => toast.error(error.message),
  });

  if (!hasPermission("report:read")) {
    return (
      <StatePanel
        type="forbidden"
        title="Somatic report access required"
        description="Your organization role cannot read clinical reports."
      />
    );
  }
  if (query.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-20" />
        <Skeleton className="h-[700px]" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <StatePanel
        type="error"
        title="Failed to load Somatic Clinical Report"
        description={query.error?.message || "Report not found."}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const {
    report,
    clinicalCase,
    context,
    tumor,
    panel,
    panelVersion,
    templateVersion,
    signerName,
    signerEmail,
    evidence,
  } = query.data;
  const content = report.content as {
    findings?: Finding[];
    assayFindings?: AssayFinding[];
    coverageSummaries?: CoverageSummary[];
    panelRegionArtifact?: {
      name: string | null;
      hash: string | null;
      validationStatus: "pending" | "passed" | "failed";
    };
    reportConclusion?: {
      type: "findings_present" | "full_panel_negative";
      coverageSummaryId?: number | null;
      coverageValidationHash?: string | null;
      policyVersion?: string | number | null;
    };
  };
  const findings = content.findings || [];
  const assayFindings = content.assayFindings || [];
  const coverageSummaries = content.coverageSummaries || [];
  const significant = findings.filter(item => item.tier === "Tier I" || item.tier === "Tier II");
  const vus = findings.filter(item => item.tier === "Tier III");
  const tierIV = findings.filter(item => item.tier === "Tier IV");
  const template = templateVersion.schema;
  const visible = new Map(template.sections.map(section => [section.id, section]));
  const editableReport = report.status === "draft" && hasPermission("report:draft");
  const actionError =
    update.error || review.error || returnToDraft.error || sign.error || amend.error;

  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const setField = (key: keyof EditableContent, value: string) =>
    setEditable(current => ({ ...current, [key]: value }));

  return (
    <div className="space-y-6">
      <div className="no-print">
        <PageHeader
          eyebrow={`Somatic Clinical Report · v${report.version}`}
          title={report.title}
          description={`${clinicalCase.caseNumber} · ${tumor.label} · ${panel.manufacturer} ${panel.name} ${panelVersion.version}`}
          badge={report.status}
          actions={
            <>
              <Button variant="outline" onClick={() => navigate("/reports")}>
                <ArrowLeft className="mr-2 size-4" />
                Reports
              </Button>
              <Button variant="outline" onClick={() => window.print()}>
                <Printer className="mr-2 size-4" />
                Print / PDF
              </Button>
            </>
          }
        />
      </div>

      {report.status === "signed" || report.status === "amended" ? (
        <Alert className="no-print border-emerald-200 bg-emerald-50/65 text-emerald-950">
          <LockKeyhole className="size-4 text-emerald-700" />
          <AlertTitle>Immutable Somatic Clinical Report snapshot</AlertTitle>
          <AlertDescription>
            Template, findings, evidence, provenance, and editable text are frozen
            under the SHA-256 digest shown below.
          </AlertDescription>
        </Alert>
      ) : null}
      {content.reportConclusion?.type === "full_panel_negative" ? (
        <Alert className="border-sky-200 bg-sky-50/70 text-sky-950">
          <FileCheck2 className="size-4 text-sky-700" />
          <AlertTitle>Validated full-panel negative conclusion</AlertTitle>
          <AlertDescription>
            This conclusion is limited to the approved panel scope and complete
            coverage recorded below. Coverage validation{" "}
            {content.reportConclusion.coverageValidationHash
              ? content.reportConclusion.coverageValidationHash.slice(0, 12) +
                "…"
              : "is unavailable"}
            {content.reportConclusion.policyVersion
              ? ` · policy v${content.reportConclusion.policyVersion}`
              : ""}
          </AlertDescription>
        </Alert>
      ) : null}
      {actionError ? (
        <StatePanel
          compact
          type="error"
          title="Failed to complete report action"
          description={actionError.message}
        />
      ) : null}

      <article className="report-sheet mx-auto max-w-6xl bg-white p-8 text-slate-900 sm:p-12">
        <header className="border-b-2 border-slate-900 pb-7">
          <p className="text-xs font-semibold uppercase tracking-[.2em] text-[#2a7f91]">
            {template.header || "Genolyx Variant Curation"}
          </p>
          {editableReport ? (
            <Input
              value={title}
              onChange={event => setTitle(event.target.value)}
              className="mt-3 h-auto border-0 p-0 font-display text-2xl font-semibold shadow-none focus-visible:ring-0"
            />
          ) : (
            <h1 className="mt-3 font-display text-2xl font-semibold">{title}</h1>
          )}
          <div className="mt-6 grid gap-4 rounded-xl bg-slate-50 p-5 text-xs sm:grid-cols-4">
            <ReportValue label="Patient alias" value={clinicalCase.patientAlias} />
            <ReportValue label="Primary tumor" value={tumor.label} />
            <ReportValue label="Specimen site" value={context.specimenCollectionSite} />
            <ReportValue
              label="Assay"
              value={`${panel.manufacturer} ${panel.name} ${panelVersion.version}`}
            />
          </div>
        </header>

        <div className="mt-8 space-y-9">
          {visible.get("case_summary")?.visible ? (
            <EditableSection
              title={visible.get("case_summary")!.title}
              value={editable.summary}
              editable={editableReport}
              rows={4}
              onChange={value => setField("summary", value)}
            />
          ) : null}
          {visible.get("significant_findings")?.visible ? (
            <FindingSection
              title={visible.get("significant_findings")!.title}
              findings={significant}
            />
          ) : null}
          {visible.get("genomic_signatures")?.visible ? (
            <section>
              <SectionTitle>{visible.get("genomic_signatures")!.title}</SectionTitle>
              {assayFindings.length ? (
                <AssayFindingSection findings={assayFindings} />
              ) : (
                <p className="mt-3 text-sm leading-7">
                  {visible.get("genomic_signatures")?.editableIntro ||
                    "No reviewed assay findings are included."}
                </p>
              )}
            </section>
          ) : null}
          {visible.get("vus")?.visible ? (
            <FindingSection title={visible.get("vus")!.title} findings={vus} />
          ) : null}
          {template.includeTierIV && tierIV.length ? (
            <FindingSection title="Tier IV Findings" findings={tierIV} />
          ) : null}
          {visible.get("variant_details")?.visible ? (
            <section>
              <SectionTitle>{visible.get("variant_details")!.title}</SectionTitle>
              <div className="mt-4 space-y-5">
                {findings.map(finding => (
                  <div key={finding.assertionId} className="rounded-lg border border-slate-200 p-5">
                    <p className="font-semibold">
                      {finding.gene} {finding.hgvsP || finding.hgvsC}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {finding.transcript || "Transcript not provided"} · VAF{" "}
                      {finding.vaf ? `${(Number(finding.vaf) * 100).toFixed(2)}%` : "—"} ·
                      Depth {finding.depth ?? "—"}
                    </p>
                    <p className="mt-3 text-sm leading-6">{finding.rationale}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {finding.evidenceIds.map(id => {
                        const item = evidenceById.get(id);
                        return (
                          <Badge key={id} variant="outline">
                            {item
                              ? `${item.sourceName} ${item.sourceNativeLevel || ""}`.trim()
                              : `Evidence ${id}`}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {visible.get("methodology")?.visible ? (
            <>
              {(content.panelRegionArtifact || coverageSummaries.length) ? (
                <section>
                  <SectionTitle>Panel and coverage provenance</SectionTitle>
                  <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                    <ReportValue
                      label="Reportable-region artifact"
                      value={
                        content.panelRegionArtifact?.hash
                          ? `${content.panelRegionArtifact.name || "artifact"} · ${content.panelRegionArtifact.validationStatus} · ${content.panelRegionArtifact.hash}`
                          : "Not validated"
                      }
                    />
                    <ReportValue
                      label="Coverage validation"
                      value={
                        coverageSummaries.length
                          ? coverageSummaries
                              .map(
                                summary =>
                                  `${summary.completeRegionCount}/${summary.expectedRegionCount} · ${summary.validationStatus} · ${summary.validationHash || summary.sourceArtifactHash || "hash unavailable"}`
                              )
                              .join("; ")
                          : "No reportable finding requires coverage provenance"
                      }
                    />
                  </div>
                </section>
              ) : null}
              <EditableSection
                title="Clinical Interpretation"
                value={editable.interpretation}
                editable={editableReport}
                rows={8}
                onChange={value => setField("interpretation", value)}
              />
              <EditableSection
                title="Methodology"
                value={editable.methodology}
                editable={editableReport}
                rows={5}
                onChange={value => setField("methodology", value)}
              />
              <EditableSection
                title={visible.get("methodology")!.title}
                value={editable.limitations}
                editable={editableReport}
                rows={6}
                onChange={value => setField("limitations", value)}
              />
              <EditableSection
                title="Recommendations"
                value={editable.recommendations}
                editable={editableReport}
                rows={4}
                onChange={value => setField("recommendations", value)}
              />
            </>
          ) : null}
          {visible.get("references")?.visible ? (
            <section>
              <SectionTitle>{visible.get("references")!.title}</SectionTitle>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-xs leading-5">
                {evidence.map(item => (
                  <li key={item.id}>
                    {item.sourceName} {item.sourceVersion}; record{" "}
                    {item.sourceRecordId}; native level{" "}
                    {item.sourceNativeLevel || "not stated"}.
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>

        <footer className="mt-10 border-t-2 border-slate-900 pt-6">
          <p className="text-xs leading-5 text-slate-600">{template.disclaimer}</p>
          {report.snapshotHash ? (
            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <div>
                <p className="text-[9px] uppercase tracking-wider text-slate-500">
                  Electronic signature
                </p>
                <p className="mt-2 text-sm font-semibold">
                  {signerName || signerEmail || "Verified clinician"}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">
                  {report.signedAt
                    ? formatSignatureTimestamp(report.signedAt)
                    : ""}
                </p>
              </div>
              <div>
                <p className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
                  <Hash className="size-3" />
                  SHA-256 snapshot digest
                </p>
                <p className="mt-2 break-all font-mono text-[9px] leading-4">
                  {report.snapshotHash}
                </p>
              </div>
            </div>
          ) : null}
          <p className="mt-5 text-[10px] text-slate-500">
            {template.footer} · Template v{templateVersion.version} · Generated{" "}
            {formatDate(report.createdAt)}
          </p>
        </footer>
      </article>

      <div className="no-print mx-auto flex max-w-6xl flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <ClinicalStatus status={report.status} />
          <p className="text-xs text-muted-foreground">
            Structured rows come only from approved somatic assertions and
            expert-reviewed assay findings.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {editableReport ? (
            <>
              <Button
                variant="outline"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    organizationId: activeOrganizationId!,
                    reportId,
                    title,
                    editable,
                  })
                }
              >
                <Save className="mr-2 size-4" />
                Save
              </Button>
              {hasPermission("report:review") ? (
                <Button
                  disabled={review.isPending}
                  onClick={() =>
                    review.mutate({
                      organizationId: activeOrganizationId!,
                      reportId,
                    })
                  }
                >
                  <CheckCircle2 className="mr-2 size-4" />
                  In Review
                </Button>
              ) : null}
            </>
          ) : null}
          {report.status === "in_review" && hasPermission("report:review") ? (
            <Button
              variant="outline"
              onClick={() =>
                returnToDraft.mutate({
                  organizationId: activeOrganizationId!,
                  reportId,
                })
              }
            >
              <Undo2 className="mr-2 size-4" />
              Return to draft
            </Button>
          ) : null}
          {report.status === "in_review" && hasPermission("report:sign") ? (
            <Dialog>
              <DialogTrigger asChild>
                <Button>
                  <ShieldCheck className="mr-2 size-4" />
                  Sign
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Sign Somatic Clinical Report</DialogTitle>
                  <DialogDescription>
                    Signing freezes the template, assertions, assay findings,
                    coverage evidence, provenance, and edited narrative in an
                    immutable snapshot.
                  </DialogDescription>
                </DialogHeader>
                <label className="flex items-start gap-3 rounded-xl border p-4">
                  <Checkbox
                    checked={attestation}
                    onCheckedChange={value => setAttestation(Boolean(value))}
                  />
                  <span className="text-xs leading-5">
                    I reviewed the somatic assertions, assay findings, coverage
                    provenance, source-native evidence, clinical context, and
                    report limitations.
                  </span>
                </label>
                <DialogFooter>
                  <Button
                    disabled={!attestation || sign.isPending}
                    onClick={() =>
                      sign.mutate({
                        organizationId: activeOrganizationId!,
                        reportId,
                        confirmReportId: reportId,
                        attestation: true,
                      })
                    }
                  >
                    Create immutable snapshot and sign
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
          {report.status === "signed" && hasPermission("report:draft") ? (
            <Dialog open={amendOpen} onOpenChange={setAmendOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <PenLine className="mr-2 size-4" />
                  Amend
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Amend signed Somatic Report</DialogTitle>
                  <DialogDescription>
                    The signed version remains immutable. A linked draft version
                    will be created.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label>Amendment reason</Label>
                  <Textarea
                    value={amendReason}
                    onChange={event => setAmendReason(event.target.value)}
                    rows={4}
                  />
                </div>
                <DialogFooter>
                  <Button
                    disabled={amendReason.trim().length < 10 || amend.isPending}
                    onClick={() =>
                      amend.mutate({
                        organizationId: activeOrganizationId!,
                        reportId,
                        reason: amendReason,
                      })
                    }
                  >
                    Create amendment draft
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReportValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[9px] uppercase text-slate-500">{label}</span>
      <strong className="mt-1 block">{value}</strong>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="border-b border-slate-200 pb-2 text-xs font-bold uppercase tracking-[.16em] text-slate-700">
      {children}
    </h2>
  );
}

function EditableSection({
  title,
  value,
  editable,
  rows,
  onChange,
}: {
  title: string;
  value: string;
  editable: boolean;
  rows: number;
  onChange: (value: string) => void;
}) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      {editable ? (
        <Textarea
          className="mt-3 border-slate-200 bg-slate-50/50 text-sm leading-7"
          value={value}
          rows={rows}
          onChange={event => onChange(event.target.value)}
        />
      ) : (
        <div className="mt-3 whitespace-pre-wrap text-sm leading-7">{value || "—"}</div>
      )}
    </section>
  );
}

function FindingSection({ title, findings }: { title: string; findings: Finding[] }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      {findings.length ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[9px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="p-3">Tier / Level</th>
                <th className="p-3">Variant</th>
                <th className="p-3">Oncogenicity</th>
                <th className="p-3">Clinical domain</th>
                <th className="p-3">Effect</th>
              </tr>
            </thead>
            <tbody>
              {findings.map(item => (
                <tr key={item.assertionId} className="border-t border-slate-200">
                  <td className="p-3 font-semibold">
                    {item.tier}
                    {item.level ? ` / ${item.level}` : ""}
                  </td>
                  <td className="p-3 font-mono">
                    {item.gene} {item.hgvsP || item.hgvsC}
                  </td>
                  <td className="p-3">{item.oncogenicity}</td>
                  <td className="p-3 capitalize">{item.clinicalDomain}</td>
                  <td className="p-3 capitalize">{item.clinicalEffect || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No approved findings in this section.</p>
      )}
    </section>
  );
}

function AssayFindingSection({ findings }: { findings: AssayFinding[] }) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 text-[9px] uppercase tracking-wider text-slate-500">
          <tr>
            <th className="p-3">Assay</th>
            <th className="p-3">Status</th>
            <th className="p-3">Result</th>
            <th className="p-3">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {findings.map(finding => (
            <tr key={finding.id} className="border-t border-slate-200">
              <td className="p-3 font-semibold">{finding.findingType}</td>
              <td className="p-3 capitalize">
                {finding.status.replaceAll("_", " ")}
              </td>
              <td className="p-3">
                {finding.result
                  ? Object.entries(finding.result)
                      .filter(([key]) => key !== "type")
                      .map(([key, value]) => `${key}: ${String(value)}`)
                      .join(" · ")
                  : "—"}
              </td>
              <td className="p-3">
                {finding.coverageSummaryId
                  ? `Validated summary #${finding.coverageSummaryId}`
                  : "Not required"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UploadProgress } from "@/components/UploadProgress";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  CheckCircle2,
  FileUp,
  Info,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  CaseVcfFilters,
  GeneListField,
  defaultVcfFilters,
  vcfFiltersPayload,
  type CaseVcfFilterValues,
} from "./CaseVcfFilters";
import { HpoTermField } from "./HpoTermField";
import { GermlineOrderFields } from "./GermlineOrderFields";
import {
  defaultGermlineOrder,
  germlineOrderMissing,
  type GermlineOrderInput,
} from "@shared/germlineOrder";
import { detectReferenceBuild } from "@shared/vcfAssembly";
import { readVcfHeader } from "@/lib/readVcfHeader";
import { putFileWithProgress } from "@/lib/uploadFile";

type FormState = {
  projectId: string;
  caseNumber: string;
  patientAlias: string;
  purpose: "germline" | "somatic";
  inputType: "vcf";
  referenceBuild: "" | "GRCh37" | "GRCh38";
  panelName: string;
  indication: string;
  phenotypeText: string;
  sampleCode: string;
  specimenType: string;
  tumorContentPercent: string;
  tumorTypeId: string;
  tumorCode: string;
  tumorLabel: string;
  primarySite: string;
  histology: string;
  diseaseStatus: string;
  specimenCollectionSite: string;
  panelManufacturer: string;
  panelVersionId: string;
  panelVersion: string;
  pairedNormal: boolean;
  consentClinicalAnalysis: boolean;
  consentSecondaryFindings: boolean;
  consentDataUse: boolean;
};

async function sha256(file: File) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer()
  );
  return Array.from(new Uint8Array(digest))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

export default function NewCasePage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const projects = trpc.projects.list.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId) }
  );
  const somaticCatalog = trpc.cases.somaticCatalog.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId) }
  );
  const [form, setForm] = useState<FormState>({
    projectId: "",
    caseNumber: `GVI-${new Date().getFullYear()}-`,
    patientAlias: "",
    purpose: "germline",
    inputType: "vcf",
    referenceBuild: "",
    panelName: "",
    indication: "",
    phenotypeText: "",
    sampleCode: "",
    specimenType: "Blood",
    tumorContentPercent: "",
    tumorTypeId: "",
    tumorCode: "",
    tumorLabel: "",
    primarySite: "",
    histology: "",
    diseaseStatus: "",
    specimenCollectionSite: "",
    panelManufacturer: "",
    panelVersionId: "",
    panelVersion: "",
    pairedNormal: false,
    consentClinicalAnalysis: false,
    consentSecondaryFindings: false,
    consentDataUse: false,
  });
  const [vcf, setVcf] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState("Submitting");
  const [submissionError, setSubmissionError] = useState("");
  const [filters, setFilters] =
    useState<CaseVcfFilterValues>(defaultVcfFilters);
  const [createdCaseId, setCreatedCaseId] = useState<number | null>(null);
  const [savedPanelId, setSavedPanelId] = useState("");
  const [bedPanelName, setBedPanelName] = useState("");
  const [bedText, setBedText] = useState("");
  const [bedFileName, setBedFileName] = useState("");
  const [order, setOrder] = useState<GermlineOrderInput>(defaultGermlineOrder);
  const [assemblyNote, setAssemblyNote] = useState("");
  const [assemblyFromHeader, setAssemblyFromHeader] = useState(false);
  const assemblyRequest = useRef(0);
  const germlinePanels = trpc.germlinePanels.list.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId) }
  );
  const createCase = trpc.cases.create.useMutation();
  const requestUpload = trpc.cases.requestUpload.useMutation();
  const completeUpload = trpc.cases.completeUpload.useMutation();
  const submit = trpc.cases.submit.useMutation();
  const busy =
    createCase.isPending ||
    requestUpload.isPending ||
    completeUpload.isPending ||
    submit.isPending;
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(current => ({ ...current, [key]: value }));
  const upload = async (
    caseId: number,
    file: File,
    kind: "vcf",
    sampleId?: number
  ) => {
    setUploadLabel("Preparing upload");
    const ticket = await requestUpload.mutateAsync({
      organizationId: activeOrganizationId!,
      caseId,
      sampleId,
      kind,
      fileName: file.name,
    });
    setUploadLabel("Reading the file");
    const digest = await sha256(file);
    setUploadLabel(`Uploading ${file.name}`);
    setProgress(10);
    await putFileWithProgress(ticket.uploadUrl, file, (loaded, total) => {
      setProgress(total > 0 ? 10 + (loaded / total) * 75 : 10);
    });
    setUploadLabel("Saving the file");
    setProgress(88);
    await completeUpload.mutateAsync({
      organizationId: activeOrganizationId!,
      caseId,
      sampleId,
      kind,
      fileName: file.name,
      storageKey: ticket.key,
      accessUrl: ticket.accessUrl,
      mimeType: file.type || "application/octet-stream",
      byteSize: file.size,
      sha256: digest,
    });
  };
  const handleSubmit = async () => {
    if (
      !activeOrganizationId ||
      !form.projectId ||
      !form.consentClinicalAnalysis ||
      !form.referenceBuild
    )
      return;
    try {
      setSubmissionError("");
      setUploadLabel("Saving the case");
      setProgress(8);
      const created = await createCase.mutateAsync({
        organizationId: activeOrganizationId,
        projectId: Number(form.projectId),
        caseNumber: form.caseNumber,
        patientAlias:
          form.patientAlias.trim() ||
          (form.purpose === "germline" ? order.patientName.trim() : "") ||
          form.caseNumber.trim(),
        purpose: form.purpose,
        inputType: form.inputType,
        referenceBuild: form.referenceBuild,
        panelName: form.panelName || undefined,
        indication: form.indication || undefined,
        phenotypeText: form.phenotypeText || undefined,
        somaticContext:
          form.purpose === "somatic"
            ? {
                tumorTypeId: form.tumorTypeId
                  ? Number(form.tumorTypeId)
                  : undefined,
                panelVersionId: form.panelVersionId
                  ? Number(form.panelVersionId)
                  : undefined,
                tumor: {
                  ontologySystem: "Internal",
                  ontologyVersion: "1",
                  code: form.tumorCode,
                  label: form.tumorLabel,
                  primarySite: form.primarySite,
                  histology: form.histology || undefined,
                },
                panel: {
                  manufacturer: form.panelManufacturer,
                  name: form.panelName,
                  version: form.panelVersion,
                  assayType: "Targeted DNA panel",
                },
                histologyText: form.histology || undefined,
                diseaseStatus: form.diseaseStatus || undefined,
                specimenCollectionSite: form.specimenCollectionSite,
                pairedNormal: form.pairedNormal,
              }
            : undefined,
        consentClinicalAnalysis: true,
        consentSecondaryFindings: form.consentSecondaryFindings,
        consentDataUse: form.consentDataUse,
        samples: [
          {
            sampleCode: form.caseNumber.trim(),
            role: form.purpose === "somatic" ? "tumor" : "proband",
            specimenType: form.specimenType,
            tumorContentPercent:
              form.purpose === "somatic" && form.tumorContentPercent
                ? Number(form.tumorContentPercent)
                : undefined,
          },
        ],
        germlinePanel:
          form.purpose === "germline" && savedPanelId
            ? { panelId: Number(savedPanelId) }
            : form.purpose === "germline" && bedText
              ? {
                  bedText,
                  name: bedPanelName || form.panelName || bedFileName || "BED panel",
                }
              : undefined,
        germlineOrder:
          form.purpose === "germline"
            ? {
                ...order,
                patientName: order.patientName || form.patientAlias,
                clinicalInformation: order.clinicalInformation || form.indication,
              }
            : undefined,
      });
      setCreatedCaseId(created.id);
      const sampleId = created.sampleIds[0];
      if (vcf) await upload(created.id, vcf, "vcf", sampleId);
      setUploadLabel("Submitting");
      setProgress(92);
      await submit.mutateAsync({
        organizationId: activeOrganizationId,
        caseId: created.id,
        vcfFilters:
          form.inputType === "vcf" && form.purpose === "germline"
            ? vcfFiltersPayload(filters, form.phenotypeText)
            : undefined,
      });
      setProgress(100);
      toast.success("Analysis request submitted.");
      navigate(`/cases/${created.id}`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "An error occurred while submitting the analysis request.";
      setSubmissionError(message);
      setProgress(0);
      toast.error(message);
    }
  };
  const missing = [
    !form.projectId ? "Project" : "",
    form.caseNumber.trim().length < 2 ? "Case number" : "",
    !form.referenceBuild ? "Reference build" : "",
    !vcf ? "VCF" : "",
    ...(form.purpose === "somatic"
      ? [
          !form.tumorCode.trim() ? "Tumor code" : "",
          !form.tumorLabel.trim() ? "Primary tumor type" : "",
          !form.primarySite.trim() ? "Primary site" : "",
          !form.specimenCollectionSite.trim() ? "Specimen collection site" : "",
          !form.panelManufacturer.trim() ? "Panel manufacturer" : "",
          !form.panelName.trim() ? "Target panel" : "",
          !form.panelVersion.trim() ? "Panel version" : "",
        ]
      : germlineOrderMissing(order)),
    !form.consentClinicalAnalysis ? "Clinical analysis consent" : "",
  ].filter(Boolean);
  const valid = missing.length === 0;
  if (!hasPermission("case:create"))
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="New analysis request"
          title="New case"
          description="Submit a new case with structured test purpose and consent scope."
        />
        <StatePanel
          type="forbidden"
          title="You do not have permission to create cases"
          description="Ask your organization administrator for a role that includes the case:create action."
          action={
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Cases
            </Button>
          }
        />
      </div>
    );
  if (projects.isError)
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="New analysis request"
          title="New case"
          description="Unable to verify the organization project scope."
        />
        <StatePanel
          type="error"
          title="Failed to load projects"
          description={projects.error.message}
          onRetry={() => {
            void projects.refetch();
          }}
          action={
            <Button variant="outline" onClick={() => navigate("/cases")}>
              <ArrowLeft className="mr-2 size-4" />
              Cases
            </Button>
          }
        />
      </div>
    );
  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <PageHeader
        eyebrow="New analysis request"
        title="New case"
        description="Structure the test purpose and consent scope, then upload original files directly to the organization- and case-scoped storage path."
        actions={
          <Button variant="ghost" onClick={() => navigate("/cases")}>
            <ArrowLeft className="mr-2 size-4" />
            Cases
          </Button>
        }
      />
      <Alert className="border-primary/30 bg-primary/10 text-foreground">
        <ShieldCheck className="size-4 text-primary" />
        <AlertTitle>Tenant-isolated upload</AlertTitle>
        <AlertDescription className="text-muted-foreground">
          Files are uploaded directly to the S3 path scoped to the current
          organization and case — bypassing the web server — and a SHA-256
          checksum is recorded.
        </AlertDescription>
      </Alert>
      {!projects.isLoading && !projects.data?.length ? (
        <StatePanel
          compact
          type="empty"
          title="Create a project first"
          description="Cases must belong to an internal project boundary. Create a project on the Dashboard, then come back to submit."
          action={
            <Button variant="outline" onClick={() => navigate("/")}>
              Go to Dashboard
            </Button>
          }
        />
      ) : null}
      {submissionError ? (
        <StatePanel
          compact
          type="error"
          title="Failed to complete analysis request"
          description={submissionError}
          onRetry={() => {
            void handleSubmit();
          }}
          action={
            createdCaseId ? (
              <Button
                variant="outline"
                onClick={() => navigate(`/cases/${createdCaseId}`)}
              >
                Open draft case
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="font-display text-base">
            1. Test &amp; case
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label>
              Project
              <span className="text-destructive"> *</span>
            </Label>
            <select
              value={form.projectId}
              onChange={e => update("projectId", e.target.value)}
              className={`h-10 w-full rounded-lg border bg-background px-3 text-sm ${form.projectId ? "border-input" : "border-destructive"}`}
            >
              <option value="">Select project</option>
              {projects.data?.map(project => (
                <option key={project.id} value={project.id}>
                  {project.code} · {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Case number" required invalid={form.caseNumber.trim().length < 2}>
              <Input
                value={form.caseNumber}
                onChange={e => update("caseNumber", e.target.value)}
              />
            </Field>
            <Field label="Patient alias">
              <Input
                value={form.patientAlias}
                onChange={e => update("patientAlias", e.target.value)}
                placeholder="Optional. Defaults to the patient name or case number"
              />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Test purpose">
              <select
                value={form.purpose}
                onChange={e => {
                  const purpose = e.target.value as FormState["purpose"];
                  setSavedPanelId("");
                  setBedText("");
                  setBedFileName("");
                  setBedPanelName("");
                  setForm(current => ({
                    ...current,
                    purpose,
                    inputType: "vcf",
                    panelName: "",
                    specimenType:
                      purpose === "somatic" ? "Tumor tissue" : "Blood",
                  }));
                }}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="germline">Germline</option>
                <option value="somatic">Somatic</option>
              </select>
            </Field>
            <Field label="Input type">
              <Input value="VCF" readOnly />
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                Interpretation starts from an uploaded VCF. FASTQ sequencing,
                BAM alignment, and IGV are not part of this workflow.
              </p>
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Reference build" required invalid={!form.referenceBuild}>
              <select
                value={form.referenceBuild}
                onChange={e => {
                  update(
                    "referenceBuild",
                    e.target.value as FormState["referenceBuild"]
                  );
                  setAssemblyFromHeader(false);
                  setAssemblyNote("");
                }}
                className={`h-10 w-full rounded-lg border px-3 text-sm ${
                  assemblyFromHeader
                    ? "border-emerald-500 bg-emerald-50 text-emerald-950"
                    : form.referenceBuild
                      ? "border-input bg-background"
                      : "border-destructive bg-background"
                }`}
              >
                <option value="">Select reference build</option>
                <option value="GRCh38">GRCh38 (hg38)</option>
                <option value="GRCh37">GRCh37 (hg19)</option>
              </select>
              {form.referenceBuild === "GRCh37" ? (
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  Submitted GRCh37 coordinates are lifted to GRCh38 before
                  engine analysis. Alleles stay on the original build.
                </p>
              ) : null}
              {assemblyFromHeader ? (
                <p className="mt-1 text-[10px] leading-4 text-emerald-800">
                  {assemblyNote || "Filled from the VCF header."}
                </p>
              ) : assemblyNote ? (
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  {assemblyNote}
                </p>
              ) : null}
            </Field>
            {form.purpose === "germline" ? (
              <>
                <Field label="Assay">
                  <Input
                    value={form.panelName}
                    onChange={e => update("panelName", e.target.value)}
                    placeholder="WES"
                  />
                </Field>
                <Field label="Interpretation panel">
                  <select
                    value={savedPanelId}
                    onChange={event => {
                      const id = event.target.value;
                      setSavedPanelId(id);
                      if (id) {
                        setBedText("");
                        setBedFileName("");
                        const selected = germlinePanels.data?.find(
                          panel => panel.id === Number(id)
                        );
                        if (selected) update("panelName", selected.name);
                      }
                    }}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Whole VCF, no saved panel</option>
                    {germlinePanels.data
                      ?.filter(
                        panel =>
                          !panel.genomeBuild ||
                          panel.genomeBuild === form.referenceBuild
                      )
                      .map(panel => (
                        <option key={panel.id} value={panel.id}>
                          {panel.name} · {panel.geneCount.toLocaleString()} genes
                          {panel.regionCount
                            ? ` · ${panel.regionCount.toLocaleString()} intervals`
                            : ""}
                        </option>
                      ))}
                  </select>
                  <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                    A saved panel is copied onto this case. Later edits to the catalog do not change cases already created.
                  </p>
                </Field>
                <Field label="Or attach a BED for this case">
                  <Input
                    type="file"
                    accept=".bed,.txt"
                    disabled={Boolean(savedPanelId)}
                    onChange={async event => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      const text = await file.text();
                      if (text.length > 20_000_000) {
                        toast.error("That BED is larger than 20 MB.");
                        return;
                      }
                      setSavedPanelId("");
                      setBedText(text);
                      setBedFileName(file.name);
                      if (!bedPanelName) {
                        setBedPanelName(file.name.replace(/\.(bed|txt)$/i, ""));
                      }
                    }}
                  />
                  {bedText ? (
                    <div className="mt-2 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {bedFileName} · {bedText.length.toLocaleString()} characters
                      </p>
                      <Input
                        value={bedPanelName}
                        onChange={event => setBedPanelName(event.target.value)}
                        placeholder="Panel name for this case"
                      />
                    </div>
                  ) : null}
                </Field>
              </>
            ) : null}
          </div>
          <Field label="Clinical indication">
            <Textarea
              value={form.indication}
              onChange={e => update("indication", e.target.value)}
              placeholder="Clinical indication and key question"
            />
          </Field>
          {form.purpose === "germline" ? (
            <>
              <Field label="HPO terms">
                <HpoTermField
                  value={form.phenotypeText}
                  onChange={value => update("phenotypeText", value)}
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  Start typing and pick the closest term. A chosen name also
                  includes more specific terms that contain that word.
                </p>
              </Field>
              <GeneListField
                organizationId={activeOrganizationId || 0}
                values={filters}
                onChange={setFilters}
                hpo={form.phenotypeText}
              />
            </>
          ) : (
            <div className="space-y-6 rounded-xl border border-border/70 bg-muted/20 p-5">
              <div>
                <h3 className="text-sm font-semibold">Somatic tumor context</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Primary tumor and specimen site are separate. This context is
                  required for cancer-specific evidence matching.
                </p>
              </div>
              <Field label="Versioned tumor catalog">
                <select
                  value={form.tumorTypeId}
                  onChange={event => {
                    const id = event.target.value;
                    const selected = somaticCatalog.data?.tumors.find(
                      item => item.id === Number(id)
                    );
                    setForm(current => ({
                      ...current,
                      tumorTypeId: id,
                      tumorCode: selected?.code ?? "",
                      tumorLabel: selected?.label ?? "",
                      primarySite: selected?.primarySite ?? "",
                      histology: selected?.histology ?? current.histology,
                    }));
                  }}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="">Manual concept (requires review)</option>
                  {somaticCatalog.data?.tumors.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {item.ontologySystem}{" "}
                      {item.ontologyVersion} · {item.code}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Tumor code" required invalid={!form.tumorCode.trim()}>
                  <Input
                    disabled={Boolean(form.tumorTypeId)}
                    value={form.tumorCode}
                    onChange={e =>
                      setForm(current => ({
                        ...current,
                        tumorTypeId: "",
                        tumorCode: e.target.value,
                      }))
                    }
                    placeholder="e.g. NSCLC"
                  />
                </Field>
                <Field label="Primary tumor type" required invalid={!form.tumorLabel.trim()}>
                  <Input
                    disabled={Boolean(form.tumorTypeId)}
                    value={form.tumorLabel}
                    onChange={e =>
                      setForm(current => ({
                        ...current,
                        tumorTypeId: "",
                        tumorLabel: e.target.value,
                      }))
                    }
                    placeholder="Non-Small Cell Lung Cancer"
                  />
                </Field>
                <Field label="Primary site" required invalid={!form.primarySite.trim()}>
                  <Input
                    disabled={Boolean(form.tumorTypeId)}
                    value={form.primarySite}
                    onChange={e => update("primarySite", e.target.value)}
                    placeholder="Lung"
                  />
                </Field>
                <Field label="Histology / subtype">
                  <Input
                    value={form.histology}
                    onChange={e => update("histology", e.target.value)}
                    placeholder="Adenocarcinoma"
                  />
                </Field>
                <Field label="Disease status">
                  <Input
                    value={form.diseaseStatus}
                    onChange={e => update("diseaseStatus", e.target.value)}
                    placeholder="Primary, recurrent, or metastatic"
                  />
                </Field>
                <Field label="Specimen collection site" required invalid={!form.specimenCollectionSite.trim()}>
                  <Input
                    value={form.specimenCollectionSite}
                    onChange={e =>
                      update("specimenCollectionSite", e.target.value)
                    }
                    placeholder="Lung, liver metastasis, blood…"
                  />
                </Field>
                <Field label="Specimen type">
                  <Input
                    value={form.specimenType}
                    onChange={e => update("specimenType", e.target.value)}
                    placeholder="FFPE tumor tissue"
                  />
                </Field>
                <Field label="Tumor content (%)">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={form.tumorContentPercent}
                    onChange={e =>
                      update("tumorContentPercent", e.target.value)
                    }
                  />
                </Field>
              </div>
              <Field label="Organization panel catalog">
                <select
                  value={form.panelVersionId}
                  onChange={event => {
                    const id = event.target.value;
                    const selected = somaticCatalog.data?.panelVersions.find(
                      item => item.version.id === Number(id)
                    );
                    setForm(current => ({
                      ...current,
                      panelVersionId: id,
                      panelManufacturer: selected?.panel.manufacturer ?? "",
                      panelName: selected?.panel.name ?? "",
                      panelVersion: selected?.version.version ?? "",
                      referenceBuild:
                        selected?.version.genomeBuild ?? current.referenceBuild,
                    }));
                    if (selected?.version.genomeBuild) {
                      setAssemblyFromHeader(false);
                      setAssemblyNote("");
                    }
                  }}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                >
                  <option value="">Create a new panel version</option>
                  {somaticCatalog.data?.panelVersions.map(item => (
                    <option key={item.version.id} value={item.version.id}>
                      {item.panel.manufacturer} {item.panel.name} ·{" "}
                      {item.version.version} · {item.version.genomeBuild}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid gap-5 sm:grid-cols-3">
                <Field label="Panel manufacturer" required invalid={!form.panelManufacturer.trim()}>
                  <Input
                    disabled={Boolean(form.panelVersionId)}
                    value={form.panelManufacturer}
                    onChange={e =>
                      setForm(current => ({
                        ...current,
                        panelVersionId: "",
                        panelManufacturer: e.target.value,
                      }))
                    }
                    placeholder="Roche, Illumina…"
                  />
                </Field>
                <Field label="Target panel" required invalid={!form.panelName.trim()}>
                  <Input
                    disabled={Boolean(form.panelVersionId)}
                    value={form.panelName}
                    onChange={e =>
                      setForm(current => ({
                        ...current,
                        panelVersionId: "",
                        panelName: e.target.value,
                      }))
                    }
                    placeholder="Panel name"
                  />
                </Field>
                <Field label="Panel version" required invalid={!form.panelVersion.trim()}>
                  <Input
                    disabled={Boolean(form.panelVersionId)}
                    value={form.panelVersion}
                    onChange={e =>
                      setForm(current => ({
                        ...current,
                        panelVersionId: "",
                        panelVersion: e.target.value,
                      }))
                    }
                    placeholder="Version"
                  />
                </Field>
              </div>
              <label className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={form.pairedNormal}
                  onCheckedChange={value =>
                    update("pairedNormal", Boolean(value))
                  }
                />
                Paired normal sample is available
              </label>
            </div>
          )}
          {form.purpose === "germline" ? (
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Order details</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Hospital, patient, and report fields for this germline order. They are shown on the case page.
                </p>
              </div>
              <GermlineOrderFields value={order} onChange={setOrder} />
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="font-display text-base">
            2. VCF and filters
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          <FileInput
            label="VCF or VCF.GZ"
            required
            invalid={!vcf}
            accept=".vcf,.vcf.gz"
            file={vcf}
            onChange={file => {
              const request = ++assemblyRequest.current;
              setVcf(file);
              if (!file) {
                if (assemblyFromHeader) {
                  update("referenceBuild", "");
                  setAssemblyFromHeader(false);
                }
                setAssemblyNote("");
                return;
              }
              void readVcfHeader(file)
                .then(header => {
                  if (assemblyRequest.current !== request) return;
                  const detected = detectReferenceBuild(header);
                  if (!detected) {
                    setAssemblyFromHeader(false);
                    setAssemblyNote(
                      "The VCF header does not say whether this is hg38 or hg19. Choose the reference build."
                    );
                    return;
                  }
                  update("referenceBuild", detected.build);
                  setAssemblyFromHeader(true);
                  setAssemblyNote(
                    detected.build === "GRCh38"
                      ? "Filled from the VCF header: GRCh38 (hg38)."
                      : "Filled from the VCF header: GRCh37 (hg19)."
                  );
                })
                .catch(() => {
                  if (assemblyRequest.current !== request) return;
                  setAssemblyFromHeader(false);
                  setAssemblyNote(
                    "The VCF header could not be read. Choose the reference build."
                  );
                });
            }}
          />
          {activeOrganizationId && form.purpose === "germline" && form.referenceBuild ? (
            <CaseVcfFilters
              organizationId={activeOrganizationId}
              referenceBuild={form.referenceBuild}
              file={vcf}
              hpo={form.phenotypeText}
              values={filters}
              onChange={setFilters}
              panelScope={
                savedPanelId
                  ? { panelId: Number(savedPanelId) }
                  : bedText
                    ? { bedText }
                    : null
              }
            />
          ) : null}
        </CardContent>
      </Card>
      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="font-display text-base">
            3. Consent &amp; submit
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            [
              "consentClinicalAnalysis",
              "Clinical analysis consent",
              "Consent to perform the requested genomic analysis and expert interpretation",
            ],
            [
              "consentSecondaryFindings",
              "Secondary findings",
              "Consent to review secondary findings per applicable policy",
            ],
            [
              "consentDataUse",
              "Research & quality use",
              "Consent to use de-identified data for research and quality improvement",
            ],
          ].map(([key, title, desc]) => (
            <label
              key={key}
              className={`flex items-start gap-3 rounded-xl border p-4 ${
                key === "consentClinicalAnalysis" && !form.consentClinicalAnalysis
                  ? "border-destructive"
                  : "border-border/70"
              }`}
            >
              <Checkbox
                checked={form[key as keyof FormState] as boolean}
                onCheckedChange={value =>
                  update(key as keyof FormState, Boolean(value) as never)
                }
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">
                  {title}
                  {key === "consentClinicalAnalysis" ? (
                    <span className="ml-1 text-destructive">*</span>
                  ) : null}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {desc}
                </span>
              </span>
            </label>
          ))}
          {busy || progress > 0 ? (
            <UploadProgress label={uploadLabel} percent={progress} />
          ) : null}
          {missing.length ? (
            <p className="text-sm text-destructive">
              Fill these to submit: {missing.join(", ")}.
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-3 border-t border-border/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              After submission, original files and consent scope are managed as
              audit records.
            </div>
            <Button size="lg" disabled={!valid || busy} onClick={handleSubmit}>
              {busy ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 size-4" />
              )}
              {busy ? "Submitting securely…" : "Submit analysis request"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  required,
  invalid,
  children,
}: {
  label: string;
  required?: boolean;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <div
        className={
          invalid
            ? "[&_input]:!border-destructive [&_select]:!border-destructive [&_textarea]:!border-destructive"
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
function FileInput({
  label,
  accept,
  file,
  required,
  invalid,
  onChange,
}: {
  label: string;
  accept: string;
  file: File | null;
  required?: boolean;
  invalid?: boolean;
  onChange: (file: File | null) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-4 rounded-xl border border-dashed p-4 ${
        invalid
          ? "border-destructive"
          : file
            ? "border-primary/40 bg-primary/[0.035]"
            : "border-border hover:border-primary/30"
      }`}
    >
      <div className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
        <FileUp className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {file ? file.name : label}
          {required && !file ? <span className="text-destructive"> *</span> : null}
        </p>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {file
            ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
            : "Click to select file"}
        </p>
      </div>
      {file ? <CheckCircle2 className="size-4 text-emerald-600" /> : null}
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={event => onChange(event.target.files?.[0] || null)}
      />
    </label>
  );
}

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { CheckCircle2, FileUp, Loader2, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type FindingType = "CNV" | "FUSION" | "MSI" | "TMB" | "HRD";
type FindingStatus =
  | "detected"
  | "not_detected"
  | "not_tested"
  | "indeterminate";

const RESULT_EXAMPLES: Record<FindingType, string> = {
  CNV: '{"type":"CNV","gene":"ERBB2","copyNumber":8,"call":"amplification"}',
  FUSION:
    '{"type":"FUSION","fivePrimeGene":"EML4","threePrimeGene":"ALK","inFrame":true,"supportingReads":42}',
  MSI: '{"type":"MSI","score":20.4,"category":"high"}',
  TMB: '{"type":"TMB","mutationsPerMb":14.2,"category":"high"}',
  HRD: '{"type":"HRD","score":48,"category":"positive","method":"Validated assay"}',
};

export function SomaticAssayReview({
  caseId,
  panelVersion,
  onPanelRefresh,
}: {
  caseId: number;
  panelVersion: {
    id: number;
    capabilities: {
      snvIndel: boolean;
      cnv: boolean;
      fusion: boolean;
      msi: boolean;
      tmb: boolean;
      hrd: boolean;
    };
    regionArtifactName: string | null;
    regionArtifactHash: string | null;
    regionValidationStatus: "pending" | "passed" | "failed";
  };
  onPanelRefresh: () => Promise<unknown>;
}) {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const organizationId = activeOrganizationId || 0;
  const canEdit = hasPermission("interpretation:edit");
  const canApprove = hasPermission("interpretation:approve");
  const [artifactName, setArtifactName] = useState("");
  const [bedFile, setBedFile] = useState<File | null>(null);
  const [defaultMinimumDepth, setDefaultMinimumDepth] = useState("250");
  const [defaultMinimumCoverage, setDefaultMinimumCoverage] = useState("95");
  const [regionHash, setRegionHash] = useState("");
  const [regionJson, setRegionJson] = useState("");
  const [coverageHash, setCoverageHash] = useState("");
  const [coverageFile, setCoverageFile] = useState<File | null>(null);
  const [coverageJson, setCoverageJson] = useState("");
  const [findingType, setFindingType] = useState<FindingType>("CNV");
  const [findingStatus, setFindingStatus] =
    useState<FindingStatus>("detected");
  const [findingResult, setFindingResult] = useState(RESULT_EXAMPLES.CNV);
  const [coverageSummaryId, setCoverageSummaryId] = useState("");
  const [assayFile, setAssayFile] = useState<File | null>(null);
  const [lastAssayArtifactFileId, setLastAssayArtifactFileId] = useState<
    number | null
  >(null);
  const [assayChangeControlId, setAssayChangeControlId] = useState("");

  const regions = trpc.somaticFoundation.listPanelRegions.useQuery(
    { organizationId, panelVersionId: panelVersion.id },
    { enabled: Boolean(activeOrganizationId) }
  );
  const coverage = trpc.somaticFoundation.listCaseCoverage.useQuery(
    { organizationId, caseId },
    { enabled: Boolean(activeOrganizationId) }
  );
  const findings = trpc.somaticFoundation.listAssayFindings.useQuery(
    { organizationId, caseId },
    { enabled: Boolean(activeOrganizationId) }
  );
  const assayImpact =
    trpc.somaticFoundation.previewAssayArtifactImpact.useQuery(
      {
        organizationId,
        caseId,
        targetArtifactFileId: lastAssayArtifactFileId || 0,
      },
      { enabled: Boolean(activeOrganizationId && lastAssayArtifactFileId) }
    );
  const latestCoverage = coverage.data?.summaries[0] ?? null;

  const stagePanelBed =
    trpc.somaticFoundation.stagePanelBedArtifact.useMutation({
      onError: error => toast.error(error.message),
    });
  const stageCoverage =
    trpc.somaticFoundation.stageCoverageArtifact.useMutation({
      onError: error => toast.error(error.message),
    });
  const importRegions =
    trpc.somaticFoundation.importPanelRegions.useMutation({
      onSuccess: async result => {
        await Promise.all([regions.refetch(), onPanelRefresh()]);
        toast.success(
          `${result.reportableRegionCount} reportable panel regions imported.`
        );
      },
      onError: error => toast.error(error.message),
    });
  const validateRegions =
    trpc.somaticFoundation.validatePanelRegions.useMutation({
      onSuccess: async () => {
        await onPanelRefresh();
        toast.success("Panel region artifact approved.");
      },
      onError: error => toast.error(error.message),
    });
  const importCoverage =
    trpc.somaticFoundation.importCaseCoverage.useMutation({
      onSuccess: async result => {
        await coverage.refetch();
        toast.success(
          `${result.importedRegionCount} coverage records imported; ${result.failedRegionCount} failed QC.`
        );
      },
      onError: error => toast.error(error.message),
    });
  const validateCoverage =
    trpc.somaticFoundation.validateCoverageSummary.useMutation({
      onSuccess: async result => {
        await coverage.refetch();
        toast.success(
          result.validation.passed
            ? "Coverage artifact approved."
            : "Coverage validation failed; negative reporting remains blocked."
        );
      },
      onError: error => toast.error(error.message),
    });
  const createFinding = trpc.somaticFoundation.createAssayFinding.useMutation({
    onSuccess: async () => {
      await findings.refetch();
      toast.success("Assay finding created for expert review.");
    },
    onError: error => toast.error(error.message),
  });
  const stageAssayArtifact =
    trpc.somaticFoundation.stageAssayArtifact.useMutation({
      onError: error => toast.error(error.message),
    });
  const importAssayFindings =
    trpc.somaticFoundation.importAssayFindings.useMutation({
      onSuccess: async result => {
        setAssayFile(null);
        await findings.refetch();
        toast.success(
          `${result.importedRecordCount} assay finding(s) imported for expert review.`
        );
      },
      onError: error => toast.error(error.message),
    });
  const reviewFinding = trpc.somaticFoundation.reviewAssayFinding.useMutation({
    onSuccess: async result => {
      await findings.refetch();
      toast.success(
        result.finding.reportable
          ? "Assay finding approved for reporting."
          : "Assay finding marked not reportable."
      );
    },
    onError: error => toast.error(error.message),
  });
  const createAssayImpactTask =
    trpc.somaticFoundation.createAssayArtifactImpactTask.useMutation({
      onSuccess: result => {
        toast.success(
          result.createdTaskCount
            ? "Assay change impact task created."
            : "No previously reportable findings require reinterpretation."
        );
      },
      onError: error => toast.error(error.message),
    });

  const enabledFindingTypes = useMemo(
    () =>
      ([
        ["CNV", panelVersion.capabilities.cnv],
        ["FUSION", panelVersion.capabilities.fusion],
        ["MSI", panelVersion.capabilities.msi],
        ["TMB", panelVersion.capabilities.tmb],
        ["HRD", panelVersion.capabilities.hrd],
      ] as const).filter(([, enabled]) => enabled),
    [panelVersion.capabilities]
  );
  useEffect(() => {
    const firstEnabled = enabledFindingTypes[0]?.[0];
    if (
      firstEnabled &&
      !enabledFindingTypes.some(([value]) => value === findingType)
    ) {
      setFindingType(firstEnabled);
      setFindingResult(RESULT_EXAMPLES[firstEnabled]);
    }
  }, [enabledFindingTypes, findingType]);

  const parseArray = (value: string, label: string) => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) throw new Error(`${label} must be an array.`);
      return parsed;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `${label} JSON is invalid.`
      );
      return null;
    }
  };

  return (
    <Card className="clinical-card shadow-none">
      <CardHeader>
        <CardTitle className="text-base">
          Panel coverage and validated assay findings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            panel regions {panelVersion.regionValidationStatus}
          </Badge>
          <Badge variant="outline">
            {regions.data?.filter(region => region.reportable).length ?? 0}{" "}
            reportable regions
          </Badge>
          <Badge variant="outline">
            coverage {latestCoverage?.validationStatus ?? "not imported"}
          </Badge>
          <Badge variant="outline">
            {findings.data?.length ?? 0} assay findings
          </Badge>
        </div>

        {regions.isError || coverage.isError || findings.isError ? (
          <div role="alert" className="rounded-xl border border-red-300 p-4">
            <p className="text-sm text-red-800">
              Panel or assay data could not be loaded. Retry before clinical
              review.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() =>
                void Promise.all([
                  regions.refetch(),
                  coverage.refetch(),
                  findings.refetch(),
                ])
              }
            >
              Retry
            </Button>
          </div>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-2">
          <section className="space-y-4 rounded-xl border p-4">
            <div>
              <h3 className="font-semibold">Reportable-region artifact</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {panelVersion.regionArtifactName || "No artifact imported"} ·{" "}
                {panelVersion.regionArtifactHash || "hash unavailable"}
              </p>
            </div>
            {canEdit && panelVersion.regionValidationStatus !== "passed" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="BED4 file">
                    <Input
                      type="file"
                      accept=".bed,text/plain,text/tab-separated-values"
                      onChange={event =>
                        setBedFile(event.target.files?.[0] ?? null)
                      }
                    />
                  </Field>
                  <Field label="Default minimum depth">
                    <Input
                      type="number"
                      min={0}
                      value={defaultMinimumDepth}
                      onChange={event =>
                        setDefaultMinimumDepth(event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Default covered %">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={defaultMinimumCoverage}
                      onChange={event =>
                        setDefaultMinimumCoverage(event.target.value)
                      }
                    />
                  </Field>
                </div>
                <Button
                  disabled={
                    !bedFile ||
                    stagePanelBed.isPending ||
                    importRegions.isPending
                  }
                  onClick={async () => {
                    if (!bedFile) return;
                    const artifactText = await bedFile.text();
                    const artifactHash = await hashText(artifactText);
                    const staged = await stagePanelBed.mutateAsync({
                      organizationId,
                      caseId,
                      panelVersionId: panelVersion.id,
                      fileName: bedFile.name,
                      artifactText,
                      artifactHash,
                      minimumDepth: defaultMinimumDepth
                        ? Number(defaultMinimumDepth)
                        : null,
                      minimumCoveragePercent: defaultMinimumCoverage
                        ? Number(defaultMinimumCoverage)
                        : null,
                    });
                    await importRegions.mutateAsync({
                      organizationId,
                      panelVersionId: panelVersion.id,
                      artifactName: staged.file.fileName,
                      artifactHash: staged.file.sha256,
                      regions: staged.regions,
                    });
                    setArtifactName(staged.file.fileName);
                    setRegionHash(staged.file.sha256);
                  }}
                >
                  {stagePanelBed.isPending || importRegions.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <FileUp className="mr-2 size-4" />
                  )}
                  Upload and import BED
                </Button>
                <Field label="Artifact file name">
                  <Input
                    value={artifactName}
                    onChange={event => setArtifactName(event.target.value)}
                    placeholder="panel-v4.regions.json"
                  />
                </Field>
                <Field label="Artifact SHA-256">
                  <Input
                    value={regionHash}
                    onChange={event => setRegionHash(event.target.value)}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="Normalized regions JSON">
                  <Textarea
                    value={regionJson}
                    onChange={event => setRegionJson(event.target.value)}
                    rows={6}
                    className="font-mono text-xs"
                    placeholder='[{"regionKey":"EGFR:exon20","regionType":"exon","gene":"EGFR","chromosome":"7","start":55181378,"end":55181470,"minimumDepth":250,"minimumCoveragePercent":95,"reportable":true}]'
                  />
                </Field>
                <Button
                  variant="outline"
                  disabled={importRegions.isPending}
                  onClick={() => {
                    const parsed = parseArray(regionJson, "Region artifact");
                    if (!parsed) return;
                    importRegions.mutate({
                      organizationId,
                      panelVersionId: panelVersion.id,
                      artifactName,
                      artifactHash: regionHash,
                      regions: parsed as never,
                    });
                  }}
                >
                  {importRegions.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  Import regions
                </Button>
              </>
            ) : null}
            {canApprove &&
            panelVersion.regionValidationStatus === "pending" &&
            panelVersion.regionArtifactHash ? (
              <Button
                disabled={validateRegions.isPending}
                onClick={() =>
                  validateRegions.mutate({
                    organizationId,
                    panelVersionId: panelVersion.id,
                    artifactHash: panelVersion.regionArtifactHash!,
                  })
                }
              >
                <CheckCircle2 className="mr-2 size-4" />
                Approve exact artifact hash
              </Button>
            ) : null}
          </section>

          <section className="space-y-4 rounded-xl border p-4">
            <div>
              <h3 className="font-semibold">Case coverage artifact</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {latestCoverage
                  ? `${latestCoverage.completeRegionCount}/${latestCoverage.expectedRegionCount} complete · ${latestCoverage.sourceArtifactHash || "legacy/manual source"}`
                  : "No coverage artifact imported"}
              </p>
            </div>
            {canEdit && panelVersion.regionValidationStatus === "passed" ? (
              <>
                <Field label="Coverage TSV or JSON file">
                  <Input
                    type="file"
                    accept=".tsv,.txt,.json,text/tab-separated-values,application/json"
                    onChange={event =>
                      setCoverageFile(event.target.files?.[0] ?? null)
                    }
                  />
                </Field>
                <Button
                  variant="outline"
                  disabled={
                    !coverageFile ||
                    stageCoverage.isPending ||
                    importCoverage.isPending ||
                    latestCoverage?.validationStatus === "passed"
                  }
                  onClick={async () => {
                    if (!coverageFile) return;
                    const artifactText = await coverageFile.text();
                    const artifactHash = await hashText(artifactText);
                    const staged = await stageCoverage.mutateAsync({
                      organizationId,
                      caseId,
                      panelVersionId: panelVersion.id,
                      fileName: coverageFile.name,
                      artifactText,
                      artifactHash,
                    });
                    await importCoverage.mutateAsync({
                      organizationId,
                      caseId,
                      panelVersionId: panelVersion.id,
                      artifactHash: staged.file.sha256,
                      qcMetrics: {
                        sourceFileId: staged.file.id,
                        sourceFileName: staged.file.fileName,
                        importedRecordCount: staged.records.length,
                      },
                      records: staged.records,
                    });
                    setCoverageHash(staged.file.sha256);
                  }}
                >
                  {stageCoverage.isPending || importCoverage.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <FileUp className="mr-2 size-4" />
                  )}
                  Upload and import coverage
                </Button>
                <Field label="Coverage artifact SHA-256">
                  <Input
                    value={coverageHash}
                    onChange={event => setCoverageHash(event.target.value)}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="Coverage records JSON">
                  <Textarea
                    value={coverageJson}
                    onChange={event => setCoverageJson(event.target.value)}
                    rows={6}
                    className="font-mono text-xs"
                    placeholder='[{"regionKey":"EGFR:exon20","meanDepth":825,"coveredPercent":100}]'
                  />
                </Field>
                <Button
                  variant="outline"
                  disabled={
                    importCoverage.isPending ||
                    latestCoverage?.validationStatus === "passed"
                  }
                  onClick={() => {
                    const parsed = parseArray(
                      coverageJson,
                      "Coverage artifact"
                    );
                    if (!parsed) return;
                    importCoverage.mutate({
                      organizationId,
                      caseId,
                      panelVersionId: panelVersion.id,
                      artifactHash: coverageHash,
                      qcMetrics: { importedRecordCount: parsed.length },
                      records: parsed as never,
                    });
                  }}
                >
                  {importCoverage.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  Import coverage
                </Button>
              </>
            ) : null}
            {canApprove &&
            latestCoverage?.validationStatus === "pending" &&
            latestCoverage.sourceArtifactHash ? (
              <Button
                disabled={validateCoverage.isPending}
                onClick={() =>
                  validateCoverage.mutate({
                    organizationId,
                    coverageSummaryId: latestCoverage.id,
                    validationArtifactHash:
                      latestCoverage.sourceArtifactHash!,
                  })
                }
              >
                <CheckCircle2 className="mr-2 size-4" />
                Validate coverage
              </Button>
            ) : null}
          </section>
        </div>

        <section className="space-y-4 rounded-xl border p-4">
          <div>
            <h3 className="font-semibold">CNV, fusion and signatures</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Only capabilities declared by panel version {panelVersion.id} are
              available. Every result remains non-reportable until expert
              review.
            </p>
          </div>
          {enabledFindingTypes.length ? (
            <>
              {canEdit ? (
                <div className="space-y-4">
                  <div className="grid gap-3 rounded-lg border border-dashed p-4 md:grid-cols-[1fr_auto] md:items-end">
                    <Field label="Normalized assay JSON/TSV artifact">
                      <Input
                        type="file"
                        accept=".json,.tsv,application/json,text/tab-separated-values"
                        onChange={event =>
                          setAssayFile(event.target.files?.[0] ?? null)
                        }
                      />
                    </Field>
                    <Button
                      variant="outline"
                      disabled={
                        !assayFile ||
                        stageAssayArtifact.isPending ||
                        importAssayFindings.isPending
                      }
                      onClick={async () => {
                        if (!assayFile) return;
                        const artifactText = await assayFile.text();
                        const artifactHash = await hashText(artifactText);
                        const staged = await stageAssayArtifact.mutateAsync({
                          organizationId,
                          caseId,
                          panelVersionId: panelVersion.id,
                          fileName: assayFile.name,
                          artifactText,
                          artifactHash,
                        });
                        await importAssayFindings.mutateAsync({
                          organizationId,
                          caseId,
                          panelVersionId: panelVersion.id,
                          artifactFileId: staged.file.id,
                          records: staged.records,
                        });
                        setLastAssayArtifactFileId(staged.file.id);
                      }}
                    >
                      {stageAssayArtifact.isPending ||
                      importAssayFindings.isPending ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <FileUp className="mr-2 size-4" />
                      )}
                      Upload and import assay results
                    </Button>
                  </div>
                  {lastAssayArtifactFileId ? (
                    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50/60 p-4">
                      {assayImpact.isLoading ? (
                        <p className="text-sm">Checking prior assay findings.</p>
                      ) : assayImpact.isError ? (
                        <p className="text-sm text-destructive">
                          {assayImpact.error.message}
                        </p>
                      ) : assayImpact.data ? (
                        <>
                          <p className="text-sm text-amber-950">
                            This artifact overlaps{" "}
                            {assayImpact.data.supersededFindings.length}{" "}
                            previously reviewed reportable finding(s). Imported
                            findings remain non-reportable until review.
                          </p>
                          {canApprove &&
                          assayImpact.data.supersededFindings.length ? (
                            <div className="flex flex-col gap-2 sm:flex-row">
                              <Input
                                value={assayChangeControlId}
                                onChange={event =>
                                  setAssayChangeControlId(event.target.value)
                                }
                                placeholder="Approved change-control ID"
                              />
                              <Button
                                variant="outline"
                                disabled={
                                  createAssayImpactTask.isPending ||
                                  assayChangeControlId.trim().length < 3
                                }
                                onClick={() =>
                                  createAssayImpactTask.mutate({
                                    organizationId,
                                    caseId,
                                    targetArtifactFileId:
                                      lastAssayArtifactFileId,
                                    expectedChangeHash:
                                      assayImpact.data.changeHash,
                                    changeControlId:
                                      assayChangeControlId.trim(),
                                  })
                                }
                              >
                                Create impact task
                              </Button>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="grid gap-4 md:grid-cols-3">
                  <Field label="Finding type">
                    <select
                      value={findingType}
                      onChange={event => {
                        const value = event.target.value as FindingType;
                        setFindingType(value);
                        setFindingResult(RESULT_EXAMPLES[value]);
                      }}
                      className="h-10 rounded-lg border bg-background px-3 text-sm"
                    >
                      {enabledFindingTypes.map(([value]) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Status">
                    <select
                      value={findingStatus}
                      onChange={event =>
                        setFindingStatus(event.target.value as FindingStatus)
                      }
                      className="h-10 rounded-lg border bg-background px-3 text-sm"
                    >
                      <option value="detected">Detected</option>
                      <option value="not_detected">Not detected</option>
                      <option value="not_tested">Not tested</option>
                      <option value="indeterminate">Indeterminate</option>
                    </select>
                  </Field>
                  <Field label="Coverage record">
                    <select
                      value={coverageSummaryId}
                      onChange={event =>
                        setCoverageSummaryId(event.target.value)
                      }
                      className="h-10 rounded-lg border bg-background px-3 text-sm"
                    >
                      <option value="">None</option>
                      {(coverage.data?.summaries ?? []).map(summary => (
                        <option key={summary.id} value={summary.id}>
                          #{summary.id} · {summary.validationStatus}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="md:col-span-3">
                    <Field label="Typed result JSON">
                      <Textarea
                        value={findingResult}
                        onChange={event => setFindingResult(event.target.value)}
                        rows={4}
                        className="font-mono text-xs"
                        placeholder={RESULT_EXAMPLES[findingType]}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="outline"
                    disabled={createFinding.isPending}
                    onClick={() => {
                      let result: unknown = null;
                      if (
                        findingStatus === "detected" ||
                        (findingStatus === "indeterminate" &&
                          findingResult.trim())
                      ) {
                        try {
                          result = JSON.parse(findingResult);
                        } catch {
                          toast.error("Typed finding JSON is invalid.");
                          return;
                        }
                      }
                      createFinding.mutate({
                        organizationId,
                        caseId,
                        panelVersionId: panelVersion.id,
                        coverageSummaryId: coverageSummaryId
                          ? Number(coverageSummaryId)
                          : null,
                        findingType,
                        status: findingStatus,
                        result: result as never,
                      });
                    }}
                  >
                    Create finding
                  </Button>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                {(findings.data ?? []).map(finding => (
                  <div
                    key={finding.id}
                    className="flex flex-col gap-3 rounded-xl border p-4 md:flex-row md:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {finding.findingType} · {finding.status}
                      </p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {finding.result
                          ? JSON.stringify(finding.result)
                          : "No typed result"}
                      </p>
                      {finding.reportabilityReasons.length ? (
                        <p className="mt-1 text-xs text-amber-700">
                          {finding.reportabilityReasons.join(", ")}
                        </p>
                      ) : null}
                    </div>
                    <Badge variant="outline">
                      {finding.reportable ? "reportable" : "not reportable"}
                    </Badge>
                    {canApprove ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={reviewFinding.isPending}
                          onClick={() =>
                            reviewFinding.mutate({
                              organizationId,
                              findingId: finding.id,
                              reportable: false,
                            })
                          }
                        >
                          Exclude
                        </Button>
                        <Button
                          size="sm"
                          disabled={reviewFinding.isPending}
                          onClick={() =>
                            reviewFinding.mutate({
                              organizationId,
                              findingId: finding.id,
                              reportable: true,
                            })
                          }
                        >
                          Approve
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700" />
              This panel version does not declare CNV, fusion, MSI, TMB, or HRD
              capability.
            </div>
          )}
        </section>
      </CardContent>
    </Card>
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

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

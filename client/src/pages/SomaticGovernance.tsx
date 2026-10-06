import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

export default function SomaticGovernancePage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [providerCode, setProviderCode] = useState("");
  const [providerName, setProviderName] = useState("");
  const [previewReleaseId, setPreviewReleaseId] = useState<number | null>(null);
  const [rollbackChangeControlId, setRollbackChangeControlId] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [panelImpact, setPanelImpact] = useState({
    previousPanelVersionId: "",
    targetPanelVersionId: "",
    changeControlId: "",
  });
  const [license, setLicense] = useState({
    providerId: "",
    enabled: false,
    status: "unconfigured",
    reference: "",
    validFrom: "",
    validTo: "",
  });
  const [release, setRelease] = useState({
    providerId: "",
    version: "",
    contentHash: "",
    sourcePublishedAt: "",
    changeControlId: "",
    changeSummary: "",
  });
  const [guideline, setGuideline] = useState({
    releaseId: "",
    recordKey: "",
    recordVersion: "1",
    title: "",
    sourceCitation: "",
    effectiveFrom: "",
    effectiveTo: "",
    json: "",
  });
  const [evidence, setEvidence] = useState({ releaseId: "", json: "" });
  const [civicImport, setCivicImport] = useState({
    releaseId: "",
    scopeJson: "",
  });
  const [validation, setValidation] = useState({
    releaseId: "",
    status: "passed",
    summary: "",
  });
  const [policy, setPolicy] = useState({
    name: "",
    version: "1",
    allowNegativeReporting: false,
    enableOncoKb: false,
    contentHash: "",
    changeControlId: "",
    json: "",
  });
  const canRead = hasPermission("variant:read");
  const canEdit = hasPermission("interpretation:edit");
  const canApprove = hasPermission("interpretation:approve");
  const query = trpc.somaticFoundation.list.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId && canRead) }
  );
  const tasks = trpc.somaticFoundation.listReinterpretationTasks.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId && canRead) }
  );
  const preview = trpc.somaticFoundation.previewReleaseImpact.useQuery(
    {
      organizationId: activeOrganizationId || 0,
      releaseId: previewReleaseId || 0,
    },
    { enabled: Boolean(activeOrganizationId && previewReleaseId && canRead) }
  );
  const panelPreview = trpc.somaticFoundation.previewPanelImpact.useQuery(
    {
      organizationId: activeOrganizationId || 0,
      previousPanelVersionId:
        Number(panelImpact.previousPanelVersionId) || 0,
      targetPanelVersionId: Number(panelImpact.targetPanelVersionId) || 0,
    },
    {
      enabled: Boolean(
        activeOrganizationId &&
          canRead &&
          panelImpact.previousPanelVersionId &&
          panelImpact.targetPanelVersionId
      ),
    }
  );
  const createProvider = trpc.somaticFoundation.createProvider.useMutation({
    onSuccess: async () => {
      setProviderCode("");
      setProviderName("");
      await query.refetch();
      toast.success("Provider registry entry created disabled by default.");
    },
    onError: error => toast.error(error.message),
  });
  const configureProviderLicense =
    trpc.somaticFoundation.configureProviderLicense.useMutation({
      onSuccess: async () => {
        await query.refetch();
        toast.success("Provider license configuration saved.");
      },
      onError: error => toast.error(error.message),
    });
  const createRelease = trpc.somaticFoundation.createRelease.useMutation({
    onSuccess: async () => {
      setRelease({
        providerId: "",
        version: "",
        contentHash: "",
        sourcePublishedAt: "",
        changeControlId: "",
        changeSummary: "",
      });
      await query.refetch();
      toast.success("Draft knowledge release created.");
    },
    onError: error => toast.error(error.message),
  });
  const addGuideline = trpc.somaticFoundation.addGuidelineRecord.useMutation({
    onSuccess: async () => {
      setGuideline(current => ({
        ...current,
        recordKey: "",
        title: "",
        sourceCitation: "",
        json: "",
      }));
      await query.refetch();
      toast.success("Guideline record added to the draft release.");
    },
    onError: error => toast.error(error.message),
  });
  const importEvidence =
    trpc.somaticFoundation.importReleaseEvidence.useMutation({
      onSuccess: async result => {
        setEvidence(current => ({ ...current, json: "" }));
        await query.refetch();
        toast.success(
          `${result.importedRecordCount} evidence record(s) imported.`
        );
      },
      onError: error => toast.error(error.message),
    });
  const enqueueCivicImport =
    trpc.somaticFoundation.enqueueCivicImport.useMutation({
      onSuccess: async () => {
        setCivicImport(current => ({ ...current, scopeJson: "" }));
        await query.refetch();
        toast.success("CIViC offline import queued.");
      },
      onError: error => toast.error(error.message),
    });
  const cancelCivicImport =
    trpc.somaticFoundation.cancelCivicImport.useMutation({
      onSuccess: async () => {
        await query.refetch();
        toast.success("CIViC import cancellation recorded.");
      },
      onError: error => toast.error(error.message),
    });
  const recordValidation =
    trpc.somaticFoundation.recordReleaseValidation.useMutation({
      onSuccess: async () => {
        setValidation(current => ({ ...current, summary: "" }));
        await query.refetch();
        toast.success("Release validation recorded.");
      },
      onError: error => toast.error(error.message),
    });
  const createPolicy = trpc.somaticFoundation.createPolicyProfile.useMutation({
    onSuccess: async () => {
      setPolicy({
        name: "",
        version: "1",
        allowNegativeReporting: false,
        enableOncoKb: false,
        contentHash: "",
        changeControlId: "",
        json: "",
      });
      await query.refetch();
      toast.success("Draft policy profile created.");
    },
    onError: error => toast.error(error.message),
  });
  const activateRelease = trpc.somaticFoundation.activateRelease.useMutation({
    onSuccess: async result => {
      await Promise.all([query.refetch(), tasks.refetch()]);
      toast.success(
        `Validated release activated; ${result.reinterpretationTaskCount} case task(s) created.`
      );
    },
    onError: error => toast.error(error.message),
  });
  const activatePolicy =
    trpc.somaticFoundation.activatePolicyProfile.useMutation({
      onSuccess: async result => {
        await Promise.all([query.refetch(), tasks.refetch()]);
        toast.success(
          `Approved policy profile activated; ${result.policyImpactTaskCount} case task(s) created.`
        );
      },
      onError: error => toast.error(error.message),
    });
  const rollbackRelease = trpc.somaticFoundation.rollbackRelease.useMutation({
    onSuccess: async result => {
      await Promise.all([query.refetch(), tasks.refetch(), preview.refetch()]);
      toast.success(
        `Release restored; ${result.reinterpretationTaskCount} case task(s) created.`
      );
      setRollbackChangeControlId("");
      setRollbackReason("");
    },
    onError: error => toast.error(error.message),
  });
  const enqueueTasks =
    trpc.somaticFoundation.enqueueReinterpretationTasks.useMutation({
      onSuccess: async result => {
        await tasks.refetch();
        toast.success(
          `${result.queued} run(s) queued, ${result.deduplicated} linked, ${result.skipped.length} skipped.`
        );
      },
      onError: error => toast.error(error.message),
    });
  const updateTask =
    trpc.somaticFoundation.updateReinterpretationTask.useMutation({
      onSuccess: async () => {
        await tasks.refetch();
        toast.success("Reinterpretation task updated.");
      },
      onError: error => toast.error(error.message),
    });
  const createPanelImpactTasks =
    trpc.somaticFoundation.createPanelImpactTasks.useMutation({
      onSuccess: async result => {
        await tasks.refetch();
        toast.success(
          `${result.createdTaskCount} panel impact task(s) created for ${result.impactedCaseCount} case(s).`
        );
      },
      onError: error => toast.error(error.message),
    });

  if (!canRead) {
    return (
      <StatePanel
        type="forbidden"
        title="Somatic governance access required"
        description="Your organization role cannot read interpretation governance records."
      />
    );
  }
  if (query.isLoading) {
    return (
      <StatePanel
        type="loading"
        title="Loading Somatic governance"
        description="Loading provider, release, guideline, and policy controls."
      />
    );
  }
  if (query.isError || !query.data) {
    return (
      <StatePanel
        type="error"
        title="Failed to load Somatic governance"
        description={query.error?.message || "Governance data is unavailable."}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Somatic change control"
        title="Somatic Governance"
        description="Knowledge, policy, Panel, and assay changes remain controlled by validation, provenance, and approval gates."
        actions={
          <Button
            variant="outline"
            onClick={() => navigate("/workbench/somatic")}
          >
            <ArrowLeft className="mr-2 size-4" />
            Somatic Queue
          </Button>
        }
      />
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="Providers" value={query.data.providers.length} />
        <SummaryCard
          label="Knowledge releases"
          value={query.data.releases.length}
        />
        <SummaryCard
          label="Guideline rules"
          value={query.data.guidelines.length}
        />
        <SummaryCard
          label="Offline evidence"
          value={query.data.evidenceCounts.reduce(
            (total, item) => total + item.count,
            0
          )}
        />
        <SummaryCard
          label="Policy profiles"
          value={query.data.policies.length}
        />
      </div>
      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="text-base">OncoKB API runtime</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">
              mode: {query.data.oncoKbRuntime.mode}
            </Badge>
            <Badge variant="outline">
              token:{" "}
              {query.data.oncoKbRuntime.tokenConfigured
                ? "configured"
                : "not configured"}
            </Badge>
            <Badge variant="outline">
              batch: {query.data.oncoKbRuntime.batchSize}
            </Badge>
            <Badge variant="outline">
              concurrency: {query.data.oncoKbRuntime.maxConcurrency}
            </Badge>
          </div>
          <p className="break-all text-xs text-muted-foreground">
            {query.data.oncoKbRuntime.baseUrl} · API calls{" "}
            {query.data.oncoKbRuntime.metrics.totalApiCalls} · cache hits{" "}
            {query.data.oncoKbRuntime.metrics.cacheHits} · authentication errors{" "}
            {query.data.oncoKbRuntime.metrics.authErrors}
          </p>
          {query.data.oncoKbRuntime.mode === "research" ||
          query.data.oncoKbRuntime.mode === "demo" ? (
            <p className="text-sm text-amber-800">
              Research/demo evidence is stored with provenance for evaluation
              but is blocked from Clinical Report review and signing.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {canEdit ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="text-base">
              Register evidence provider
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
            <Field label="Code">
              <Input
                value={providerCode}
                onChange={event => setProviderCode(event.target.value)}
                placeholder="e.g. oncokb"
              />
            </Field>
            <Field label="Name">
              <Input
                value={providerName}
                onChange={event => setProviderName(event.target.value)}
                placeholder="Provider display name"
              />
            </Field>
            <Button
              disabled={
                createProvider.isPending ||
                providerCode.trim().length < 2 ||
                providerName.trim().length < 2
              }
              onClick={() =>
                createProvider.mutate({
                  organizationId: activeOrganizationId!,
                  code: providerCode.trim(),
                  name: providerName.trim(),
                })
              }
            >
              {createProvider.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Register disabled
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {canApprove && query.data.providers.length ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="text-base">
              Configure provider license
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Provider">
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={license.providerId}
                onChange={event =>
                  setLicense(current => ({
                    ...current,
                    providerId: event.target.value,
                  }))
                }
              >
                <option value="">Select provider</option>
                {query.data.providers.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.code})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="License status">
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={license.status}
                onChange={event =>
                  setLicense(current => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
              >
                <option value="unconfigured">Unconfigured</option>
                <option value="approved">Approved</option>
                <option value="restricted">Restricted</option>
                <option value="expired">Expired</option>
              </select>
            </Field>
            <Field label="License reference">
              <Input
                value={license.reference}
                onChange={event =>
                  setLicense(current => ({
                    ...current,
                    reference: event.target.value,
                  }))
                }
                placeholder="Agreement or approval reference"
              />
            </Field>
            <div className="flex items-end">
              <label className="flex h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={license.enabled}
                  onChange={event =>
                    setLicense(current => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                Enable provider
              </label>
            </div>
            <Field label="Valid from">
              <Input
                type="date"
                value={license.validFrom}
                onChange={event =>
                  setLicense(current => ({
                    ...current,
                    validFrom: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label="Valid to">
              <Input
                type="date"
                value={license.validTo}
                onChange={event =>
                  setLicense(current => ({
                    ...current,
                    validTo: event.target.value,
                  }))
                }
              />
            </Field>
            <div className="flex items-end md:col-span-2">
              <Button
                disabled={
                  configureProviderLicense.isPending || !license.providerId
                }
                onClick={() =>
                  configureProviderLicense.mutate({
                    organizationId: activeOrganizationId!,
                    providerId: Number(license.providerId),
                    enabled: license.enabled,
                    licenseStatus: license.status as
                      | "unconfigured"
                      | "approved"
                      | "restricted"
                      | "expired",
                    licenseReference: license.reference.trim() || null,
                    licenseValidFrom: license.validFrom
                      ? new Date(`${license.validFrom}T00:00:00`)
                      : null,
                    licenseValidTo: license.validTo
                      ? new Date(`${license.validTo}T23:59:59`)
                      : null,
                  })
                }
              >
                {configureProviderLicense.isPending ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : null}
                Save license
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {canEdit && query.data.providers.length ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="text-base">
              Create knowledge release
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Field label="Provider">
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={release.providerId}
                onChange={event =>
                  setRelease(current => ({
                    ...current,
                    providerId: event.target.value,
                  }))
                }
              >
                <option value="">Select provider</option>
                {query.data.providers.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.code})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Version">
              <Input
                value={release.version}
                onChange={event =>
                  setRelease(current => ({
                    ...current,
                    version: event.target.value,
                  }))
                }
                placeholder="Provider release version"
              />
            </Field>
            <Field label="Source publication date">
              <Input
                type="date"
                value={release.sourcePublishedAt}
                onChange={event =>
                  setRelease(current => ({
                    ...current,
                    sourcePublishedAt: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label="Supplied content SHA-256">
              <Input
                value={release.contentHash}
                onChange={event =>
                  setRelease(current => ({
                    ...current,
                    contentHash: event.target.value,
                  }))
                }
                placeholder="64-character SHA-256"
              />
            </Field>
            <Field label="Change-control ID">
              <Input
                value={release.changeControlId}
                onChange={event =>
                  setRelease(current => ({
                    ...current,
                    changeControlId: event.target.value,
                  }))
                }
              />
            </Field>
            <div className="md:col-span-2 xl:col-span-3">
              <Field label="Change summary">
                <Textarea
                  value={release.changeSummary}
                  onChange={event =>
                    setRelease(current => ({
                      ...current,
                      changeSummary: event.target.value,
                    }))
                  }
                  placeholder="Describe source and clinical changes"
                />
              </Field>
            </div>
            <Button
              className="w-fit"
              disabled={
                createRelease.isPending ||
                !release.providerId ||
                !release.version.trim() ||
                !isSha256(release.contentHash) ||
                release.changeControlId.trim().length < 3 ||
                release.changeSummary.trim().length < 10
              }
              onClick={() =>
                createRelease.mutate({
                  organizationId: activeOrganizationId!,
                  providerId: Number(release.providerId),
                  version: release.version.trim(),
                  contentHash: release.contentHash.trim(),
                  sourcePublishedAt: release.sourcePublishedAt
                    ? new Date(`${release.sourcePublishedAt}T00:00:00`)
                    : null,
                  changeControlId: release.changeControlId.trim(),
                  changeSummary: release.changeSummary.trim(),
                })
              }
            >
              {createRelease.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Create draft release
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <GovernanceList
        title="Evidence providers"
        empty="No providers are registered."
        rows={query.data.providers.map(item => ({
          id: item.id,
          title: `${item.name} (${item.code})`,
          detail: `License: ${item.licenseStatus}${item.licenseReference ? ` · ${item.licenseReference}` : ""}${item.licenseValidTo ? ` · valid to ${new Date(item.licenseValidTo).toLocaleDateString()}` : ""}`,
          status: item.enabled ? "enabled" : "disabled",
        }))}
      />
      <GovernanceList
        title="Versioned knowledge releases"
        empty="No knowledge releases have been imported."
        rows={query.data.releases.map(item => ({
          id: item.id,
          title: `Provider ${item.providerId} · ${item.version}`,
          detail: `${item.changeControlId} · validation ${item.validationStatus} · offline evidence ${
            query.data.evidenceCounts.find(count => count.releaseId === item.id)
              ?.count ?? 0
          }`,
          status: item.status,
          action:
            item.status === "draft" || item.status === "retired" ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPreviewReleaseId(item.id)}
                >
                  Preview impact
                </Button>
                {canApprove && item.status === "draft" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={activateRelease.isPending}
                    onClick={() =>
                      activateRelease.mutate({
                        organizationId: activeOrganizationId!,
                        releaseId: item.id,
                      })
                    }
                  >
                    Activate through gates
                  </Button>
                ) : null}
              </div>
            ) : undefined,
        }))}
      />
      {canEdit &&
      query.data.releases.some(
        item =>
          item.status === "draft" &&
          query.data.providers.some(
            provider =>
              provider.id === item.providerId &&
              provider.code.trim().toUpperCase() === "CIVIC"
          )
      ) ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="text-base">
              Import CIViC GraphQL snapshot
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Live API results are archived into a draft offline release. They
              never enter interpretation until separate validation and
              activation are complete. Include normalized variant identifiers
              and genomic/HGVS fields only; do not include case or patient data.
            </p>
            <Field label="CIViC draft release">
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={civicImport.releaseId}
                onChange={event =>
                  setCivicImport(current => ({
                    ...current,
                    releaseId: event.target.value,
                  }))
                }
              >
                <option value="">Select CIViC draft release</option>
                {query.data.releases
                  .filter(
                    item =>
                      item.status === "draft" &&
                      query.data.providers.some(
                        provider =>
                          provider.id === item.providerId &&
                          provider.code.trim().toUpperCase() === "CIVIC"
                      )
                  )
                  .map(item => (
                    <option key={item.id} value={item.id}>
                      {item.version}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Non-PHI normalized variant scope (JSON array)">
              <Textarea
                rows={8}
                value={civicImport.scopeJson}
                onChange={event =>
                  setCivicImport(current => ({
                    ...current,
                    scopeJson: event.target.value,
                  }))
                }
                placeholder='[{"normalizedVariantId":"GRCh38:7:140753336:A:T","geneSymbol":"BRAF","genomeBuild":"GRCh38","chromosome":"7","position":140753336,"ref":"A","alt":"T","hgvsP":"p.V600E"}]'
              />
            </Field>
            <Button
              disabled={
                enqueueCivicImport.isPending ||
                !civicImport.releaseId ||
                !civicImport.scopeJson.trim()
              }
              onClick={() => {
                try {
                  const parsed = JSON.parse(civicImport.scopeJson);
                  if (!Array.isArray(parsed)) {
                    throw new Error("Scope must be a JSON array.");
                  }
                  enqueueCivicImport.mutate({
                    organizationId: activeOrganizationId!,
                    releaseId: Number(civicImport.releaseId),
                    scopeConfig: parsed,
                  });
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : "Invalid CIViC scope JSON."
                  );
                }
              }}
            >
              {enqueueCivicImport.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Queue offline import
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <GovernanceList
        title="CIViC import jobs"
        empty="No CIViC GraphQL imports have been queued."
        rows={query.data.civicImportJobs.map(item => ({
          id: item.id,
          title: `Release ${item.releaseId} · snapshot ${item.snapshotHash.slice(0, 12)}`,
          detail: `${item.attemptCount}/${item.maxAttempts} attempts · ${Object.entries(item.stats || {})
            .map(([key, value]) => `${key} ${value}`)
            .join(" · ") || "waiting for worker"}${
            item.warnings?.length ? ` · ${item.warnings.join(", ")}` : ""
          }`,
          status: item.status,
          action:
            canEdit &&
            ["queued", "running", "partial"].includes(item.status) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={cancelCivicImport.isPending}
                onClick={() =>
                  cancelCivicImport.mutate({
                    organizationId: activeOrganizationId!,
                    jobId: item.id,
                  })
                }
              >
                Cancel
              </Button>
            ) : undefined,
        }))}
      />
      {query.data.releases.some(item => item.status === "draft") &&
      (canEdit || canApprove) ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="text-base">
              Prepare and validate draft releases
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {canEdit ? (
              <div className="space-y-4 rounded-xl border border-border/70 p-4">
                <p className="text-sm font-medium">Add guideline record</p>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <Field label="Draft release">
                    <DraftReleaseSelect
                      releases={query.data.releases}
                      value={guideline.releaseId}
                      onChange={value =>
                        setGuideline(current => ({
                          ...current,
                          releaseId: value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Record key">
                    <Input
                      value={guideline.recordKey}
                      onChange={event =>
                        setGuideline(current => ({
                          ...current,
                          recordKey: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Record version">
                    <Input
                      type="number"
                      min={1}
                      value={guideline.recordVersion}
                      onChange={event =>
                        setGuideline(current => ({
                          ...current,
                          recordVersion: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Title">
                    <Input
                      value={guideline.title}
                      onChange={event =>
                        setGuideline(current => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Source citation">
                      <Input
                        value={guideline.sourceCitation}
                        onChange={event =>
                          setGuideline(current => ({
                            ...current,
                            sourceCitation: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                  <Field label="Effective from">
                    <Input
                      type="date"
                      value={guideline.effectiveFrom}
                      onChange={event =>
                        setGuideline(current => ({
                          ...current,
                          effectiveFrom: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Effective to">
                    <Input
                      type="date"
                      value={guideline.effectiveTo}
                      onChange={event =>
                        setGuideline(current => ({
                          ...current,
                          effectiveTo: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <div className="md:col-span-2 xl:col-span-4">
                    <Field label="Guideline JSON">
                      <Textarea
                        className="min-h-32 font-mono text-xs"
                        value={guideline.json}
                        onChange={event =>
                          setGuideline(current => ({
                            ...current,
                            json: event.target.value,
                          }))
                        }
                        placeholder='{"kind":"nccn_evidence_revision","status":"active",...} or {"schemaVersion":1,"kind":"somatic_amp_proposal_rule",...}'
                      />
                    </Field>
                  </div>
                </div>
                <Button
                  disabled={
                    addGuideline.isPending ||
                    !guideline.releaseId ||
                    !guideline.recordKey.trim() ||
                    guideline.title.trim().length < 3 ||
                    !Number.isInteger(Number(guideline.recordVersion)) ||
                    Number(guideline.recordVersion) < 1 ||
                    guideline.sourceCitation.trim().length < 3 ||
                    !guideline.json.trim()
                  }
                  onClick={() => {
                    const parsed = parseJsonObject(
                      guideline.json,
                      "Guideline JSON"
                    );
                    if (!parsed) return;
                    addGuideline.mutate({
                      organizationId: activeOrganizationId!,
                      releaseId: Number(guideline.releaseId),
                      recordKey: guideline.recordKey.trim(),
                      recordVersion: Number(guideline.recordVersion),
                      title: guideline.title.trim(),
                      guideline: parsed,
                      sourceCitation: guideline.sourceCitation.trim(),
                      effectiveFrom: guideline.effectiveFrom
                        ? new Date(`${guideline.effectiveFrom}T00:00:00`)
                        : null,
                      effectiveTo: guideline.effectiveTo
                        ? new Date(`${guideline.effectiveTo}T23:59:59`)
                        : null,
                    });
                  }}
                >
                  {addGuideline.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  Add guideline
                </Button>
              </div>
            ) : null}

            {canEdit ? (
              <div className="space-y-4 rounded-xl border border-border/70 p-4">
                <p className="text-sm font-medium">Import offline evidence</p>
                <Field label="Draft release">
                  <DraftReleaseSelect
                    releases={query.data.releases}
                    value={evidence.releaseId}
                    onChange={value =>
                      setEvidence(current => ({
                        ...current,
                        releaseId: value,
                      }))
                    }
                  />
                </Field>
                <Field label="Evidence records JSON array">
                  <Textarea
                    className="min-h-40 font-mono text-xs"
                    value={evidence.json}
                    onChange={event =>
                      setEvidence(current => ({
                        ...current,
                        json: event.target.value,
                      }))
                    }
                    placeholder='[{"normalizedVariantId":"...","sourceRecordId":"...",...}]'
                  />
                </Field>
                <Button
                  disabled={
                    importEvidence.isPending ||
                    !evidence.releaseId ||
                    !evidence.json.trim()
                  }
                  onClick={() => {
                    const records = parseJsonArray(
                      evidence.json,
                      "Evidence JSON"
                    );
                    if (!records) return;
                    importEvidence.mutate({
                      organizationId: activeOrganizationId!,
                      releaseId: Number(evidence.releaseId),
                      records,
                    });
                  }}
                >
                  {importEvidence.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  Import evidence
                </Button>
              </div>
            ) : null}

            {canApprove ? (
              <div className="space-y-4 rounded-xl border border-border/70 p-4">
                <p className="text-sm font-medium">Record release validation</p>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Draft release">
                    <DraftReleaseSelect
                      releases={query.data.releases}
                      value={validation.releaseId}
                      onChange={value =>
                        setValidation(current => ({
                          ...current,
                          releaseId: value,
                        }))
                      }
                    />
                  </Field>
                  <Field label="Validation status">
                    <select
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={validation.status}
                      onChange={event =>
                        setValidation(current => ({
                          ...current,
                          status: event.target.value,
                        }))
                      }
                    >
                      <option value="passed">Passed</option>
                      <option value="failed">Failed</option>
                    </select>
                  </Field>
                  <div className="md:col-span-2">
                    <Field label="Validation summary JSON object">
                      <Textarea
                        className="min-h-28 font-mono text-xs"
                        value={validation.summary}
                        onChange={event =>
                          setValidation(current => ({
                            ...current,
                            summary: event.target.value,
                          }))
                        }
                        placeholder='{"artifact":"...","checks":[...]}'
                      />
                    </Field>
                  </div>
                </div>
                <Button
                  disabled={
                    recordValidation.isPending ||
                    !validation.releaseId ||
                    !validation.summary.trim()
                  }
                  onClick={() => {
                    const summary = parseJsonObject(
                      validation.summary,
                      "Validation summary"
                    );
                    if (!summary) return;
                    recordValidation.mutate({
                      organizationId: activeOrganizationId!,
                      releaseId: Number(validation.releaseId),
                      validationStatus: validation.status as
                        | "passed"
                        | "failed",
                      validationSummary: summary,
                    });
                  }}
                >
                  {recordValidation.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  Record validation
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {previewReleaseId ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Release impact preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {preview.isLoading ? (
              <p className="text-sm text-muted-foreground">
                Calculating release differences and affected cases.
              </p>
            ) : preview.isError || !preview.data ? (
              <StatePanel
                type="error"
                title="Impact preview unavailable"
                description={preview.error?.message || "Release not found."}
                onRetry={() => void preview.refetch()}
              />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <SummaryCard
                    label="Added evidence"
                    value={preview.data.releaseDiff.added}
                  />
                  <SummaryCard
                    label="Changed evidence"
                    value={preview.data.releaseDiff.changed}
                  />
                  <SummaryCard
                    label="Removed evidence"
                    value={preview.data.releaseDiff.removed}
                  />
                  <SummaryCard
                    label="Affected cases"
                    value={preview.data.impactedCases.length}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  {preview.data.currentRelease?.version || "No active release"}{" "}
                  → {preview.data.targetRelease.version} · activation gates{" "}
                  {preview.data.gates.allowed ? "passed" : "blocked"}
                </p>
                {preview.data.releaseDiff.impactedVariantIds.length ? (
                  <div className="flex flex-wrap gap-2">
                    {preview.data.releaseDiff.impactedVariantIds.map(id => (
                      <Badge key={id} variant="outline">
                        {id}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {!preview.data.gates.allowed ? (
                  <p className="text-sm text-destructive">
                    {preview.data.gates.reasons.join(", ")}
                  </p>
                ) : null}
                {canApprove &&
                preview.data.targetRelease.status === "retired" ? (
                  <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4">
                    <p className="text-sm font-medium text-amber-950">
                      Controlled rollback
                    </p>
                    <Input
                      value={rollbackChangeControlId}
                      onChange={event =>
                        setRollbackChangeControlId(event.target.value)
                      }
                      placeholder="Change-control ID"
                    />
                    <Textarea
                      value={rollbackReason}
                      onChange={event => setRollbackReason(event.target.value)}
                      placeholder="Clinical and operational rollback reason"
                    />
                    <Button
                      variant="destructive"
                      disabled={
                        rollbackRelease.isPending ||
                        !preview.data.gates.allowed ||
                        rollbackChangeControlId.trim().length < 3 ||
                        rollbackReason.trim().length < 10
                      }
                      onClick={() =>
                        rollbackRelease.mutate({
                          organizationId: activeOrganizationId!,
                          releaseId: preview.data.targetRelease.id,
                          changeControlId: rollbackChangeControlId.trim(),
                          reason: rollbackReason.trim(),
                        })
                      }
                    >
                      Restore validated release
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
      <GovernanceList
        title="Version-pinned guideline rules"
        empty="No guideline rules have been imported."
        rows={query.data.guidelines.map(item => {
          const release = query.data.releases.find(
            candidate => candidate.id === item.releaseId
          );
          return {
            id: item.id,
            title: `${item.recordKey} · v${item.recordVersion}`,
            detail: `${item.title} · release ${release?.version || item.releaseId}`,
            status: release?.status || "unknown",
          };
        })}
      />
      {canEdit ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Create policy profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <Field label="Name">
                <Input
                  value={policy.name}
                  onChange={event =>
                    setPolicy(current => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Version">
                <Input
                  type="number"
                  min={1}
                  value={policy.version}
                  onChange={event =>
                    setPolicy(current => ({
                      ...current,
                      version: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Change-control ID">
                <Input
                  value={policy.changeControlId}
                  onChange={event =>
                    setPolicy(current => ({
                      ...current,
                      changeControlId: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Exact supplied content SHA-256">
                <Input
                  value={policy.contentHash}
                  onChange={event =>
                    setPolicy(current => ({
                      ...current,
                      contentHash: event.target.value,
                    }))
                  }
                  placeholder="64-character SHA-256"
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-5">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={policy.allowNegativeReporting}
                  onChange={event =>
                    setPolicy(current => ({
                      ...current,
                      allowNegativeReporting: event.target.checked,
                    }))
                  }
                />
                Request negative reporting
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={policy.enableOncoKb}
                  onChange={event =>
                    setPolicy(current => ({
                      ...current,
                      enableOncoKb: event.target.checked,
                    }))
                  }
                />
                Request OncoKB
              </label>
            </div>
            <Field label="Policy JSON object">
              <Textarea
                className="min-h-32 font-mono text-xs"
                value={policy.json}
                onChange={event =>
                  setPolicy(current => ({
                    ...current,
                    json: event.target.value,
                  }))
                }
                placeholder='{"reporting":{...}}'
              />
            </Field>
            <Button
              disabled={
                createPolicy.isPending ||
                policy.name.trim().length < 2 ||
                !Number.isInteger(Number(policy.version)) ||
                Number(policy.version) < 1 ||
                policy.changeControlId.trim().length < 3 ||
                !isSha256(policy.contentHash) ||
                !policy.json.trim()
              }
              onClick={() => {
                const parsed = parseJsonObject(policy.json, "Policy JSON");
                if (!parsed) return;
                createPolicy.mutate({
                  organizationId: activeOrganizationId!,
                  name: policy.name.trim(),
                  version: Number(policy.version),
                  allowNegativeReporting: policy.allowNegativeReporting,
                  enableOncoKb: policy.enableOncoKb,
                  policy: parsed,
                  contentHash: policy.contentHash.trim(),
                  changeControlId: policy.changeControlId.trim(),
                });
              }}
            >
              {createPolicy.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              Create draft policy
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <GovernanceList
        title="Organization policy profiles"
        empty="No policy profiles have been created."
        rows={query.data.policies.map(item => ({
          id: item.id,
          title: `${item.name} v${item.version}`,
          detail: `Negative reporting: ${item.allowNegativeReporting ? "requested" : "disabled"} · OncoKB: ${item.enableOncoKb ? "requested" : "disabled"}`,
          status: item.status,
          action:
            canApprove && item.status === "draft" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={activatePolicy.isPending}
                onClick={() =>
                  activatePolicy.mutate({
                    organizationId: activeOrganizationId!,
                    policyProfileId: item.id,
                  })
                }
              >
                Activate through gates
              </Button>
            ) : undefined,
        }))}
      />
      <Card className="clinical-card shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            Panel version impact review
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Current panel version">
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={panelImpact.previousPanelVersionId}
                onChange={event =>
                  setPanelImpact(current => ({
                    ...current,
                    previousPanelVersionId: event.target.value,
                  }))
                }
              >
                <option value="">Select version</option>
                {query.data.panelVersions.map(item => (
                  <option key={item.version.id} value={item.version.id}>
                    {item.manufacturer} {item.panelName} ·{" "}
                    {item.version.version}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Validated target version">
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={panelImpact.targetPanelVersionId}
                onChange={event =>
                  setPanelImpact(current => ({
                    ...current,
                    targetPanelVersionId: event.target.value,
                  }))
                }
              >
                <option value="">Select version</option>
                {query.data.panelVersions
                  .filter(
                    item => item.version.regionValidationStatus === "passed"
                  )
                  .map(item => (
                    <option key={item.version.id} value={item.version.id}>
                      {item.manufacturer} {item.panelName} ·{" "}
                      {item.version.version}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          {panelPreview.isLoading ? (
            <p className="text-sm text-muted-foreground">
              Calculating panel definition changes.
            </p>
          ) : panelPreview.isError ? (
            <p className="text-sm text-destructive">
              {panelPreview.error.message}
            </p>
          ) : panelPreview.data ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryCard
                  label="Added regions"
                  value={panelPreview.data.regionDiff.added.length}
                />
                <SummaryCard
                  label="Changed regions"
                  value={panelPreview.data.regionDiff.changed.length}
                />
                <SummaryCard
                  label="Removed regions"
                  value={panelPreview.data.regionDiff.removed.length}
                />
                <SummaryCard
                  label="Affected cases"
                  value={panelPreview.data.impactedCaseIds.length}
                />
              </div>
              {panelPreview.data.capabilityChanges.length ? (
                <p className="text-sm text-muted-foreground">
                  Capability changes:{" "}
                  {panelPreview.data.capabilityChanges.join(", ")}
                </p>
              ) : null}
              {panelPreview.data.metadataChanges.length ? (
                <p className="text-sm text-muted-foreground">
                  Metadata changes:{" "}
                  {panelPreview.data.metadataChanges.join(", ")}
                </p>
              ) : null}
              {canApprove ? (
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Input
                    value={panelImpact.changeControlId}
                    onChange={event =>
                      setPanelImpact(current => ({
                        ...current,
                        changeControlId: event.target.value,
                      }))
                    }
                    placeholder="Approved change-control ID"
                  />
                  <Button
                    disabled={
                      createPanelImpactTasks.isPending ||
                      !panelPreview.data.hasChanges ||
                      panelImpact.changeControlId.trim().length < 3
                    }
                    onClick={() =>
                      createPanelImpactTasks.mutate({
                        organizationId: activeOrganizationId!,
                        previousPanelVersionId: Number(
                          panelImpact.previousPanelVersionId
                        ),
                        targetPanelVersionId: Number(
                          panelImpact.targetPanelVersionId
                        ),
                        expectedChangeHash: panelPreview.data.changeHash,
                        changeControlId:
                          panelImpact.changeControlId.trim(),
                      })
                    }
                  >
                    Create impact tasks
                  </Button>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Cases remain pinned to their original panel version. This
                action only creates controlled reinterpretation tasks.
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>
      <Card className="clinical-card shadow-none">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">
            Change impact review queue
          </CardTitle>
          {canEdit &&
          (tasks.data ?? []).some(item => item.status === "open") ? (
            <Button
              size="sm"
              disabled={enqueueTasks.isPending}
              onClick={() =>
                enqueueTasks.mutate({
                  organizationId: activeOrganizationId!,
                  taskIds: (tasks.data ?? [])
                    .filter(item => item.status === "open")
                    .slice(0, 100)
                    .map(item => item.id),
                })
              }
            >
              Queue all open
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {tasks.isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Loading reinterpretation tasks.
            </p>
          ) : tasks.isError ? (
            <StatePanel
              type="error"
              title="Reinterpretation tasks unavailable"
              description={tasks.error.message}
              onRetry={() => void tasks.refetch()}
            />
          ) : (tasks.data ?? []).length ? (
            (tasks.data ?? []).map(item => (
              <div
                key={item.id}
                className="flex flex-col gap-3 rounded-xl border border-border/70 p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      Case {item.caseId} ·{" "}
                      {item.previousReleaseVersion || "initial"} →{" "}
                      {item.targetReleaseVersion}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="secondary">
                        {item.changeKind === "policy_profile"
                          ? "Policy impact"
                          : item.changeKind === "panel_version"
                            ? "Panel impact"
                            : item.changeKind === "assay_artifact"
                              ? "Assay impact"
                          : "Knowledge release"}
                      </Badge>
                      {item.changeKey ? (
                        <span className="text-xs text-muted-foreground">
                          {item.changeKey}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.reason}
                    </p>
                    {item.interpretationRun ? (
                      <p className="mt-2 text-xs">
                        Run {item.interpretationRun.id}:{" "}
                        {item.interpretationRun.status} · attempt{" "}
                        {item.interpretationRun.attemptCount}/
                        {item.interpretationRun.maxAttempts} · unresolved
                        assertions {item.interpretationRun.unresolvedAssertions}
                      </p>
                    ) : null}
                  </div>
                  <Badge variant="outline">{item.status}</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/workbench/${item.caseId}`)}
                  >
                    Open case
                  </Button>
                  {canEdit &&
                  (item.status === "open" || item.status === "in_review") ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        enqueueTasks.isPending ||
                        Boolean(item.interpretationRunId)
                      }
                      onClick={() =>
                        enqueueTasks.mutate({
                          organizationId: activeOrganizationId!,
                          taskIds: [item.id],
                        })
                      }
                    >
                      {item.interpretationRunId
                        ? "Run linked"
                        : "Queue reinterpretation"}
                    </Button>
                  ) : null}
                  {canApprove && item.status === "in_review" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={
                          updateTask.isPending ||
                          item.interpretationRun?.status !==
                            "ready_for_review" ||
                          item.interpretationRun.unresolvedAssertions > 0
                        }
                        onClick={() =>
                          updateTask.mutate({
                            organizationId: activeOrganizationId!,
                            taskId: item.id,
                            status: "completed",
                          })
                        }
                      >
                        Complete review
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updateTask.isPending}
                        onClick={() =>
                          updateTask.mutate({
                            organizationId: activeOrganizationId!,
                            taskId: item.id,
                            status: "dismissed",
                          })
                        }
                      >
                        Dismiss
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No knowledge, policy, Panel, or assay changes require case
              reinterpretation.
            </p>
          )}
        </CardContent>
      </Card>
      <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4 text-sm text-amber-950">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        Registration never enables a provider or negative reporting. Activation
        remains server-gated by license, validation artifact, coverage, and
        approved organization policy.
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="clinical-card shadow-none">
      <CardContent className="p-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-2 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

function GovernanceList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{
    id: number;
    title: string;
    detail: string;
    status: string;
    action?: React.ReactNode;
  }>;
}) {
  return (
    <Card className="clinical-card shadow-none">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length ? (
          rows.map(row => (
            <div
              key={row.id}
              className="flex flex-col gap-3 rounded-xl border border-border/70 p-4 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{row.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.detail}
                </p>
              </div>
              <Badge variant="outline">{row.status}</Badge>
              {row.action}
            </div>
          ))
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {empty}
          </p>
        )}
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

function DraftReleaseSelect({
  releases,
  value,
  onChange,
}: {
  releases: Array<{ id: number; version: string; status: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      onChange={event => onChange(event.target.value)}
    >
      <option value="">Select draft release</option>
      {releases
        .filter(item => item.status === "draft")
        .map(item => (
          <option key={item.id} value={item.id}>
            {item.version} (ID {item.id})
          </option>
        ))}
    </select>
  );
}

function parseJsonObject(value: string, label: string) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      toast.error(`${label} must be a JSON object.`);
      return null;
    }
    return parsed;
  } catch (error) {
    toast.error(
      `${label} is invalid JSON: ${
        error instanceof Error ? error.message : "unable to parse"
      }`
    );
    return null;
  }
}

function parseJsonArray(value: string, label: string) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      toast.error(`${label} must be a JSON array.`);
      return null;
    }
    if (parsed.length < 1 || parsed.length > 500) {
      toast.error(`${label} must contain between 1 and 500 records.`);
      return null;
    }
    if (
      parsed.some(
        item => !item || typeof item !== "object" || Array.isArray(item)
      )
    ) {
      toast.error(`${label} entries must all be JSON objects.`);
      return null;
    }
    return parsed;
  } catch (error) {
    toast.error(
      `${label} is invalid JSON: ${
        error instanceof Error ? error.message : "unable to parse"
      }`
    );
    return null;
  }
}

function isSha256(value: string) {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

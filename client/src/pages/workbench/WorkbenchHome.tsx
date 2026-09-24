import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOrganization } from "@/contexts/OrganizationContext";
import { formatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { isSingleVariantBatch } from "@shared/curation/workbench";
import { ArrowRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { AnalysisLogDialog } from "./AnalysisLogDialog";
import { ReusedAnalysisDialog, type ReusedAnalysisNotice } from "./ReusedAnalysisDialog";
import { VariantIntakeForm } from "./intake";
import { SortHeader, compareSortValues, type SortDirection } from "./sort";
import { batchAnalyzedAt, classificationTone, entryAction, entryChip, entryReview, entryRun, variantAnalyzedAt, workbenchStatusClass, workbenchStatusLabel } from "./status";

type EntrySortKey = "type" | "batchName" | "gene" | "hgvs" | "transcript" | "acmg" | "institutional" | "status" | "analyzed";

export default function WorkbenchHomePage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [batchName, setBatchName] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: EntrySortKey; direction: SortDirection } | null>(null);
  const [logRunId, setLogRunId] = useState<number | null>(null);
  const [reusedNotice, setReusedNotice] = useState<ReusedAnalysisNotice | null>(null);
  const canRead = hasPermission("variant:read");
  const canCurate = hasPermission("curation:run");

  const entries = trpc.workbench.listEntries.useQuery(
    { organizationId: activeOrganizationId || 0 },
    {
      enabled: Boolean(activeOrganizationId && canRead),
      refetchInterval: query =>
        query.state.data?.some(entry => entry.status === "queued" || entry.status === "loading" || entry.status === "running") ? 4000 : false,
    }
  );
  const batches = trpc.workbench.listBatches.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId && canRead) }
  );

  const runSingle = trpc.workbench.runSingle.useMutation({
    onSuccess: async (result, variables) => {
      await entries.refetch();
      if (result.reused) {
        setReusedNotice({ gene: variables.gene, hgvsC: variables.hgvsC, ...result.reused });
        return;
      }
      toast.success("Variant queued. The classifier starts it as soon as the engine is ready.");
      navigate(`/workbench/batches/${result.batchId}`);
    },
    onError: error => toast.error(error.message),
  });
  const runBatch = trpc.workbench.runBatch.useMutation({
    onSuccess: async result => {
      await entries.refetch();
      toast.success(
        result.workerStarted
          ? "Classifier starting. The first variant shows Loading, then Running. The rest stay Queued."
          : "Run started. One variant runs at a time."
      );
    },
    onError: error => toast.error(error.message),
  });
  const rerunEntry = trpc.workbench.rerunEntry.useMutation({
    onSuccess: async () => {
      await entries.refetch();
      toast.success("Re-run queued. It starts as soon as the classifier is free.");
    },
    onError: error => toast.error(error.message),
  });
  const rerunBatch = trpc.workbench.rerunBatch.useMutation({
    onSuccess: async () => {
      await entries.refetch();
      toast.success("Re-run queued. Variants run one at a time.");
    },
    onError: error => toast.error(error.message),
  });
  const releaseEntry = trpc.workbench.releaseEntry.useMutation({
    onSuccess: async result => {
      await entries.refetch();
      toast.success(
        result.workerStarted
          ? "Classifier starting. This variant shows Loading while reference data mounts, then Running."
          : "Run started. One variant runs at a time."
      );
    },
    onError: error => toast.error(error.message),
  });
  const createBatch = trpc.workbench.createBatch.useMutation({
    onSuccess: result => {
      setBatchName("");
      navigate(`/workbench/batches/${result.id}`);
    },
    onError: error => toast.error(error.message),
  });

  const rows = useMemo(() => {
    const source = entries.data ?? [];
    const grouped: Array<
      | { kind: "single"; entry: (typeof source)[number] }
      | { kind: "batch"; batchId: number; name: string; entries: (typeof source)[number][] }
      | { kind: "case"; caseId: number; name: string; entries: (typeof source)[number][] }
    > = [];
    const batchAt = new Map<number, number>();
    const caseAt = new Map<number, number>();
    for (const entry of source) {
      const realBatch = Boolean(entry.batchId && entry.batchName && !isSingleVariantBatch(entry.batchName));
      if (realBatch && entry.batchId && entry.batchName) {
        const at = batchAt.get(entry.batchId);
        if (at === undefined) {
          batchAt.set(entry.batchId, grouped.length);
          grouped.push({ kind: "batch", batchId: entry.batchId, name: entry.batchName, entries: [entry] });
        } else {
          const row = grouped[at];
          if (row?.kind === "batch") row.entries.push(entry);
        }
        continue;
      }
      if (entry.caseId && entry.caseNumber) {
        const at = caseAt.get(entry.caseId);
        if (at === undefined) {
          caseAt.set(entry.caseId, grouped.length);
          grouped.push({ kind: "case", caseId: entry.caseId, name: entry.caseNumber, entries: [entry] });
        } else {
          const row = grouped[at];
          if (row?.kind === "case") row.entries.push(entry);
        }
        continue;
      }
      grouped.push({ kind: "single", entry });
    }
    const query = search.trim().toLowerCase();
    if (!query) return grouped;
    const matches = (entry: (typeof source)[number]) => {
      const acmg = entry.summary?.classification;
      return [entry.input.gene, entry.input.hgvsC, entry.input.transcript, acmg?.label, workbenchStatusLabel(entry.status)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    };
    return grouped.filter(row => (row.kind === "single" ? matches(row.entry) : row.entries.some(matches)));
  }, [entries.data, search]);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const value = (row: (typeof rows)[number], key: EntrySortKey): string | number | null => {
      if (row.kind === "batch" || row.kind === "case") {
        const headline = (["loading", "running", "queued", "failed", "cancelled", "succeeded"] as const).find(status =>
          row.entries.some(entry => entry.status === status)
        ) ?? "queued";
        if (key === "type") return row.kind === "batch" ? "Batch" : "Case";
        if (key === "batchName") return row.name;
        if (key === "gene") return [...row.entries].map(entry => entry.input.gene).sort((a, b) => a.localeCompare(b))[0] ?? "";
        if (key === "status") return workbenchStatusLabel(headline);
        if (key === "analyzed") return batchAnalyzedAt(row.entries);
        return "";
      }
      const entry = row.entry;
      if (key === "type") return "Single variant";
      if (key === "batchName") return "";
      if (key === "gene") return entry.input.gene;
      if (key === "hgvs") return entry.input.hgvsC;
      if (key === "transcript") return entry.input.transcript || "";
      if (key === "acmg") return entry.summary?.classification?.label || "";
      if (key === "institutional") return entry.institutionalLabel || "";
      if (key === "status") return workbenchStatusLabel(entry.status);
      return variantAnalyzedAt(entry.status, entry.completedAt);
    };
    return [...rows].sort((left, right) => compareSortValues(value(left, sort.key), value(right, sort.key), sort.direction));
  }, [rows, sort]);

  const toggleSort = (key: EntrySortKey) => {
    setSort(current => (current?.key === key && current.direction === "asc" ? { key, direction: "desc" } : { key, direction: "asc" }));
  };

  if (!canRead) {
    return (
      <div className="space-y-7">
        <PageHeader eyebrow="Variant interpretation" title="Variant Workbench" description="Add variants to a batch and review the classifier annotation." />
        <StatePanel type="forbidden" title="You do not have permission to view variants" description="Ask your organization administrator for a role that includes the variant:read action." />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Variant interpretation"
        title="Variant Workbench"
        description="Run a single variant, or collect several into a batch and review each annotation."
      />

      {canCurate ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div>
                <h2 className="font-display text-lg font-semibold">Run a single variant</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Gene and HGVSc are required. Reference data stays loaded, so a run starts analysis without mounting it again. One variant runs at a time.
                </p>
              </div>
              <VariantIntakeForm
                pending={runSingle.isPending}
                submitLabel="Run variant"
                onSubmit={values => runSingle.mutate({ organizationId: activeOrganizationId!, ...values })}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-4 p-5">
              <div>
                <h2 className="font-display text-lg font-semibold">New batch</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Name a batch, add variants, then press Run batch. The first shows Loading, then Running. The rest stay Queued.
                </p>
              </div>
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={event => {
                  event.preventDefault();
                  if (!batchName.trim() || createBatch.isPending) return;
                  createBatch.mutate({ organizationId: activeOrganizationId!, name: batchName.trim() });
                }}
              >
                <div className="flex-1 space-y-2">
                  <Label htmlFor="batch-name">Batch name</Label>
                  <Input id="batch-name" value={batchName} onChange={event => setBatchName(event.target.value)} placeholder="e.g. 9/23 review" />
                </div>
                <Button type="submit" disabled={!batchName.trim() || createBatch.isPending}>
                  {createBatch.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                  Create batch
                </Button>
              </form>
              {batches.data?.length ? (
                <div className="flex flex-wrap gap-2">
                  {batches.data.map(batch => (
                    <Button key={batch.id} variant="outline" size="sm" onClick={() => navigate(`/workbench/batches/${batch.id}`)}>
                      {batch.name}
                      <ArrowRight className="ml-2 size-3.5" />
                    </Button>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-4 p-5">
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Gene, HGVSc, transcript, ACMG, or status"
            className="max-w-md"
            aria-label="Search by gene, HGVSc, transcript, ACMG, or status"
          />
          <div>
            <h2 className="font-display text-lg font-semibold">All entries</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {search.trim()
                ? `${rows.length} matching`
                : `${rows.length} ${rows.length === 1 ? "row" : "rows"}`}
            </p>
          </div>
          {entries.isError ? (
            <StatePanel compact type="error" title="Failed to load entries" description={entries.error.message} onRetry={() => { void entries.refetch(); }} />
          ) : entries.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading entries…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {search.trim() ? "No entries match that search." : "No entries yet. Run a single variant or open a batch and add one."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b">
                    {([
                      ["type", "Type"],
                      ["batchName", "Name"],
                      ["gene", "Gene"],
                      ["hgvs", "HGVSc"],
                      ["transcript", "Transcript"],
                      ["acmg", "ACMG"],
                      ["institutional", "Institutional"],
                      ["status", "Status"],
                      ["analyzed", "Analyzed time"],
                    ] as const).map(([key, label]) => (
                      <SortHeader
                        key={key}
                        label={label}
                        active={sort?.key === key}
                        direction={sort?.direction ?? "asc"}
                        onClick={() => toggleSort(key)}
                      />
                    ))}
                    <th className="py-2 pr-3">Log</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map(row => {
                    if (row.kind === "batch" || row.kind === "case") {
                      const members = row.entries;
                      const headline = (["loading", "running", "queued", "failed", "cancelled", "succeeded"] as const).find(status =>
                        members.some(entry => entry.status === status)
                      ) ?? "queued";
                      const done = members.filter(entry => entry.status === "succeeded").length;
                      const busy = members.some(entry => entry.status === "loading" || entry.status === "running");
                      const runnable = members.some(entry => entry.status === "queued" || entry.status === "failed" || entry.status === "cancelled");
                      const review = members.find(entry => entry.status === "succeeded");
                      const analyzed = batchAnalyzedAt(members);
                      const open = () => navigate(row.kind === "batch" ? `/workbench/batches/${row.batchId}` : `/cases/${row.caseId}`);
                      return (
                        <tr key={row.kind === "batch" ? `batch-${row.batchId}` : `case-${row.caseId}`} className="border-b border-border/60">
                          <td className="py-2 pr-3">
                            <button type="button" className="text-left text-primary hover:underline" onClick={open}>
                              {row.kind === "batch" ? "Batch" : "Case"}
                            </button>
                          </td>
                          <td className="py-2 pr-3">
                            <button type="button" className="text-left text-primary hover:underline" onClick={open}>
                              {row.name}
                            </button>
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground">{members.length} variants</td>
                          <td className="py-2 pr-3 text-muted-foreground">—</td>
                          <td className="py-2 pr-3 text-muted-foreground">—</td>
                          <td className="py-2 pr-3 text-muted-foreground">—</td>
                          <td className="py-2 pr-3 text-muted-foreground">—</td>
                          <td className="py-2 pr-3">
                            <Badge variant="outline" className={cn(entryChip, workbenchStatusClass(headline))}>{workbenchStatusLabel(headline)}</Badge>
                            {done > 0 && done < members.length ? <span className="ml-2 text-xs text-muted-foreground">{done} done</span> : null}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{analyzed === null ? "—" : formatDateTime(new Date(analyzed))}</td>
                          <td className="py-2 pr-3 text-muted-foreground">—</td>
                          <td className="py-2 text-right">
                            {row.kind === "batch" && canCurate && runnable && !busy ? (
                              <Button size="sm" variant="outline" className={entryRun} disabled={runBatch.isPending} onClick={() => runBatch.mutate({ organizationId: activeOrganizationId!, batchId: row.batchId })}>
                                Run batch
                              </Button>
                            ) : row.kind === "batch" && review ? (
                              <div className="flex justify-end gap-2">
                                {canCurate ? (
                                  <Button size="sm" variant="outline" className={entryAction} disabled={rerunBatch.isPending} onClick={() => rerunBatch.mutate({ organizationId: activeOrganizationId!, batchId: row.batchId })}>
                                    Re-run
                                  </Button>
                                ) : null}
                                <Button size="sm" variant="outline" className={entryReview} onClick={() => navigate(`/workbench/batches/${row.batchId}/review/${review.id}`)}>
                                  Review
                                </Button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    }
                    const entry = row.entry;
                    const acmg = entry.summary?.classification;
                    const batchId = entry.batchId;
                    const analyzed = variantAnalyzedAt(entry.status, entry.completedAt);
                    return (
                      <tr key={entry.id} className="border-b border-border/60">
                        <td className="py-2 pr-3">
                          {batchId ? (
                            <button type="button" className="text-left text-primary hover:underline" onClick={() => navigate(`/workbench/batches/${batchId}`)}>
                              Single variant
                            </button>
                          ) : (
                            <span>Single variant</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">-</td>
                        <td className="py-2 pr-3 font-medium">{entry.input.gene}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{entry.input.hgvsC}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{entry.input.transcript || "—"}</td>
                        <td className="py-2 pr-3">
                          {acmg ? <Badge variant="outline" className={cn(entryChip, classificationTone(acmg.class))}>{acmg.label}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-3">
                          {entry.institutionalLabel ? <Badge variant="outline" className={cn(entryChip, classificationTone(entry.institutionalClass))}>{entry.institutionalLabel}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant="outline" className={cn(entryChip, workbenchStatusClass(entry.status))}>{workbenchStatusLabel(entry.status)}</Badge>
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{analyzed === null ? "—" : formatDateTime(new Date(analyzed))}</td>
                        <td className="py-2 pr-3">
                          <Button size="sm" variant="outline" className={entryAction} onClick={() => setLogRunId(entry.id)}>Log</Button>
                        </td>
                        <td className="py-2 text-right">
                          {entry.status === "succeeded" && batchId ? (
                            <div className="flex justify-end gap-2">
                              {canCurate ? (
                                <Button size="sm" variant="outline" className={entryAction} disabled={rerunEntry.isPending} onClick={() => rerunEntry.mutate({ organizationId: activeOrganizationId!, runId: entry.id })}>
                                  Re-run
                                </Button>
                              ) : null}
                              <Button size="sm" variant="outline" className={entryReview} onClick={() => navigate(`/workbench/batches/${batchId}/review/${entry.id}`)}>
                                Review
                              </Button>
                            </div>
                          ) : canCurate && (entry.status === "queued" || entry.status === "failed" || entry.status === "cancelled") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className={entryRun}
                              disabled={releaseEntry.isPending}
                              onClick={() => releaseEntry.mutate({ organizationId: activeOrganizationId!, runId: entry.id })}
                            >
                              Run
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <ReusedAnalysisDialog notice={reusedNotice} onClose={() => setReusedNotice(null)} />
      <AnalysisLogDialog
        organizationId={activeOrganizationId || 0}
        target={(() => {
          const entry = entries.data?.find(item => item.id === logRunId);
          return entry ? { runId: entry.id, gene: entry.input.gene, hgvs: entry.input.hgvsC, status: entry.status } : null;
        })()}
        onClose={() => setLogRunId(null)}
      />
    </div>
  );
}

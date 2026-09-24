import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOrganization } from "@/contexts/OrganizationContext";
import { formatDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { SINGLE_VARIANTS_BATCH } from "@shared/curation/workbench";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation, useParams } from "wouter";
import { AnalysisLogDialog } from "./AnalysisLogDialog";
import { DeleteEntryDialog } from "./DeleteEntryDialog";
import { ReusedAnalysisDialog, type ReusedAnalysisNotice } from "./ReusedAnalysisDialog";
import { BatchNameField } from "./BatchNameField";
import { VariantIntakeForm } from "./intake";
import { SortHeader, compareSortValues, type SortDirection } from "./sort";
import { classificationTone, entryAction, entryChip, entryReview, variantAnalyzedAt, workbenchStatusClass, workbenchStatusLabel } from "./status";

type BatchSortKey = "index" | "gene" | "hgvs" | "transcript" | "lab" | "case" | "acmg" | "status" | "analyzed";

export default function BatchPage() {
  const params = useParams<{ batchId: string }>();
  const batchId = Number(params.batchId);
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const canCurate = hasPermission("curation:run");
  const [sort, setSort] = useState<{ key: BatchSortKey; direction: SortDirection } | null>(null);
  const [logRunId, setLogRunId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; gene: string; hgvsC: string } | null>(null);
  const [reusedNotice, setReusedNotice] = useState<ReusedAnalysisNotice | null>(null);

  const batch = trpc.workbench.getBatch.useQuery(
    { organizationId: activeOrganizationId || 0, batchId },
    {
      enabled: Boolean(activeOrganizationId && batchId),
      refetchInterval: query =>
        query.state.data?.entries.some(entry => entry.status === "queued" || entry.status === "loading" || entry.status === "running") ? 4000 : false,
    }
  );
  const rerunEntry = trpc.workbench.rerunEntry.useMutation({
    onSuccess: async () => {
      await batch.refetch();
      toast.success("Re-run queued. It starts as soon as the classifier is free.");
    },
    onError: error => toast.error(error.message),
  });
  const runBatch = trpc.workbench.runBatch.useMutation({
    onSuccess: async result => {
      await batch.refetch();
      toast.success(
        result.workerStarted
          ? "Classifier starting. The first variant shows Loading, then Running. The rest stay Queued."
          : "Run started. One variant runs at a time. The rest stay Queued."
      );
    },
    onError: error => toast.error(error.message),
  });
  const renameBatch = trpc.workbench.renameBatch.useMutation({
    onSuccess: async () => {
      await batch.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const addEntry = trpc.workbench.addEntry.useMutation({
    onSuccess: async (result, variables) => {
      await batch.refetch();
      if (result.reused) {
        setReusedNotice({ gene: variables.gene, hgvsC: variables.hgvsC, ...result.reused });
        return;
      }
      toast.success("Variant added to the batch.");
    },
    onError: error => toast.error(error.message),
  });
  const deleteEntry = trpc.workbench.deleteEntry.useMutation({
    onSuccess: async () => {
      setDeleteTarget(null);
      setLogRunId(null);
      await batch.refetch();
      toast.success("Entry deleted.");
    },
    onError: error => toast.error(error.message),
  });

  const source = batch.data?.entries;
  const sortedEntries = useMemo(() => {
    const indexed = (source ?? []).map((entry, index) => ({ entry, index }));
    if (!sort) return indexed;
    const value = (item: (typeof indexed)[number], key: BatchSortKey): string | number | null => {
      const entry = item.entry;
      if (key === "index") return item.index;
      if (key === "gene") return entry.input.gene;
      if (key === "hgvs") return entry.input.hgvsC;
      if (key === "transcript") return entry.input.transcript || "";
      if (key === "lab") return entry.input.labId || "";
      if (key === "case") return entry.input.externalCaseId || "";
      if (key === "acmg") return entry.summary?.classification?.label || "";
      if (key === "status") return workbenchStatusLabel(entry.status);
      return variantAnalyzedAt(entry.status, entry.completedAt);
    };
    return [...indexed].sort((left, right) => compareSortValues(value(left, sort.key), value(right, sort.key), sort.direction));
  }, [source, sort]);
  const toggleSort = (key: BatchSortKey) => {
    setSort(current => (current?.key === key && current.direction === "asc" ? { key, direction: "desc" } : { key, direction: "asc" }));
  };

  if (batch.isLoading) return <p className="text-sm text-muted-foreground">Loading batch…</p>;
  if (batch.isError) {
    return <StatePanel type="error" title="Failed to load batch" description={batch.error.message} onRetry={() => { void batch.refetch(); }} />;
  }
  if (!batch.data) return null;
  const { batch: record, entries } = batch.data;
  const done = entries.filter(entry => entry.status === "succeeded");
  const loading = entries.some(entry => entry.status === "loading");
  const running = entries.some(entry => entry.status === "running");
  const runnable = entries.filter(entry => entry.status === "queued" || entry.status === "failed" || entry.status === "cancelled").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Variant workbench"
        title={record.name}
        heading={
          canCurate && record.name !== SINGLE_VARIANTS_BATCH ? (
            <h1 className="font-display text-2xl font-semibold tracking-[-0.025em] text-foreground sm:text-3xl">
              <BatchNameField
                name={record.name}
                disabled={renameBatch.isPending}
                className="font-display text-2xl font-semibold tracking-[-0.025em] sm:text-3xl"
                onSave={name => renameBatch.mutate({ organizationId: activeOrganizationId!, batchId: record.id, name })}
              />
            </h1>
          ) : undefined
        }
        description={`${entries.length} entries`}
        actions={
          <div className="flex gap-2">
            {canCurate ? (
              <Button
                disabled={runBatch.isPending || loading || running || runnable === 0}
                onClick={() => runBatch.mutate({ organizationId: activeOrganizationId!, batchId: record.id })}
              >
                {runBatch.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {loading ? "Loading…" : running ? "Running…" : "Run batch"}
              </Button>
            ) : null}
            {done[0] ? (
              <Button className="bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500" onClick={() => navigate(`/workbench/batches/${record.id}/review/${done[0]!.id}`)}>Review batch</Button>
            ) : null}
            <Button variant="outline" onClick={() => navigate("/workbench")}>
              <ArrowLeft className="mr-2 size-4" />
              All entries
            </Button>
          </div>
        }
      />

      {canCurate ? (
        <Card>
          <CardContent className="space-y-4 p-5">
            <div>
              <h2 className="font-display text-lg font-semibold">Add variant</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Enter gene and HGVSc. Added variants stay Queued until you press Run batch. The classifier runs one at a time: the first shows Loading, then Running, and the rest stay Queued.
              </p>
            </div>
            <VariantIntakeForm
              extras
              pending={addEntry.isPending}
              submitLabel="Add to batch"
              onSubmit={values => addEntry.mutate({ organizationId: activeOrganizationId!, batchId: record.id, ...values })}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Entries</h2>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries yet — add a variant above.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b">
                    {([
                      ["index", "#"],
                      ["gene", "Gene"],
                      ["hgvs", "HGVSc"],
                      ["transcript", "Transcript"],
                      ["lab", "Lab ID"],
                      ["case", "Case"],
                      ["acmg", "ACMG"],
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
                  {sortedEntries.map(({ entry, index }) => {
                    const acmg = entry.summary?.classification;
                    const analyzed = variantAnalyzedAt(entry.status, entry.completedAt);
                    return (
                      <tr key={entry.id} className="border-b border-border/60">
                        <td className="py-2 pr-3 text-muted-foreground">{index + 1}</td>
                        <td className="py-2 pr-3 font-medium">{entry.input.gene}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{entry.input.hgvsC}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{entry.input.transcript || "—"}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{entry.input.labId || "—"}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{entry.input.externalCaseId || "—"}</td>
                        <td className="py-2 pr-3">
                          {acmg ? <Badge variant="outline" className={cn(entryChip, classificationTone(acmg.class))}>{acmg.label}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant="outline" className={cn(entryChip, workbenchStatusClass(entry.status))}>{workbenchStatusLabel(entry.status)}</Badge>
                          {entry.status === "failed" && entry.error?.message ? (
                            <p className="mt-1 max-w-xs text-[10px] text-rose-700">{entry.error.message}</p>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{analyzed === null ? "—" : formatDateTime(new Date(analyzed))}</td>
                        <td className="py-2 pr-3">
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" className={entryAction} onClick={() => setLogRunId(entry.id)}>Log</Button>
                            {canCurate ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className={entryAction}
                                disabled={deleteEntry.isPending || entry.status === "loading" || entry.status === "running"}
                                onClick={() => setDeleteTarget({ id: entry.id, gene: entry.input.gene, hgvsC: entry.input.hgvsC })}
                              >
                                Delete
                              </Button>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-2 text-right">
                          {entry.status === "succeeded" ? (
                            <div className="flex justify-end gap-2">
                              {canCurate ? (
                                <Button size="sm" variant="outline" className={entryAction} disabled={rerunEntry.isPending} onClick={() => rerunEntry.mutate({ organizationId: activeOrganizationId!, runId: entry.id })}>
                                  Re-run
                                </Button>
                              ) : null}
                              <Button size="sm" variant="outline" className={entryReview} onClick={() => navigate(`/workbench/batches/${record.id}/review/${entry.id}`)}>
                                Review
                              </Button>
                            </div>
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
      <DeleteEntryDialog
        entry={deleteTarget}
        pending={deleteEntry.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget || !activeOrganizationId) return;
          if (logRunId === deleteTarget.id) setLogRunId(null);
          deleteEntry.mutate({ organizationId: activeOrganizationId, runId: deleteTarget.id });
        }}
      />
      <AnalysisLogDialog
        organizationId={activeOrganizationId || 0}
        target={(() => {
          const entry = entries.find(item => item.id === logRunId);
          return entry ? { runId: entry.id, gene: entry.input.gene, hgvs: entry.input.hgvsC, status: entry.status } : null;
        })()}
        onClose={() => setLogRunId(null)}
      />
    </div>
  );
}

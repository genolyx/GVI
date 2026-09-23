import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { isSingleVariantBatch } from "@shared/curation/workbench";
import { ArrowRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { VariantIntakeForm } from "./intake";
import { classificationTone, workbenchStatusClass, workbenchStatusLabel } from "./status";

export default function WorkbenchHomePage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [batchName, setBatchName] = useState("");
  const [search, setSearch] = useState("");
  const canRead = hasPermission("variant:read");
  const canCurate = hasPermission("curation:run");

  const entries = trpc.workbench.listEntries.useQuery(
    { organizationId: activeOrganizationId || 0 },
    {
      enabled: Boolean(activeOrganizationId && canRead),
      refetchInterval: query =>
        query.state.data?.some(entry => entry.status === "queued" || entry.status === "running") ? 4000 : false,
    }
  );
  const batches = trpc.workbench.listBatches.useQuery(
    { organizationId: activeOrganizationId || 0 },
    { enabled: Boolean(activeOrganizationId && canRead) }
  );

  const runSingle = trpc.workbench.runSingle.useMutation({
    onSuccess: async result => {
      await entries.refetch();
      toast.success("Variant added to Single variants.");
      navigate(`/workbench/batches/${result.batchId}`);
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

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = entries.data ?? [];
    if (!query) return rows;
    return rows.filter(entry => {
      const summary = entry.summary?.classification;
      const hay = [
        isSingleVariantBatch(entry.batchName) ? "single variant" : "batch",
        entry.input.gene,
        entry.input.hgvsC,
        entry.input.transcript,
        entry.status,
        entry.input.labId,
        entry.input.externalCaseId,
        summary?.label,
        entry.institutionalLabel,
        String(entry.id),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(query);
    });
  }, [entries.data, search]);

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
                  Gene and HGVSc are required. It is added to the shared Single variants batch and queued for the classifier.
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
                  Name a batch, then add as many variants as you want and open Review on each one.
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
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="font-display text-lg font-semibold">All entries</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {visible.length === (entries.data?.length ?? 0)
                  ? `${entries.data?.length ?? 0} entries`
                  : `${visible.length} of ${entries.data?.length ?? 0} entries`}
              </p>
            </div>
            <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Gene, HGVSc, transcript, single or batch, status…" className="sm:max-w-xs" aria-label="Search entries" />
          </div>
          {entries.isError ? (
            <StatePanel compact type="error" title="Failed to load entries" description={entries.error.message} onRetry={() => { void entries.refetch(); }} />
          ) : entries.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading entries…</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No entries yet. Run a single variant or open a batch and add one.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3">Type</th>
                    <th className="py-2 pr-3">Gene</th>
                    <th className="py-2 pr-3">HGVSc</th>
                    <th className="py-2 pr-3">Transcript</th>
                    <th className="py-2 pr-3">ACMG</th>
                    <th className="py-2 pr-3">Institutional</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map(entry => {
                    const acmg = entry.summary?.classification;
                    const single = isSingleVariantBatch(entry.batchName);
                    return (
                      <tr key={entry.id} className="border-b border-border/60">
                        <td className="py-2 pr-3">
                          <button
                            type="button"
                            className="text-left text-primary hover:underline"
                            onClick={() => navigate(`/workbench/batches/${entry.batchId}`)}
                          >
                            {single ? "Single variant" : "Batch"}
                          </button>
                        </td>
                        <td className="py-2 pr-3 font-medium">{entry.input.gene}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{entry.input.hgvsC}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{entry.input.transcript || "—"}</td>
                        <td className="py-2 pr-3">
                          {acmg ? <Badge variant="outline" className={classificationTone(acmg.class)}>{acmg.label}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-3">
                          {entry.institutionalLabel ? <Badge variant="outline" className={classificationTone(entry.institutionalClass)}>{entry.institutionalLabel}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant="outline" className={workbenchStatusClass(entry.status)}>{workbenchStatusLabel(entry.status)}</Badge>
                        </td>
                        <td className="py-2 text-right">
                          {entry.status === "succeeded" ? (
                            <Button size="sm" variant="outline" onClick={() => navigate(`/workbench/batches/${entry.batchId}/review/${entry.id}`)}>
                              Review
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
    </div>
  );
}

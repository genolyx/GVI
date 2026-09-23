import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { useLocation, useParams } from "wouter";
import { VariantIntakeForm } from "./intake";
import { classificationTone, workbenchStatusClass, workbenchStatusLabel } from "./status";

export default function BatchPage() {
  const params = useParams<{ batchId: string }>();
  const batchId = Number(params.batchId);
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const canCurate = hasPermission("curation:run");

  const batch = trpc.workbench.getBatch.useQuery(
    { organizationId: activeOrganizationId || 0, batchId },
    {
      enabled: Boolean(activeOrganizationId && batchId),
      refetchInterval: query =>
        query.state.data?.entries.some(entry => entry.status === "queued" || entry.status === "running") ? 4000 : false,
    }
  );
  const addEntry = trpc.workbench.addEntry.useMutation({
    onSuccess: async () => {
      await batch.refetch();
      toast.success("Variant added to the batch.");
    },
    onError: error => toast.error(error.message),
  });

  if (batch.isLoading) return <p className="text-sm text-muted-foreground">Loading batch…</p>;
  if (batch.isError) {
    return <StatePanel type="error" title="Failed to load batch" description={batch.error.message} onRetry={() => { void batch.refetch(); }} />;
  }
  if (!batch.data) return null;
  const { batch: record, entries } = batch.data;
  const done = entries.filter(entry => entry.status === "succeeded");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Variant workbench"
        title={record.name}
        description={`${entries.length} entries`}
        actions={
          <div className="flex gap-2">
            {done[0] ? (
              <Button onClick={() => navigate(`/workbench/batches/${record.id}/review/${done[0]!.id}`)}>Review batch</Button>
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
                Enter gene and HGVSc. Transcript, protein change, lab id, case id, PMIDs, and notes are optional. Each added variant is queued for the classifier.
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
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Gene</th>
                    <th className="py-2 pr-3">HGVSc</th>
                    <th className="py-2 pr-3">Transcript</th>
                    <th className="py-2 pr-3">Lab ID</th>
                    <th className="py-2 pr-3">Case</th>
                    <th className="py-2 pr-3">ACMG</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => {
                    const acmg = entry.summary?.classification;
                    return (
                      <tr key={entry.id} className="border-b border-border/60">
                        <td className="py-2 pr-3 text-muted-foreground">{index + 1}</td>
                        <td className="py-2 pr-3 font-medium">{entry.input.gene}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{entry.input.hgvsC}</td>
                        <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{entry.input.transcript || "—"}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{entry.input.labId || "—"}</td>
                        <td className="py-2 pr-3 text-muted-foreground">{entry.input.externalCaseId || "—"}</td>
                        <td className="py-2 pr-3">
                          {acmg ? <Badge variant="outline" className={classificationTone(acmg.class)}>{acmg.label}</Badge> : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant="outline" className={workbenchStatusClass(entry.status)}>{workbenchStatusLabel(entry.status)}</Badge>
                          {entry.status === "failed" && entry.error?.message ? (
                            <p className="mt-1 max-w-xs text-[10px] text-rose-700">{entry.error.message}</p>
                          ) : null}
                        </td>
                        <td className="py-2 text-right">
                          {entry.status === "succeeded" ? (
                            <Button size="sm" variant="outline" onClick={() => navigate(`/workbench/batches/${record.id}/review/${entry.id}`)}>
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

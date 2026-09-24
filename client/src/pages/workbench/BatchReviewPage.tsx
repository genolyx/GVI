import { SamVcPanel } from "@/components/curation/SamVcPanel";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { INSTITUTIONAL_CLASSIFICATIONS } from "@shared/curation/institutional";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation, useParams } from "wouter";
import { workbenchStatusLabel } from "./status";

export default function BatchReviewPage() {
  const params = useParams<{ batchId: string; runId: string }>();
  const batchId = Number(params.batchId);
  const runId = Number(params.runId);
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const canEdit = hasPermission("interpretation:edit");

  const batch = trpc.workbench.getBatch.useQuery(
    { organizationId: activeOrganizationId || 0, batchId },
    { enabled: Boolean(activeOrganizationId && batchId) }
  );
  const entries = batch.data?.entries ?? [];
  const index = entries.findIndex(item => item.id === runId);
  const entry = index >= 0 ? entries[index] : undefined;
  const documentQuery = trpc.curation.document.useQuery(
    { organizationId: activeOrganizationId || 0, runId },
    { enabled: Boolean(activeOrganizationId && runId && entry?.status === "succeeded") }
  );
  const saveInstitutional = trpc.workbench.setInstitutional.useMutation({
    onSuccess: async () => {
      await batch.refetch();
      toast.success("Institutional classification saved.");
    },
    onError: error => toast.error(error.message),
  });

  const prev = index > 0 ? entries[index - 1] : undefined;
  const next = index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined;

  const [label, setLabel] = useState("");
  useEffect(() => {
    setLabel(entry?.institutionalLabel || "");
  }, [entry?.id, entry?.institutionalLabel]);

  const go = (id: number) => navigate(`/workbench/batches/${batchId}/review/${id}`);

  if (batch.isLoading) return <p className="text-sm text-muted-foreground">Loading review…</p>;
  if (batch.isError) {
    return <StatePanel type="error" title="Failed to load batch" description={batch.error.message} onRetry={() => { void batch.refetch(); }} />;
  }
  if (!entry || !batch.data) {
    return (
      <StatePanel
        type="empty"
        title="Entry not in this batch"
        description="The review link does not match a variant in this batch."
        action={<Button variant="outline" onClick={() => navigate(`/workbench/batches/${batchId}`)}>Back to batch</Button>}
      />
    );
  }

  const acmg = documentQuery.data?.document.acmg.classification;
  const criteria = documentQuery.data?.document.acmg.criteria ?? [];
  const input = entry.input;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/80 bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => navigate(`/workbench/batches/${batchId}`)}>
              ← {batch.data.batch.name}
            </button>
            <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
              {input.gene} <code className="font-mono text-2xl">{input.hgvsC}</code>
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Entry {index + 1} of {entries.length}
              {input.externalCaseId ? ` · Case ${input.externalCaseId}` : ""}
              {input.transcript ? ` · ${input.transcript}` : ""}
              {documentQuery.data?.document.meta.engineVersion ? ` · Classifier ${documentQuery.data.document.meta.engineVersion}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {entries.length > 1 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Variant
                <select
                  aria-label="Select variant in this batch"
                  className="h-9 max-w-xs rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                  value={entry.id}
                  onChange={event => go(Number(event.target.value))}
                >
                  {entries.map(item => (
                    <option key={item.id} value={item.id} disabled={item.status !== "succeeded"}>
                      {item.input.gene} {item.input.hgvsC} ({workbenchStatusLabel(item.status)})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Button variant="outline" disabled={!prev} onClick={() => prev && go(prev.id)}>
              <ChevronLeft className="mr-1 size-4" />
              Prev
            </Button>
            <Button variant="outline" disabled={!next} onClick={() => next && go(next.id)}>
              Next
              <ChevronRight className="ml-1 size-4" />
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border/80 bg-card p-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Variant</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill label="Gene" value={input.gene} />
          <Pill label="HGVSc" value={input.hgvsC} mono />
          {input.transcript ? <Pill label="Transcript" value={input.transcript} mono /> : null}
          {input.hgvsP ? <Pill label="p." value={input.hgvsP} mono /> : null}
          {input.labId ? <Pill label="Lab ID" value={input.labId} /> : null}
          {input.externalCaseId ? <Pill label="Case" value={input.externalCaseId} /> : null}
          {input.pmids ? <Pill label="PMIDs" value={input.pmids} /> : null}
        </div>
      </section>

      {entry.status !== "succeeded" ? (
        <StatePanel
          type={entry.status === "failed" ? "error" : "empty"}
          title={`Classifier has not completed (status: ${workbenchStatusLabel(entry.status)})`}
          description={entry.error?.message || "Return to the batch and wait for the run to finish."}
          action={<Button variant="outline" onClick={() => navigate(`/workbench/batches/${batchId}`)}><ArrowLeft className="mr-2 size-4" />Batch</Button>}
        />
      ) : documentQuery.isError ? (
        <StatePanel type="error" title="Failed to load annotation" description={documentQuery.error.message} onRetry={() => { void documentQuery.refetch(); }} />
      ) : documentQuery.isLoading || !documentQuery.data ? (
        <p className="text-sm text-muted-foreground">Loading classification detail…</p>
      ) : (
        <section className="rounded-2xl border border-border/80 bg-card p-5 text-card-foreground">
          <h2 className="font-display text-xl font-semibold">
            Evaluation Results <span className="ml-2 text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-300">saved run · {documentQuery.data.document.meta.engineVersion}</span>
          </h2>
          <div className="mt-4">
            <SamVcPanel document={documentQuery.data.document} />
          </div>
          <div className="mt-6 grid gap-6 border-t border-border pt-5 lg:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Institutional classification</p>
              <select
                aria-label="Institutional classification"
                className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
                value={label}
                disabled={!canEdit || saveInstitutional.isPending}
                onChange={event => setLabel(event.target.value)}
              >
                <option value="">Not set</option>
                {INSTITUTIONAL_CLASSIFICATIONS.map(option => (
                  <option key={option.label} value={option.label}>{option.label}</option>
                ))}
              </select>
              {canEdit ? (
                <Button
                  className="mt-3"
                  variant="secondary"
                  disabled={saveInstitutional.isPending}
                  onClick={() => saveInstitutional.mutate({ organizationId: activeOrganizationId!, runId: entry.id, label })}
                >
                  Save
                </Button>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">You can view this call. Saving requires interpretation permission.</p>
              )}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">ACMG logic</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {criteria.length ? criteria.map(criterion => (
                  <span key={criterion.code} title={criterion.rationale} className={`rounded-md border px-2 py-1 font-mono text-xs font-semibold ${criterion.direction === "pathogenic" ? "border-rose-500/40 text-rose-700 dark:text-rose-300" : "border-sky-500/40 text-sky-700 dark:text-sky-300"}`}>
                    {criterion.code}
                  </span>
                )) : <span className="text-sm italic text-muted-foreground">No criteria met</span>}
              </div>
              <p className="mt-3 text-lg font-semibold">{acmg?.label || "—"}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function Pill({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <strong className={mono ? "font-mono font-semibold" : "font-semibold"}>{value}</strong>
    </span>
  );
}

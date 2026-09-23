import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { CurationDocumentView } from "@/components/curation/CurationDocumentView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, ChevronRight, Loader2, Microscope, PlayCircle, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { formatDateTime } from "@/lib/datetime";

/**
 * Ad-hoc curation: one variant by gene + HGVS, with no case and no VCF.
 *
 * This is SAM-VC's day-to-day workflow and the reason `curation_runs.variantId` and
 * `caseId` are nullable. It intentionally bypasses case intake — a curator checking
 * a single variant should not have to create a patient record first — while still
 * running inside an organization so tenancy and audit still apply.
 */

const STATUS_STYLES: Record<string, string> = {
  queued: "border-slate-200 bg-slate-50 text-slate-600",
  running: "border-sky-200 bg-sky-50 text-sky-700",
  succeeded: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  cancelled: "border-slate-200 bg-slate-50 text-slate-500",
};

export default function CuratePage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [gene, setGene] = useState("");
  const [hgvsC, setHgvsC] = useState("");
  const [transcript, setTranscript] = useState("");
  const [clinicalNotes, setClinicalNotes] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const canCurate = hasPermission("curation:run");

  const runs = trpc.curation.list.useQuery(
    { organizationId: activeOrganizationId || 0, limit: 30 },
    {
      enabled: Boolean(activeOrganizationId && hasPermission("variant:read")),
      refetchInterval: query =>
        query.state.data?.some(run => run.status === "queued" || run.status === "running")
          ? 4000
          : false,
    }
  );

  // Ad-hoc runs are the ones with no stored variant behind them.
  const adHocRuns = runs.data?.filter(run => run.variantId === null) ?? [];

  const documentQuery = trpc.curation.document.useQuery(
    { organizationId: activeOrganizationId || 0, runId: selectedRunId || 0 },
    { enabled: Boolean(activeOrganizationId && selectedRunId) }
  );

  // A mistyped HGVS otherwise occupies a worker for minutes with no way to stop it.
  const cancel = trpc.curation.cancel.useMutation({
    onSuccess: async () => {
      await runs.refetch();
      toast.success("Curation cancelled.");
    },
    onError: error => toast.error(error.message),
  });

  const enqueue = trpc.curation.enqueueAdHoc.useMutation({
    onSuccess: async result => {
      await runs.refetch();
      setSelectedRunId(result.id);
      toast.success(`Queued ${gene} ${hgvsC} for curation.`);
      setHgvsC("");
      setTranscript("");
    },
    onError: error => toast.error(error.message),
  });

  if (!canCurate) {
    return (
      <div className="space-y-7">
        <PageHeader
          eyebrow="Deep curation"
          title="Curate a variant"
          description="Run the SAM-VC curation engine against a single variant."
        />
        <StatePanel
          type="forbidden"
          title="You do not have permission to run curation"
          description="Ask your organization administrator for a role that includes the curation:run action."
          action={
            <Button variant="outline" onClick={() => navigate("/")}>
              Dashboard
            </Button>
          }
        />
      </div>
    );
  }

  const canSubmit = gene.trim().length > 0 && hgvsC.trim().length > 2 && !enqueue.isPending;
  const selected = adHocRuns.find(run => run.id === selectedRunId);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Deep curation"
        title="Curate a variant"
        description="Gene symbol plus HGVSc — no case or VCF required. Results are advisory and are not attached to any report until a clinician says so."
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(340px,.8fr)_minmax(520px,1.2fr)]">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-2">
              <Label htmlFor="gene">Gene symbol</Label>
              <Input
                id="gene"
                value={gene}
                onChange={event => setGene(event.target.value.toUpperCase())}
                placeholder="AMT"
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="hgvsC">HGVSc</Label>
              <Input
                id="hgvsC"
                value={hgvsC}
                onChange={event => setHgvsC(event.target.value)}
                placeholder="c.878-1G>A"
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="transcript">Transcript (optional)</Label>
              <Input
                id="transcript"
                value={transcript}
                onChange={event => setTranscript(event.target.value)}
                placeholder="NM_000481.4"
                className="font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                Leave blank to let the engine pick the canonical transcript.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Clinical context (optional)</Label>
              <Textarea
                id="notes"
                value={clinicalNotes}
                onChange={event => setClinicalNotes(event.target.value)}
                className="min-h-24 text-xs"
                placeholder="Phenotype, inheritance pattern, prior findings."
              />
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
              <p className="text-[10px] leading-4 text-amber-900">
                The engine analyses on GRCh38. A GRCh37 case is lifted at enqueue; gene + HGVSc is transcript-relative and does not change. A run takes a few minutes.
              </p>
            </div>

            <Button
              className="w-full"
              disabled={!canSubmit}
              onClick={() =>
                enqueue.mutate({
                  organizationId: activeOrganizationId!,
                  gene: gene.trim(),
                  hgvsC: hgvsC.trim(),
                  transcript: transcript.trim() || undefined,
                  clinicalNotes: clinicalNotes.trim() || undefined,
                })
              }
            >
              {enqueue.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <PlayCircle className="mr-2 size-4" />
              )}
              Curate variant
            </Button>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardContent className="p-5">
            <p className="mb-3 text-sm font-semibold">Recent ad-hoc curations</p>
            {runs.isError ? (
              <StatePanel
                compact
                type="error"
                title="Failed to load curation runs"
                description={runs.error.message}
                onRetry={() => {
                  void runs.refetch();
                }}
              />
            ) : runs.isLoading ? (
              <Skeleton className="h-40" />
            ) : !adHocRuns.length ? (
              <div className="rounded-xl border border-dashed py-12 text-center">
                <Microscope className="mx-auto size-7 text-muted-foreground/35" />
                <p className="mt-3 text-xs font-medium">No ad-hoc curations yet</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Submit a gene and HGVSc on the left to start one.
                </p>
              </div>
            ) : (
              <ScrollArea className="max-h-52 pr-2">
                <div className="space-y-1.5">
                  {adHocRuns.map(run => (
                    <div
                      key={run.id}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors ${
                        selectedRunId === run.id
                          ? "border-primary/40 bg-primary/[0.055]"
                          : "border-border/60 hover:bg-muted/40"
                      }`}
                    >
                      <button
                        onClick={() => setSelectedRunId(run.id)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                        aria-label={`Show curation for ${run.input.gene} ${run.input.hgvsC}`}
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[11px] font-semibold">
                            {run.input.gene} {run.input.hgvsC}
                          </p>
                          <p className="mt-0.5 text-[9px] text-muted-foreground">
                            {formatDateTime(run.queuedAt)}
                            {run.summary?.classification
                              ? ` · ${run.summary.classification.label}`
                              : ""}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[9px] ${STATUS_STYLES[run.status] || ""}`}
                        >
                          {run.status}
                        </Badge>
                      </button>
                      {run.status === "queued" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 px-1.5 text-muted-foreground hover:text-destructive"
                          aria-label={`Cancel curation for ${run.input.gene} ${run.input.hgvsC}`}
                          disabled={cancel.isPending}
                          onClick={() =>
                            cancel.mutate({ organizationId: activeOrganizationId!, runId: run.id })
                          }
                        >
                          <X className="size-3.5" />
                        </Button>
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}

            {selected ? (
              <div className="mt-4 border-t border-border/70 pt-4">
                {selected.status !== "succeeded" ? (
                  <p className="rounded-lg border border-dashed py-6 text-center text-[10px] text-muted-foreground">
                    {selected.status === "failed"
                      ? `Run failed: ${selected.error?.message || "no detail recorded"}`
                      : `Run is ${selected.status}. Results appear here when it finishes.`}
                  </p>
                ) : documentQuery.isError ? (
                  <StatePanel
                    compact
                    type="error"
                    title="Failed to load the curation document"
                    description={documentQuery.error.message}
                    onRetry={() => {
                      void documentQuery.refetch();
                    }}
                  />
                ) : documentQuery.isLoading || !documentQuery.data ? (
                  <Skeleton className="h-64" />
                ) : (
                  <CurationDocumentView
                    document={documentQuery.data.document}
                    organizationId={activeOrganizationId || 0}
                    documentHash={documentQuery.data.documentHash}
                    height={520}
                  />
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

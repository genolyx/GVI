import { StatePanel } from "@/components/StatePanel";
import { CurationDocumentView } from "@/components/curation/CurationDocumentView";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, Loader2, PlayCircle, RotateCw } from "lucide-react";
import { toast } from "sonner";

/**
 * Curation tab in the Workbench: the run lifecycle for one case-bound variant.
 *
 * This component owns queueing, polling and failure reporting. Rendering the resulting
 * document is `CurationDocumentView`'s job, shared with the ad-hoc `/curate` page so the
 * two screens cannot drift apart.
 */
export function CurationPanel({
  organizationId,
  variantId,
  interpretationId,
  canCurate,
  canEdit,
  onMerged,
}: {
  organizationId: number;
  variantId: number;
  interpretationId: number | undefined;
  canCurate: boolean;
  canEdit: boolean;
  onMerged: () => void | Promise<unknown>;
}) {
  const runs = trpc.curation.list.useQuery(
    { organizationId, variantId, limit: 5 },
    {
      enabled: Boolean(organizationId && variantId),
      // Poll while work is outstanding so the panel fills in without a manual reload.
      refetchInterval: query =>
        query.state.data?.some(run => run.status === "queued" || run.status === "loading" || run.status === "running")
          ? 4000
          : false,
    }
  );

  const latest = runs.data?.[0];
  const succeeded = runs.data?.find(run => run.status === "succeeded");

  const documentQuery = trpc.curation.document.useQuery(
    { organizationId, runId: succeeded?.id || 0 },
    { enabled: Boolean(succeeded?.id) }
  );

  const enqueue = trpc.curation.enqueueVariant.useMutation({
    onSuccess: async result => {
      await runs.refetch();
      toast.success(result.deduped ? "Already in the curation queue." : "Queued for curation.");
    },
    onError: error => toast.error(error.message),
  });

  const header = (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold">Deep curation</p>
        <p className="text-[10px] text-muted-foreground">
          SAM-VC engine · advisory only · a clinician signs
        </p>
      </div>
      {canCurate ? (
        <Button
          size="sm"
          variant="outline"
          disabled={enqueue.isPending || latest?.status === "queued" || latest?.status === "loading" || latest?.status === "running"}
          onClick={() => enqueue.mutate({ organizationId, variantId })}
        >
          {enqueue.isPending ? (
            <Loader2 className="mr-2 size-3.5 animate-spin" />
          ) : succeeded ? (
            <RotateCw className="mr-2 size-3.5" />
          ) : (
            <PlayCircle className="mr-2 size-3.5" />
          )}
          {succeeded ? "Re-curate" : "Curate variant"}
        </Button>
      ) : null}
    </div>
  );

  if (runs.isError) {
    return (
      <div>
        {header}
        <StatePanel
          compact
          type="error"
          title="Failed to load curation runs"
          description={runs.error.message}
          onRetry={() => {
            void runs.refetch();
          }}
        />
      </div>
    );
  }

  if (runs.isLoading) {
    return (
      <div>
        {header}
        <Skeleton className="h-[440px]" />
      </div>
    );
  }

  if (!runs.data?.length) {
    return (
      <div>
        {header}
        <div className="rounded-xl border border-dashed py-14 text-center">
          <PlayCircle className="mx-auto size-7 text-muted-foreground/35" />
          <p className="mt-3 text-xs font-medium">Not curated yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[10px] leading-4 text-muted-foreground">
            Curation resolves splicing consequences, database evidence and ACMG criteria for this
            variant. It takes a few minutes per variant.
          </p>
        </div>
      </div>
    );
  }

  const inFlight = latest && (latest.status === "queued" || latest.status === "loading" || latest.status === "running");

  return (
    <div>
      {header}

      <div className="mb-3 space-y-2">
        {inFlight ? (
          <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2">
            <Loader2 className="size-3.5 animate-spin text-sky-700" />
            <p className="text-[10px] text-sky-900">
              Curation {latest.status} (attempt {latest.attempt}/{latest.maxAttempts}).
            </p>
          </div>
        ) : null}
        {latest?.status === "failed" ? (
          <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-rose-700" />
            <p className="text-[10px] leading-4 text-rose-900">
              Last run failed: {latest.error?.message || "no detail recorded"}
            </p>
          </div>
        ) : null}
      </div>

      {!succeeded ? (
        <p className="rounded-lg border border-dashed py-6 text-center text-[10px] text-muted-foreground">
          No completed curation to display yet.
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
        <Skeleton className="h-[440px]" />
      ) : (
        <CurationDocumentView
          document={documentQuery.data.document}
          organizationId={organizationId}
          documentHash={documentQuery.data.documentHash}
          accept={
            canEdit && interpretationId
              ? { interpretationId, onAccepted: onMerged }
              : undefined
          }
        />
      )}
    </div>
  );
}

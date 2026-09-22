import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Filter, Loader2, PlayCircle, Send } from "lucide-react";
import { toast } from "sonner";

export const TRIAGE_TIERS = ["t1_curate", "t2_review", "t3_filtered"] as const;
export type TriageTier = (typeof TRIAGE_TIERS)[number];

export const TRIAGE_LABELS: Record<TriageTier, string> = {
  t1_curate: "T1 · Curate",
  t2_review: "T2 · Review",
  t3_filtered: "T3 · Filtered",
};

const TIER_STYLES: Record<TriageTier, string> = {
  t1_curate: "border-rose-200 bg-rose-50 text-rose-700",
  t2_review: "border-amber-200 bg-amber-50 text-amber-700",
  t3_filtered: "border-slate-200 bg-slate-50 text-slate-500",
};

/** Small tier chip for a variant row, with the firing rules as its tooltip. */
export function TriageTierBadge({
  tier,
  score,
  reasons,
}: {
  tier: TriageTier | null;
  score: number | null;
  reasons: string[] | null;
}) {
  if (!tier) {
    return (
      <Badge variant="outline" className="text-[9px] text-muted-foreground">
        Untriaged
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={`text-[9px] ${TIER_STYLES[tier]}`}
      title={reasons?.length ? reasons.join("\n") : undefined}
    >
      {TRIAGE_LABELS[tier].split(" · ")[0]}
      {score === null ? "" : ` ${score}`}
    </Badge>
  );
}

/**
 * Triage controls above the variant list.
 *
 * Triage is what makes curation affordable — the engine takes minutes per variant,
 * so a case has to be narrowed before any of it is queued. This surfaces the pass
 * and the one-click "send this tier" action next to the list it filters.
 */
export function TriageBar({
  organizationId,
  caseId,
  tierFilter,
  onTierFilterChange,
  counts,
  canCurate,
  onChanged,
}: {
  organizationId: number;
  caseId: number;
  tierFilter: TriageTier | "all";
  onTierFilterChange: (tier: TriageTier | "all") => void;
  counts: Record<TriageTier | "untriaged", number>;
  canCurate: boolean;
  onChanged: () => void | Promise<unknown>;
}) {
  const runTriage = trpc.curation.runTriage.useMutation({
    onSuccess: async result => {
      await onChanged();
      toast.success(
        `Triaged ${result.scanned} variants — ${result.counts.t1_curate} to curate, ${result.counts.t2_review} to review, ${result.counts.t3_filtered} filtered.`
      );
    },
    onError: error => toast.error(error.message),
  });

  const enqueueTier = trpc.curation.enqueueTier.useMutation({
    onSuccess: async result => {
      await onChanged();
      if (!result.queued.length && !result.skipped.length) {
        toast.info("No variants in this tier to queue.");
        return;
      }
      toast.success(
        `Queued ${result.queued.length} variant(s) for curation${
          result.skipped.length ? `; skipped ${result.skipped.length}.` : "."
        }`
      );
    },
    onError: error => toast.error(error.message),
  });

  const queueableTier: TriageTier = tierFilter === "all" ? "t1_curate" : tierFilter;
  const queueableCount = counts[queueableTier];

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-muted/10 px-4 py-2.5">
      <Filter className="size-3.5 text-muted-foreground" />
      <button
        onClick={() => onTierFilterChange("all")}
        className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
          tierFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
        }`}
      >
        All tiers
      </button>
      {TRIAGE_TIERS.map(tier => (
        <button
          key={tier}
          onClick={() => onTierFilterChange(tier)}
          className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
            tierFilter === tier
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {TRIAGE_LABELS[tier]} ({counts[tier]})
        </button>
      ))}
      {counts.untriaged > 0 ? (
        <span className="text-[10px] text-muted-foreground">{counts.untriaged} untriaged</span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {canCurate ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[10px]"
              disabled={runTriage.isPending}
              onClick={() => runTriage.mutate({ organizationId, caseId })}
            >
              {runTriage.isPending ? (
                <Loader2 className="mr-1.5 size-3 animate-spin" />
              ) : (
                <PlayCircle className="mr-1.5 size-3" />
              )}
              Run triage
            </Button>
            <Button
              size="sm"
              className="h-7 text-[10px]"
              disabled={enqueueTier.isPending || queueableCount === 0}
              onClick={() =>
                enqueueTier.mutate({ organizationId, caseId, tier: queueableTier })
              }
              title={
                queueableCount === 0
                  ? "No variants in this tier"
                  : `Send ${queueableCount} ${TRIAGE_LABELS[queueableTier]} variant(s) to the curation engine`
              }
            >
              {enqueueTier.isPending ? (
                <Loader2 className="mr-1.5 size-3 animate-spin" />
              ) : (
                <Send className="mr-1.5 size-3" />
              )}
              Curate {TRIAGE_LABELS[queueableTier].split(" · ")[0]} ({queueableCount})
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

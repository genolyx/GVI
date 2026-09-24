import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = {
  draft: "Draft",
  queued: "Queued",
  running: "Running",
  review_ready: "Review Ready",
  in_review: "In Review",
  reported: "Reported",
  failed: "Failed",
  completed: "Completed",
  signed: "Signed",
  amended: "Amended",
  approved: "Approved",
  unreviewed: "Unreviewed",
  reviewing: "Reviewing",
  reviewed: "Reviewed",
  flagged: "Flagged",
};

const TONES: Record<string, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  queued: "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  running: "border-cyan-500/30 bg-cyan-500/10 text-cyan-900 dark:text-cyan-200",
  review_ready: "border-violet-500/30 bg-violet-500/10 text-violet-900 dark:text-violet-200",
  in_review: "border-indigo-500/30 bg-indigo-500/10 text-indigo-900 dark:text-indigo-200",
  reported: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  signed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  approved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-300",
  flagged: "border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-300",
};

export function ClinicalStatus({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium", TONES[status] || TONES.draft, className)}>
      {LABELS[status] || status}
    </Badge>
  );
}

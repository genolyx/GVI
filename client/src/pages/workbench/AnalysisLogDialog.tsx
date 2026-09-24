import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { Check, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type LogTarget = {
  runId: number;
  gene: string;
  hgvs: string;
  status: string;
};

function logStamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function phaseLabel(status: string) {
  if (status === "queued") return "Queue";
  if (status === "loading") return "Loading";
  if (status === "running") return "Analysis";
  if (status === "succeeded") return "Complete";
  if (status === "failed" || status === "merge_failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "merged") return "Interpretation";
  return status;
}

function isLive(status: string) {
  return status === "queued" || status === "loading" || status === "running";
}

export function AnalysisLogDialog({
  organizationId,
  target,
  onClose,
}: {
  organizationId: number;
  target: LogTarget | null;
  onClose: () => void;
}) {
  const open = target !== null;
  const [shown, setShown] = useState<LogTarget | null>(target);
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);
  const live = shown ? isLive(shown.status) : false;
  const events = trpc.curation.events.useQuery(
    { organizationId, runId: shown?.runId || 0 },
    {
      enabled: open && organizationId > 0 && Boolean(shown?.runId),
      refetchInterval: live ? 2000 : false,
    }
  );
  const scroller = useRef<HTMLDivElement>(null);
  const lines = [...(events.data ?? [])].sort((left, right) => {
    const time = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return time || left.id - right.id;
  });

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [lines.length, open, live]);

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden border-border bg-card p-0 text-card-foreground sm:max-w-3xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="size-2.5 rounded-full bg-rose-500" />
          <span className="size-2.5 rounded-full bg-amber-400" />
          <span className="size-2.5 rounded-full bg-emerald-500" />
          <DialogTitle className="flex flex-1 items-center justify-center gap-2 font-mono text-sm font-medium text-foreground">
            <Terminal className="size-3.5 text-muted-foreground" />
            Analysis Log
            {live ? <span className="rounded-md bg-sky-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-sky-700 dark:text-sky-300">Live</span> : null}
          </DialogTitle>
        </div>
          <DialogDescription className="sr-only">
            {shown ? `Classifier log for ${shown.gene} ${shown.hgvs}` : "Classifier log"}
          </DialogDescription>
          {shown ? (
            <p className="border-b border-border px-4 py-2 font-mono text-xs text-muted-foreground">
              {shown.gene} {shown.hgvs}
            </p>
          ) : null}
        <div ref={scroller} className="max-h-[420px] min-h-48 overflow-auto bg-card px-4 py-3 font-mono text-[12px] leading-6">
          {events.isLoading ? (
            <p className="text-muted-foreground">Loading log…</p>
          ) : events.isError ? (
            <p className="text-rose-700 dark:text-rose-300">{events.error.message}</p>
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground">
              {live ? "Waiting for the classifier to write the first line." : "No log was recorded for this variant."}
            </p>
          ) : (
            lines.map(line => {
              const done = line.status === "succeeded" || line.status === "merged";
              const failed = line.status === "failed" || line.status === "merge_failed";
              return (
                <div key={line.id} className="flex items-start gap-3">
                  <span className="shrink-0 text-muted-foreground">{logStamp(line.createdAt)}</span>
                  {done ? (
                    <Check className="mt-1 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <span className={`mt-2 size-1.5 shrink-0 rounded-full ${failed ? "bg-rose-500" : live && line === lines[lines.length - 1] ? "animate-pulse bg-sky-500" : "bg-sky-500"}`} />
                  )}
                  <span className={`w-10 shrink-0 text-right tabular-nums ${done ? "text-emerald-700 dark:text-emerald-300" : "text-foreground"}`}>{line.progressPercent}%</span>
                  <span className={`shrink-0 ${failed ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-400"}`}>{phaseLabel(line.status)}</span>
                  <span className={done ? "text-emerald-800 dark:text-emerald-200" : failed ? "text-rose-800 dark:text-rose-200" : "text-foreground/80"}>{line.message}</span>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

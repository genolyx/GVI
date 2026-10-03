import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { entryChip } from "@/pages/workbench/status";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const stateLabel: Record<string, string> = {
  running: "Running",
  loading: "Loading",
  idle: "Idle",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
};

function stateClass(state: string): string {
  if (state === "running") return "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300";
  if (state === "loading" || state === "starting") return "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200";
  if (state === "idle") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
  if (state === "stopping") return "border-border bg-muted text-muted-foreground";
  return "border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-300";
}

function detailFor(worker: { state: string; variant: string | null; hidden: boolean }): string {
  if (worker.variant) return worker.variant;
  if (worker.hidden) return "Classifying a variant";
  if (worker.state === "loading") return "Loading reference data";
  if (worker.state === "idle") return "Waiting for the next variant";
  if (worker.state === "starting") return "Process is starting";
  if (worker.state === "stopping") return "Finishing the current variant";
  return "Not running";
}

export function ClassifierWorkersPanel({
  organizationId,
  editable = false,
}: {
  organizationId?: number;
  editable?: boolean;
}) {
  const query = trpc.classifierWorkers.status.useQuery(
    { organizationId },
    { refetchInterval: 3000 }
  );
  const setCount = trpc.classifierWorkers.setCount.useMutation({
    onSuccess: () => {
      void query.refetch();
    },
    onError: error => toast.error(error.message),
  });
  const data = query.data;

  return (
    <Card className="clinical-card border-border/70 shadow-none">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="font-display text-base">Classifier workers</CardTitle>
          <CardDescription className="text-xs">
            Each worker classifies one variant at a time. Worker-0 through Worker-{Math.max((data?.desired ?? 1) - 1, 0)} run together.
          </CardDescription>
        </div>
        {editable && data ? (
          <div className="flex items-center gap-2">
            {setCount.isPending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            <Select
              value={String(data.desired)}
              disabled={setCount.isPending}
              onValueChange={value => setCount.mutate({ count: Number(value) })}
            >
              <SelectTrigger size="sm" className="w-[9rem] text-xs" aria-label="Classifier worker count">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: data.max - data.min + 1 }, (_, offset) => data.min + offset).map(count => (
                  <SelectItem key={count} value={String(count)}>
                    {count} {count === 1 ? "worker" : "workers"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="px-0">
        {query.isLoading ? (
          <div className="space-y-3 px-5 pb-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : query.isError ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">{query.error.message}</p>
        ) : (
          <div className="divide-y divide-border/60">
            {data?.workers.map(worker => (
              <div key={worker.name} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-4 px-5 py-3.5">
                <span className="font-mono text-sm font-semibold">{worker.name}</span>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{detailFor(worker)}</span>
                <Badge variant="outline" className={cn(entryChip, stateClass(worker.state))}>
                  {worker.state === "running" || worker.state === "loading" ? (
                    <Loader2 className="mr-1.5 size-3 animate-spin" />
                  ) : null}
                  {stateLabel[worker.state] || worker.state}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

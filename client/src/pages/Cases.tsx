import { ClinicalStatus } from "@/components/ClinicalStatus";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { entryAction, entryChip, entryRun } from "./workbench/status";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { ArrowRight, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/datetime";

function CaseRunControl({
  caseId,
  caseNumber,
  status,
  organizationId,
}: {
  caseId: number;
  caseNumber: string;
  status: string;
  organizationId: number;
}) {
  const utils = trpc.useUtils();
  const rerun = trpc.cases.rerun.useMutation({
    onSuccess: async () => {
      toast.success("Analysis queued again.");
      await utils.cases.list.invalidate();
      await utils.cases.get.invalidate();
      await utils.cases.timeline.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const stop = trpc.cases.stop.useMutation({
    onSuccess: async () => {
      toast.success("Analysis stopped.");
      await utils.cases.list.invalidate();
      await utils.cases.get.invalidate();
      await utils.cases.timeline.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const active = status === "queued" || status === "running";
  const canRun = status === "failed" || status === "review_ready";
  if (!canRun && !active) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={active ? entryAction : entryRun}
      disabled={rerun.isPending || stop.isPending}
      onClick={event => {
        event.stopPropagation();
        if (active) {
          if (!window.confirm(`Stop analysis for ${caseNumber}?`)) return;
          stop.mutate({ organizationId, caseId });
          return;
        }
        if (
          status === "review_ready" &&
          !window.confirm(
            `Run ${caseNumber} again from the original VCF? Stored variants will be replaced.`
          )
        ) {
          return;
        }
        rerun.mutate({ organizationId, caseId });
      }}
    >
      {rerun.isPending ? "Running…" : stop.isPending ? "Stopping…" : active ? "Stop" : "Run"}
    </Button>
  );
}

export default function CasesPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<"all" | "germline" | "somatic">("all");
  const [trackRunning, setTrackRunning] = useState(false);
  const query = trpc.cases.list.useQuery(
    { organizationId: activeOrganizationId || 0, search: search || undefined, purpose: purpose === "all" ? undefined : purpose, limit: 100 },
    {
      enabled: Boolean(activeOrganizationId && hasPermission("case:read")),
      refetchInterval: trackRunning ? 2000 : false,
    }
  );
  useEffect(() => {
    setTrackRunning(
      Boolean(
        query.data?.some(
          item => item.status === "queued" || item.status === "running"
        )
      )
    );
  }, [query.data]);

  if (!hasPermission("case:read")) return <div className="space-y-7"><PageHeader eyebrow="Case management" title="Cases" description="Manage clinical cases within the organization boundary." /><StatePanel type="forbidden" title="You do not have permission to view cases" description="Ask your organization administrator for a role that includes the case:read action." /></div>;
  if (query.isError) return <div className="space-y-7"><PageHeader eyebrow="Case management" title="Cases" description="Failed to load the case list for this organization." actions={hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />New case</Button> : undefined} /><StatePanel type="error" title="Failed to load cases" description={query.error.message} onRetry={() => { void query.refetch(); }} /></div>;

  const emptyState = <div className="p-4"><StatePanel compact type="empty" title="No cases match your criteria" description="Adjust your search term or purpose filter, or start a new analysis request." action={hasPermission("case:create") ? <Button variant="outline" onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />New case</Button> : undefined} /></div>;

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Case management"
        title="Cases"
        description="Manage VCF interpretation requests and clinical review status within the organization boundary."
        actions={hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />New case</Button> : undefined}
      />
      <div className="clinical-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row">
          <div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search by case number or patient alias" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by case number or patient alias" className="pl-9" /></div>
          <div className="flex rounded-lg border border-border bg-muted/40 p-1">{(["all", "germline", "somatic"] as const).map(item => <button key={item} onClick={() => setPurpose(item)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium sm:flex-none ${purpose === item ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{item === "all" ? "All" : item}</button>)}</div>
        </div>

        <div className="sm:hidden">
          {query.isLoading ? <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28" />)}</div> : query.data?.length ? <div className="divide-y divide-border/60">{query.data.map(item => <div key={item.id} className="flex items-start gap-3 p-4"><button onClick={() => navigate(`/cases/${item.id}`)} className="flex min-w-0 flex-1 items-start gap-3 text-left"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${item.purpose === "germline" ? "bg-primary" : "bg-[#8fa3b8]"}`} /><span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-3"><span><span className="block text-xs">{item.caseNumber}</span><span className="mt-1 block text-xs text-muted-foreground">{item.patientAlias} · {item.projectName}</span></span><ClinicalStatus status={item.status} /></span><span className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span className="uppercase">{item.purpose} · {item.inputType} · {item.referenceBuild}</span><ArrowRight className="size-3.5" /></span></span></button>{hasPermission("case:edit") ? <CaseRunControl caseId={item.id} caseNumber={item.caseNumber} status={item.status} organizationId={activeOrganizationId || 0} /> : null}</div>)}</div> : emptyState}
        </div>

        <div className="hidden overflow-x-auto sm:block">
          {query.isLoading ? <div className="space-y-3 p-5">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-12" />)}</div> : query.data?.length ? <table className="w-full min-w-[820px] text-left text-xs"><thead><tr className="border-b border-border/70 bg-muted/35 text-xs uppercase tracking-wide text-muted-foreground"><th className="px-5 py-3 font-medium">Case</th><th className="px-5 py-3 font-medium">Project</th><th className="px-5 py-3 font-medium">Purpose</th><th className="px-5 py-3 font-medium">Input</th><th className="px-5 py-3 font-medium">Build / Panel</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 font-medium">Run</th><th className="px-5 py-3 font-medium">Updated</th></tr></thead><tbody className="divide-y divide-border/60">{query.data.map(item => <tr key={item.id} tabIndex={0} role="link" aria-label={`Open case ${item.caseNumber}`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/cases/${item.id}`); } }} onClick={() => navigate(`/cases/${item.id}`)} className="cursor-pointer hover:bg-muted/45 focus-visible:bg-primary/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><td className="px-5 py-3.5"><p>{item.caseNumber}</p><p className="mt-1 text-muted-foreground">{item.patientAlias}</p></td><td className="px-5 py-3.5">{item.projectName}</td><td className="px-5 py-3.5"><Badge variant="outline" className={cn(entryChip, "capitalize", item.purpose === "germline" ? "border-primary/30 bg-primary/10 text-primary" : "border-violet-500/30 bg-violet-500/10 text-violet-800 dark:text-violet-200")}>{item.purpose}</Badge></td><td className="px-5 py-3.5 uppercase">{item.inputType}</td><td className="px-5 py-3.5"><p>{item.referenceBuild}</p><p className="mt-1 max-w-[180px] truncate text-muted-foreground">{item.panelName || "—"}</p></td><td className="px-5 py-3.5"><ClinicalStatus status={item.status} /></td><td className="px-5 py-3.5" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{hasPermission("case:edit") ? <CaseRunControl caseId={item.id} caseNumber={item.caseNumber} status={item.status} organizationId={activeOrganizationId || 0} /> : <span className="text-muted-foreground">—</span>}</td><td className="px-5 py-3.5 text-muted-foreground">{formatDateTime(item.updatedAt)}</td></tr>)}</tbody></table> : emptyState}
        </div>
      </div>
    </div>
  );
}

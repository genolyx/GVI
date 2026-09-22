import { ClinicalStatus } from "@/components/ClinicalStatus";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { ArrowRight, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { formatDateTime } from "@/lib/datetime";

export default function CasesPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<"all" | "germline" | "somatic">("all");
  const query = trpc.cases.list.useQuery(
    { organizationId: activeOrganizationId || 0, search: search || undefined, purpose: purpose === "all" ? undefined : purpose, limit: 100 },
    { enabled: Boolean(activeOrganizationId && hasPermission("case:read")) }
  );

  if (!hasPermission("case:read")) return <div className="space-y-7"><PageHeader eyebrow="Case management" title="Cases" description="Manage clinical cases within the organization boundary." /><StatePanel type="forbidden" title="You do not have permission to view cases" description="Ask your organization administrator for a role that includes the case:read action." /></div>;
  if (query.isError) return <div className="space-y-7"><PageHeader eyebrow="Case management" title="Cases" description="Failed to load the case list for this organization." actions={hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />New case</Button> : undefined} /><StatePanel type="error" title="Failed to load cases" description={query.error.message} onRetry={() => { void query.refetch(); }} /></div>;

  const emptyState = <div className="p-4"><StatePanel compact type="empty" title="No cases match your criteria" description="Adjust your search term or purpose filter, or start a new analysis request." action={hasPermission("case:create") ? <Button variant="outline" onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />New case</Button> : undefined} /></div>;

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Case management"
        title="Cases"
        description="Manage FASTQ/VCF analysis requests and clinical review status within the organization boundary."
        actions={hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />New case</Button> : undefined}
      />
      <div className="clinical-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row">
          <div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search by case number or patient alias" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by case number or patient alias" className="pl-9" /></div>
          <div className="flex rounded-lg border border-border bg-muted/40 p-1">{(["all", "germline", "somatic"] as const).map(item => <button key={item} onClick={() => setPurpose(item)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium sm:flex-none ${purpose === item ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{item === "all" ? "All" : item}</button>)}</div>
        </div>

        <div className="sm:hidden">
          {query.isLoading ? <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28" />)}</div> : query.data?.length ? <div className="divide-y divide-border/60">{query.data.map(item => <button key={item.id} onClick={() => navigate(`/cases/${item.id}`)} className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${item.purpose === "germline" ? "bg-primary" : "bg-[#8fa3b8]"}`} /><span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-3"><span><span className="block font-mono text-xs font-semibold">{item.caseNumber}</span><span className="mt-1 block text-[11px] text-muted-foreground">{item.patientAlias} · {item.projectName}</span></span><ClinicalStatus status={item.status} /></span><span className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground"><span className="uppercase">{item.purpose} · {item.inputType} · {item.referenceBuild}</span><ArrowRight className="size-3.5" /></span></span></button>)}</div> : emptyState}
        </div>

        <div className="hidden overflow-x-auto sm:block">
          {query.isLoading ? <div className="space-y-3 p-5">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-12" />)}</div> : query.data?.length ? <table className="w-full min-w-[820px] text-left"><thead><tr className="border-b border-border/70 bg-muted/35 text-[10px] uppercase tracking-wider text-muted-foreground"><th className="px-5 py-3 font-semibold">Case</th><th className="px-5 py-3 font-semibold">Project</th><th className="px-5 py-3 font-semibold">Purpose</th><th className="px-5 py-3 font-semibold">Input</th><th className="px-5 py-3 font-semibold">Build / Panel</th><th className="px-5 py-3 font-semibold">Status</th><th className="px-5 py-3 font-semibold">Updated</th></tr></thead><tbody className="divide-y divide-border/60">{query.data.map(item => <tr key={item.id} tabIndex={0} role="link" aria-label={`Open case ${item.caseNumber}`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/cases/${item.id}`); } }} onClick={() => navigate(`/cases/${item.id}`)} className="cursor-pointer hover:bg-muted/45 focus-visible:bg-primary/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><td className="px-5 py-3.5"><p className="font-mono text-xs font-medium">{item.caseNumber}</p><p className="mt-1 text-[11px] text-muted-foreground">{item.patientAlias}</p></td><td className="px-5 py-3.5 text-xs">{item.projectName}</td><td className="px-5 py-3.5"><span className={`inline-flex items-center gap-2 text-xs capitalize ${item.purpose === "germline" ? "text-teal-700" : "text-violet-700"}`}><span className={`size-1.5 rounded-full ${item.purpose === "germline" ? "bg-teal-500" : "bg-violet-500"}`} />{item.purpose}</span></td><td className="px-5 py-3.5 font-mono text-[11px] uppercase">{item.inputType}</td><td className="px-5 py-3.5"><p className="text-xs">{item.referenceBuild}</p><p className="mt-1 max-w-[180px] truncate text-[10px] text-muted-foreground">{item.panelName || "—"}</p></td><td className="px-5 py-3.5"><ClinicalStatus status={item.status} /></td><td className="px-5 py-3.5 text-[11px] text-muted-foreground">{formatDateTime(item.updatedAt)}</td></tr>)}</tbody></table> : emptyState}
        </div>
      </div>
    </div>
  );
}

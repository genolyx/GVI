import { ClinicalStatus } from "@/components/ClinicalStatus";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { FileSignature, Hash } from "lucide-react";
import { useLocation } from "wouter";

export default function ReportsPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const query = trpc.reports.list.useQuery({ organizationId: activeOrganizationId || 0 }, { enabled: Boolean(activeOrganizationId && hasPermission("report:read")) });
  if (!hasPermission("report:read")) return <div className="space-y-7"><PageHeader eyebrow="Clinical reporting" title="Reports" description="Track clinical report versions within the organization boundary." /><StatePanel type="forbidden" title="You do not have permission to view reports" description="Ask your organization administrator for a role that includes the report:read action." /></div>;
  return <div className="space-y-7"><PageHeader eyebrow="Clinical reporting" title="Reports" description="Track every version from draft through electronically signed immutable snapshot and amendment." />
    <div className="grid gap-3">{query.isError ? <StatePanel type="error" title="Failed to load reports" description={query.error.message} onRetry={() => { void query.refetch(); }} /> : query.isLoading ? Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-24" />) : query.data?.length ? query.data.map(report => <button key={report.id} onClick={() => navigate(`/reports/${report.id}`)} className="clinical-card grid gap-4 p-5 text-left transition hover:border-primary/25 hover:shadow-sm sm:grid-cols-[1fr_auto] sm:items-center"><div className="flex min-w-0 items-start gap-4"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/8 text-primary"><FileSignature className="size-4" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-semibold">{report.title}</p><ClinicalStatus status={report.status} /></div><p className="mt-1 font-mono text-[10px] text-muted-foreground">{report.caseNumber} · v{report.version} · {report.purpose}</p>{report.snapshotHash ? <p className="mt-2 flex items-center gap-1 truncate font-mono text-[9px] text-muted-foreground"><Hash className="size-3" />{report.snapshotHash}</p> : null}</div></div><div className="text-right text-[10px] text-muted-foreground"><p>{new Date(report.updatedAt).toLocaleString()}</p>{report.signedAt ? <p className="mt-1 text-emerald-700">Signed {new Date(report.signedAt).toLocaleDateString()}</p> : null}</div></button>) : <StatePanel type="empty" title="No reports yet" description="Generate a report draft from approved variants in the case detail page." action={<Button variant="outline" onClick={() => navigate("/cases")}>View cases</Button>} />}</div>
  </div>;
}

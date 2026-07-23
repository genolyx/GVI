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

export default function CasesPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [purpose, setPurpose] = useState<"all" | "germline" | "somatic">("all");
  const query = trpc.cases.list.useQuery(
    { organizationId: activeOrganizationId || 0, search: search || undefined, purpose: purpose === "all" ? undefined : purpose, limit: 100 },
    { enabled: Boolean(activeOrganizationId && hasPermission("case:read")) }
  );

  if (!hasPermission("case:read")) return <div className="space-y-7"><PageHeader eyebrow="Case management" title="케이스" description="조직 범위의 임상 케이스를 관리합니다." /><StatePanel type="forbidden" title="케이스 조회 권한이 없습니다" description="조직 관리자에게 case:read 액션이 포함된 역할을 요청하십시오." /></div>;
  if (query.isError) return <div className="space-y-7"><PageHeader eyebrow="Case management" title="케이스" description="조직 범위의 케이스 목록을 불러오지 못했습니다." actions={hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />분석 의뢰</Button> : undefined} /><StatePanel type="error" title="케이스를 불러오지 못했습니다" description={query.error.message} onRetry={() => { void query.refetch(); }} /></div>;

  const emptyState = <div className="p-4"><StatePanel compact type="empty" title="조건에 맞는 케이스가 없습니다" description="검색어나 검사 목적 필터를 조정하거나 새 분석 의뢰를 시작하십시오." action={hasPermission("case:create") ? <Button variant="outline" onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />분석 의뢰</Button> : undefined} /></div>;

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Case management"
        title="케이스"
        description="조직 경계 안에서 FASTQ·VCF 분석 의뢰와 임상 검토 상태를 관리합니다."
        actions={hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")}><Plus className="mr-2 size-4" />분석 의뢰</Button> : undefined}
      />
      <div className="clinical-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border/70 p-4 sm:flex-row">
          <div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="케이스 번호 또는 환자 별칭 검색" value={search} onChange={event => setSearch(event.target.value)} placeholder="케이스 번호 또는 환자 별칭 검색" className="pl-9" /></div>
          <div className="flex rounded-lg border border-border bg-muted/40 p-1">{(["all", "germline", "somatic"] as const).map(item => <button key={item} onClick={() => setPurpose(item)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium sm:flex-none ${purpose === item ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{item === "all" ? "전체" : item}</button>)}</div>
        </div>

        <div className="sm:hidden">
          {query.isLoading ? <div className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28" />)}</div> : query.data?.length ? <div className="divide-y divide-border/60">{query.data.map(item => <button key={item.id} onClick={() => navigate(`/cases/${item.id}`)} className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-muted/40"><span className={`mt-1.5 size-2 shrink-0 rounded-full ${item.purpose === "germline" ? "bg-teal-500" : "bg-violet-500"}`} /><span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-3"><span><span className="block font-mono text-xs font-semibold">{item.caseNumber}</span><span className="mt-1 block text-[11px] text-muted-foreground">{item.patientAlias} · {item.projectName}</span></span><ClinicalStatus status={item.status} /></span><span className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground"><span className="uppercase">{item.purpose} · {item.inputType} · {item.referenceBuild}</span><ArrowRight className="size-3.5" /></span></span></button>)}</div> : emptyState}
        </div>

        <div className="hidden overflow-x-auto sm:block">
          {query.isLoading ? <div className="space-y-3 p-5">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-12" />)}</div> : query.data?.length ? <table className="w-full min-w-[820px] text-left"><thead><tr className="border-b border-border/70 bg-muted/35 text-[10px] uppercase tracking-wider text-muted-foreground"><th className="px-5 py-3 font-semibold">Case</th><th className="px-5 py-3 font-semibold">Project</th><th className="px-5 py-3 font-semibold">Purpose</th><th className="px-5 py-3 font-semibold">Input</th><th className="px-5 py-3 font-semibold">Build / Panel</th><th className="px-5 py-3 font-semibold">Status</th><th className="px-5 py-3 font-semibold">Updated</th></tr></thead><tbody className="divide-y divide-border/60">{query.data.map(item => <tr key={item.id} tabIndex={0} role="link" aria-label={`${item.caseNumber} 케이스 열기`} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/cases/${item.id}`); } }} onClick={() => navigate(`/cases/${item.id}`)} className="cursor-pointer hover:bg-muted/45 focus-visible:bg-primary/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><td className="px-5 py-3.5"><p className="font-mono text-xs font-medium">{item.caseNumber}</p><p className="mt-1 text-[11px] text-muted-foreground">{item.patientAlias}</p></td><td className="px-5 py-3.5 text-xs">{item.projectName}</td><td className="px-5 py-3.5"><span className={`inline-flex items-center gap-2 text-xs capitalize ${item.purpose === "germline" ? "text-teal-700" : "text-violet-700"}`}><span className={`size-1.5 rounded-full ${item.purpose === "germline" ? "bg-teal-500" : "bg-violet-500"}`} />{item.purpose}</span></td><td className="px-5 py-3.5 font-mono text-[11px] uppercase">{item.inputType}</td><td className="px-5 py-3.5"><p className="text-xs">{item.referenceBuild}</p><p className="mt-1 max-w-[180px] truncate text-[10px] text-muted-foreground">{item.panelName || "—"}</p></td><td className="px-5 py-3.5"><ClinicalStatus status={item.status} /></td><td className="px-5 py-3.5 text-[11px] text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</td></tr>)}</tbody></table> : emptyState}
        </div>
      </div>
    </div>
  );
}

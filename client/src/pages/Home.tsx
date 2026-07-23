import { ClinicalStatus } from "@/components/ClinicalStatus";
import { MetricCard } from "@/components/MetricCard";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { Activity, ArrowRight, Building2, CheckCircle2, ClipboardCheck, Dna, FileSignature, FolderPlus, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

function OrganizationOnboarding() {
  const { refetchOrganizations } = useOrganization();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const create = trpc.organizations.create.useMutation({
    onSuccess: async () => {
      await refetchOrganizations();
      toast.success("조직 워크스페이스가 생성되었습니다.");
    },
    onError: error => toast.error(error.message),
  });
  return (
    <div className="mx-auto grid min-h-[72vh] max-w-5xl items-center gap-10 lg:grid-cols-[1.15fr_.85fr]">
      <div>
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary"><ShieldCheck className="size-3.5" />격리된 임상 워크스페이스</div>
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-[-0.04em] sm:text-5xl">근거에서 판정까지,<br /><span className="text-primary">전문가가 통제합니다.</span></h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">첫 조직을 생성하면 모든 케이스, 변이, 근거와 보고서가 해당 조직 경계 안에서 관리됩니다.</p>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">{["Composite tenant keys", "Action-level RBAC", "Immutable sign-out"].map(item => <div key={item} className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="size-4 text-emerald-600" />{item}</div>)}</div>
      </div>
      <div className="clinical-panel p-7">
        <div className="mb-6 grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><Building2 className="size-5" /></div>
        <h2 className="font-display text-xl font-semibold">조직 워크스페이스 생성</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">조직명과 URL에 사용할 안전한 식별자를 입력하십시오.</p>
        <div className="mt-6 space-y-4">
          <div className="space-y-2"><Label htmlFor="org-name">조직명</Label><Input id="org-name" value={name} onChange={event => { const value = event.target.value; setName(value); setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} placeholder="Genolyx Clinical Lab" /></div>
          <div className="space-y-2"><Label htmlFor="org-slug">조직 식별자</Label><Input id="org-slug" value={slug} onChange={event => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="genolyx-lab" /></div>
          <Button className="w-full" size="lg" disabled={create.isPending || name.length < 2 || slug.length < 2} onClick={() => create.mutate({ name, slug, dataRegion: "KR" })}>{create.isPending ? "생성 중…" : "보안 워크스페이스 시작"}<ArrowRight className="ml-2 size-4" /></Button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { activeOrganizationId, activeOrganization, isLoading, hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const summary = trpc.dashboard.summary.useQuery({ organizationId: activeOrganizationId || 0 }, { enabled: Boolean(activeOrganizationId) });
  const projects = trpc.projects.list.useQuery({ organizationId: activeOrganizationId || 0 }, { enabled: Boolean(activeOrganizationId) });
  const createProject = trpc.projects.create.useMutation({
    onSuccess: async () => { await projects.refetch(); setProjectOpen(false); setProjectName(""); setProjectCode(""); toast.success("프로젝트가 생성되었습니다."); },
    onError: error => toast.error(error.message),
  });
  if (isLoading) return <div className="grid gap-5"><Skeleton className="h-20" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-36" />)}</div></div>;
  if (!activeOrganizationId || !activeOrganization) return <OrganizationOnboarding />;
  if (summary.isError || projects.isError) return <div className="space-y-7"><PageHeader eyebrow="Clinical operations" title="임상 유전체 대시보드" description={`${activeOrganization.name}의 조직 범위 데이터를 불러오지 못했습니다.`} /><StatePanel type="error" title="대시보드를 불러오지 못했습니다" description={summary.error?.message || projects.error?.message || "네트워크 상태와 조직 접근 권한을 확인한 뒤 다시 시도하십시오."} onRetry={() => { void Promise.all([summary.refetch(), projects.refetch()]); }} /></div>;
  const data = summary.data;
  return (
    <div className="space-y-7">
      <PageHeader eyebrow="Clinical operations" title="임상 유전체 대시보드" description={`${activeOrganization.name}의 분석 상태와 임상 활동을 조직 격리 범위 안에서 확인합니다.`} badge={activeOrganization.role} actions={<><Dialog open={projectOpen} onOpenChange={setProjectOpen}><DialogTrigger asChild><Button variant="outline"><FolderPlus className="mr-2 size-4" />프로젝트</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>새 프로젝트</DialogTitle><DialogDescription>케이스를 분리 관리할 조직 내부 프로젝트를 만듭니다.</DialogDescription></DialogHeader><div className="grid gap-4 py-3"><div className="space-y-2"><Label>프로젝트명</Label><Input value={projectName} onChange={event => { const value = event.target.value; setProjectName(value); setProjectCode(value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")); }} /></div><div className="space-y-2"><Label>프로젝트 코드</Label><Input value={projectCode} onChange={event => setProjectCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))} /></div></div><DialogFooter><Button disabled={createProject.isPending || !projectName || !projectCode} onClick={() => createProject.mutate({ organizationId: activeOrganizationId, name: projectName, code: projectCode })}>생성</Button></DialogFooter></DialogContent></Dialog>{hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")} disabled={!projects.data?.length}><Plus className="mr-2 size-4" />분석 의뢰</Button> : null}</>} />
      {!projects.isLoading && !projects.data?.length ? <div className="clinical-card flex flex-col gap-4 border-dashed border-primary/30 bg-primary/[0.035] p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold">첫 프로젝트가 필요합니다</p><p className="mt-1 text-xs text-muted-foreground">케이스를 생성하기 전에 조직 내부 데이터 범위를 정의하십시오.</p></div><Button size="sm" onClick={() => setProjectOpen(true)}>프로젝트 생성</Button></div> : null}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="전체 케이스" value={data?.totalCases ?? 0} caption="조직 격리 범위" icon={ClipboardCheck} tone="slate" /><MetricCard label="검토 대기" value={data?.reviewQueue ?? 0} caption="review ready · in review" icon={Activity} tone="violet" /><MetricCard label="진행 중 분석" value={data?.activeAnalyses ?? 0} caption="queued · running" icon={Dna} tone="teal" /><MetricCard label="보고 완료" value={data?.signedOrReported ?? 0} caption="전자서명 완료 케이스" icon={FileSignature} tone="amber" /></section>
      <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card className="clinical-card border-border/70 shadow-none"><CardHeader className="flex-row items-center justify-between"><div><CardTitle className="font-display text-base">최근 케이스</CardTitle><p className="mt-1 text-xs text-muted-foreground">마지막 변경 시각 기준</p></div><Button variant="ghost" size="sm" onClick={() => navigate("/cases")}>전체 보기<ArrowRight className="ml-1 size-3.5" /></Button></CardHeader><CardContent className="px-0"><div className="divide-y divide-border/60">{summary.isLoading ? Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="mx-5 my-3 h-12" />) : data?.recentCases.length ? data.recentCases.map(item => <button key={item.id} onClick={() => navigate(`/cases/${item.id}`)} className="grid w-full grid-cols-[1fr_auto] items-center gap-4 px-5 py-3.5 text-left hover:bg-muted/50 sm:grid-cols-[1.1fr_.8fr_.65fr_auto]"><div><p className="font-mono text-xs font-medium">{item.caseNumber}</p><p className="mt-1 text-[11px] text-muted-foreground">{item.patientAlias}</p></div><p className="hidden text-xs text-muted-foreground sm:block">{item.projectName}</p><span className="hidden text-xs capitalize sm:block">{item.purpose}</span><ClinicalStatus status={item.status} /></button>) : <div className="px-5 py-14 text-center"><ClipboardCheck className="mx-auto size-7 text-muted-foreground/40" /><p className="mt-3 text-sm font-medium">아직 접수된 케이스가 없습니다</p></div>}</div></CardContent></Card>
        <Card className="clinical-card border-border/70 shadow-none"><CardHeader><CardTitle className="font-display text-base">분석 상태 분포</CardTitle><p className="text-xs text-muted-foreground">현재 조직의 케이스 상태</p></CardHeader><CardContent className="space-y-4">{data?.statusDistribution.length ? data.statusDistribution.map(item => { const percentage = data.totalCases ? Math.max(5, Math.round(item.value / data.totalCases * 100)) : 0; return <div key={item.label}><div className="mb-1.5 flex items-center justify-between"><ClinicalStatus status={item.label} /><span className="font-mono text-xs text-muted-foreground">{item.value}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percentage}%` }} /></div></div>; }) : <div className="py-12 text-center text-xs text-muted-foreground">데이터가 누적되면 분포가 표시됩니다.</div>}</CardContent></Card>
      </section>
    </div>
  );
}

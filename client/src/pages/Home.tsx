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
      toast.success("Organization workspace created.");
    },
    onError: error => toast.error(error.message),
  });
  return (
    <div className="mx-auto grid min-h-[72vh] max-w-5xl items-center gap-10 lg:grid-cols-[1.15fr_.85fr]">
      <div>
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary"><ShieldCheck className="size-3.5" />Isolated clinical workspace</div>
        <h1 className="font-display text-4xl font-semibold leading-tight tracking-[-0.04em] sm:text-5xl">From evidence to verdict,<br /><span className="text-primary">under expert control.</span></h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">Once you create your first organization, all cases, variants, evidence, and reports are managed within that organization boundary.</p>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">{["Composite tenant keys", "Action-level RBAC", "Immutable sign-out"].map(item => <div key={item} className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="size-4 text-emerald-600" />{item}</div>)}</div>
      </div>
      <div className="clinical-panel p-7">
        <div className="mb-6 grid size-11 place-items-center rounded-xl bg-primary/10 text-primary"><Building2 className="size-5" /></div>
        <h2 className="font-display text-xl font-semibold">Create organization workspace</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Enter your organization name and a URL-safe identifier.</p>
        <div className="mt-6 space-y-4">
          <div className="space-y-2"><Label htmlFor="org-name">Organization name</Label><Input id="org-name" value={name} onChange={event => { const value = event.target.value; setName(value); setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} placeholder="Genolyx Clinical Lab" /></div>
          <div className="space-y-2"><Label htmlFor="org-slug">Organization identifier</Label><Input id="org-slug" value={slug} onChange={event => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="genolyx-lab" /></div>
          <Button className="w-full" size="lg" disabled={create.isPending || name.length < 2 || slug.length < 2} onClick={() => create.mutate({ name, slug, dataRegion: "KR" })}>{create.isPending ? "Creating…" : "Start secure workspace"}<ArrowRight className="ml-2 size-4" /></Button>
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
    onSuccess: async () => { await projects.refetch(); setProjectOpen(false); setProjectName(""); setProjectCode(""); toast.success("Project created."); },
    onError: error => toast.error(error.message),
  });
  if (isLoading) return <div className="grid gap-5"><Skeleton className="h-20" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-36" />)}</div></div>;
  if (!activeOrganizationId || !activeOrganization) return <OrganizationOnboarding />;
  if (summary.isError || projects.isError) return <div className="space-y-7"><PageHeader eyebrow="Clinical operations" title="Clinical Genomics Dashboard" description={`Failed to load organization-scoped data for ${activeOrganization.name}.`} /><StatePanel type="error" title="Failed to load dashboard" description={summary.error?.message || projects.error?.message || "Check your network connection and organization access permissions, then try again."} onRetry={() => { void Promise.all([summary.refetch(), projects.refetch()]); }} /></div>;
  const data = summary.data;
  return (
    <div className="space-y-7">
      <PageHeader eyebrow="Clinical operations" title="Clinical Genomics Dashboard" description={`Analysis status and clinical activity for ${activeOrganization.name} within the organization isolation boundary.`} badge={activeOrganization.role} actions={<><Dialog open={projectOpen} onOpenChange={setProjectOpen}><DialogTrigger asChild><Button variant="outline"><FolderPlus className="mr-2 size-4" />Project</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>New project</DialogTitle><DialogDescription>Create an internal organization project to manage cases separately.</DialogDescription></DialogHeader><div className="grid gap-4 py-3"><div className="space-y-2"><Label>Project name</Label><Input value={projectName} onChange={event => { const value = event.target.value; setProjectName(value); setProjectCode(value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")); }} /></div><div className="space-y-2"><Label>Project code</Label><Input value={projectCode} onChange={event => setProjectCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))} /></div></div><DialogFooter><Button disabled={createProject.isPending || !projectName || !projectCode} onClick={() => createProject.mutate({ organizationId: activeOrganizationId, name: projectName, code: projectCode })}>Create</Button></DialogFooter></DialogContent></Dialog>{hasPermission("case:create") ? <Button onClick={() => navigate("/cases/new")} disabled={!projects.data?.length}><Plus className="mr-2 size-4" />New case</Button> : null}</>} />
      {!projects.isLoading && !projects.data?.length ? <div className="clinical-card flex flex-col gap-4 border-dashed border-primary/30 bg-primary/[0.035] p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold">A project is required first</p><p className="mt-1 text-xs text-muted-foreground">Define an internal data scope before creating cases.</p></div><Button size="sm" onClick={() => setProjectOpen(true)}>Create project</Button></div> : null}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Total cases" value={data?.totalCases ?? 0} caption="Organization-scoped" icon={ClipboardCheck} tone="slate" /><MetricCard label="Review queue" value={data?.reviewQueue ?? 0} caption="review ready · in review" icon={Activity} tone="violet" /><MetricCard label="Active analyses" value={data?.activeAnalyses ?? 0} caption="queued · running" icon={Dna} tone="teal" /><MetricCard label="Reported" value={data?.signedOrReported ?? 0} caption="Electronically signed cases" icon={FileSignature} tone="amber" /></section>
      <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card className="clinical-card border-border/70 shadow-none"><CardHeader className="flex-row items-center justify-between"><div><CardTitle className="font-display text-base">Recent cases</CardTitle><p className="mt-1 text-xs text-muted-foreground">By last modified time</p></div><Button variant="ghost" size="sm" onClick={() => navigate("/cases")}>View all<ArrowRight className="ml-1 size-3.5" /></Button></CardHeader><CardContent className="px-0"><div className="divide-y divide-border/60">{summary.isLoading ? Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="mx-5 my-3 h-12" />) : data?.recentCases.length ? data.recentCases.map(item => <button key={item.id} onClick={() => navigate(`/cases/${item.id}`)} className="grid w-full grid-cols-[1fr_auto] items-center gap-4 px-5 py-3.5 text-left hover:bg-muted/50 sm:grid-cols-[1.1fr_.8fr_.65fr_auto]"><div><p className="font-mono text-xs font-medium">{item.caseNumber}</p><p className="mt-1 text-[11px] text-muted-foreground">{item.patientAlias}</p></div><p className="hidden text-xs text-muted-foreground sm:block">{item.projectName}</p><span className="hidden text-xs capitalize sm:block">{item.purpose}</span><ClinicalStatus status={item.status} /></button>) : <div className="px-5 py-14 text-center"><ClipboardCheck className="mx-auto size-7 text-muted-foreground/40" /><p className="mt-3 text-sm font-medium">No cases submitted yet</p></div>}</div></CardContent></Card>
        <Card className="clinical-card border-border/70 shadow-none"><CardHeader><CardTitle className="font-display text-base">Status distribution</CardTitle><p className="text-xs text-muted-foreground">Case status breakdown for this organization</p></CardHeader><CardContent className="space-y-4">{data?.statusDistribution.length ? data.statusDistribution.map(item => { const percentage = data.totalCases ? Math.max(5, Math.round(item.value / data.totalCases * 100)) : 0; return <div key={item.label}><div className="mb-1.5 flex items-center justify-between"><ClinicalStatus status={item.label} /><span className="font-mono text-xs text-muted-foreground">{item.value}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percentage}%` }} /></div></div>; }) : <div className="py-12 text-center text-xs text-muted-foreground">Distribution will appear as data accumulates.</div>}</CardContent></Card>
      </section>
    </div>
  );
}

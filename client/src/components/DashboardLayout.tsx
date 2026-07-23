import { useAuth } from "@/_core/hooks/useAuth";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatePanel } from "@/components/StatePanel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  Activity,
  Building2,
  ChevronDown,
  ClipboardList,
  Dna,
  FileSignature,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  PanelLeft,
  ShieldCheck,
  Users,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";

const menuItems = [
  { icon: LayoutDashboard, label: "대시보드", path: "/", permission: "case:read" },
  { icon: ClipboardList, label: "케이스", path: "/cases", permission: "case:read" },
  { icon: FlaskConical, label: "변이 워크벤치", path: "/workbench", permission: "variant:read" },
  { icon: FileSignature, label: "임상 보고서", path: "/reports", permission: "report:read" },
  { icon: Activity, label: "감사 로그", path: "/audit", permission: "audit:view" },
  { icon: ShieldCheck, label: "보안 투명성", path: "/security", permission: "security:view" },
  { icon: Users, label: "조직 관리", path: "/organization", permission: "member:manage" },
];

const SIDEBAR_WIDTH_KEY = "gvi-sidebar-width";
const DEFAULT_WIDTH = 272;
const MIN_WIDTH = 232;
const MAX_WIDTH = 360;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? Number(saved) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();
  useEffect(() => localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)), [sidebarWidth]);

  if (loading) return <DashboardLayoutSkeleton />;
  if (!user) {
    return (
      <div className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_right,oklch(0.89_0.07_181),transparent_32rem)] px-5">
        <div className="clinical-panel w-full max-w-lg overflow-hidden">
          <div className="border-b border-border/70 bg-slate-950 px-8 py-7 text-white">
            <div className="mb-8 flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-xl bg-teal-500 text-white"><Dna className="size-5" /></div>
              <div><p className="font-display text-sm font-semibold">Genolyx</p><p className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Variant Interpreter</p></div>
            </div>
            <h1 className="font-display text-3xl font-semibold tracking-tight">Clinical evidence,<br />under expert control.</h1>
            <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">조직 격리, 근거 추적, 전문가 검토와 불변 전자서명 보고서를 하나의 워크스페이스에서 운영합니다.</p>
          </div>
          <div className="space-y-5 p-8">
            <div><h2 className="font-display text-lg font-semibold">보안 로그인</h2><p className="mt-1 text-sm text-muted-foreground">승인된 계정으로 조직 워크스페이스에 접근하십시오.</p></div>
            <Button onClick={() => startLogin()} size="lg" className="w-full">계속하기</Button>
            <p className="text-center text-[11px] leading-5 text-muted-foreground">로그인 활동과 임상 데이터 변경은 조직 감사 로그에 기록됩니다.</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <SidebarProvider style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>{children}</DashboardLayoutContent>
    </SidebarProvider>
  );
}

function DashboardLayoutContent({ children, setSidebarWidth }: { children: React.ReactNode; setSidebarWidth: (width: number) => void }) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const isMobile = useIsMobile();
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const { organizations, activeOrganization, setActiveOrganizationId, hasPermission, isLoading: organizationsLoading, organizationError, refetchOrganizations } = useOrganization();
  const visibleMenuItems = menuItems.filter(item => hasPermission(item.permission));
  const activeMenuItem = menuItems.find(item => item.path === "/" ? location === "/" : location.startsWith(item.path));

  useEffect(() => { if (isCollapsed) setIsResizing(false); }, [isCollapsed]);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!isResizing) return;
      const left = sidebarRef.current?.getBoundingClientRect().left || 0;
      const nextWidth = event.clientX - left;
      if (nextWidth >= MIN_WIDTH && nextWidth <= MAX_WIDTH) setSidebarWidth(nextWidth);
    };
    const up = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  if (organizationsLoading) return <div className="grid min-h-screen place-items-center bg-background px-5"><div className="w-full max-w-xl"><StatePanel type="loading" title="조직 보안 컨텍스트를 확인하고 있습니다" description="멤버십과 역할별 액션 권한을 불러오는 중입니다." /></div></div>;
  if (organizationError) return <div className="grid min-h-screen place-items-center bg-background px-5"><div className="w-full max-w-xl"><StatePanel type="error" title="조직 컨텍스트를 불러오지 못했습니다" description={organizationError} onRetry={() => { void refetchOrganizations(); }} action={<Button variant="outline" onClick={logout}>로그아웃</Button>} /></div></div>;

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar collapsible="icon" className="border-r border-sidebar-border/70" disableTransition={isResizing}>
          <SidebarHeader className="border-b border-sidebar-border/60 px-3 py-4">
            <div className="flex w-full items-center gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-lg"><Dna className="size-4" /></div>
              {!isCollapsed ? <div className="min-w-0 flex-1"><p className="truncate font-display text-sm font-semibold">Genolyx</p><p className="truncate text-[9px] font-medium uppercase tracking-[0.16em] text-sidebar-foreground/50">Variant Interpreter</p></div> : null}
              <button onClick={toggleSidebar} aria-label="Toggle navigation" className="grid size-8 shrink-0 place-items-center rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"><PanelLeft className="size-4" /></button>
            </div>
            {!isCollapsed && activeOrganization ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="mt-4 flex w-full items-center gap-3 rounded-xl border border-sidebar-border/80 bg-sidebar-accent/45 px-3 py-2.5 text-left hover:bg-sidebar-accent">
                    <Building2 className="size-4 shrink-0 text-sidebar-primary" />
                    <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{activeOrganization.name}</p><p className="mt-0.5 truncate text-[9px] uppercase tracking-wide text-sidebar-foreground/50">{activeOrganization.role}</p></div>
                    <ChevronDown className="size-3 text-sidebar-foreground/40" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {organizations.map(org => <DropdownMenuItem key={org.id} onClick={() => setActiveOrganizationId(org.id)} className="gap-3 py-2.5"><Building2 className="size-4 text-muted-foreground" /><div className="min-w-0"><p className="truncate text-sm font-medium">{org.name}</p><p className="text-xs text-muted-foreground">{org.dataRegion} · {org.role}</p></div></DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </SidebarHeader>
          <SidebarContent className="gap-0 px-2 py-4">
            <SidebarMenu>
              {visibleMenuItems.map(item => {
                const active = item.path === "/" ? location === "/" : location.startsWith(item.path);
                return <SidebarMenuItem key={item.path}><SidebarMenuButton isActive={active} onClick={() => setLocation(item.path)} tooltip={item.label} className="h-10 rounded-lg text-[13px] font-medium data-[active=true]:bg-sidebar-primary/10 data-[active=true]:text-sidebar-primary"><item.icon className="size-4" /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>;
              })}
            </SidebarMenu>
          </SidebarContent>
          <SidebarFooter className="border-t border-sidebar-border/60 p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center gap-3 rounded-lg p-1 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                  <Avatar className="size-9 shrink-0 border border-sidebar-border"><AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-foreground">{user?.name?.charAt(0).toUpperCase() || "U"}</AvatarFallback></Avatar>
                  {!isCollapsed ? <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{user?.name || "-"}</p><div className="mt-1 flex items-center gap-2"><p className="truncate text-[9px] text-sidebar-foreground/50">{user?.email || "-"}</p>{activeOrganization ? <Badge variant="outline" className="h-4 border-sidebar-border px-1 text-[7px] uppercase text-sidebar-foreground/60">{activeOrganization.role}</Badge> : null}</div></div> : null}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52"><DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive"><LogOut className="mr-2 size-4" />로그아웃</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        {!isCollapsed ? <div className="absolute right-0 top-0 z-50 h-full w-1 cursor-col-resize hover:bg-sidebar-primary/30" onMouseDown={() => setIsResizing(true)} /> : null}
      </div>
      <SidebarInset>
        <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border/70 bg-background/85 px-3 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-2">
            {isMobile ? <SidebarTrigger className="size-9" /> : null}
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Activity className="size-3.5 text-emerald-600" /><span className="hidden sm:inline">Clinical workspace</span><span className="hidden text-border sm:inline">/</span><span className="font-medium text-foreground">{activeMenuItem?.label || "GVI"}</span></div>
          </div>
          {activeOrganization ? <div className="flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1.5 text-[10px] text-muted-foreground shadow-sm"><ShieldCheck className="size-3.5 text-emerald-600" /><span className="hidden sm:inline">격리 범위</span><span className="font-semibold text-foreground">{activeOrganization.slug}</span></div> : null}
        </div>
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </SidebarInset>
    </>
  );
}

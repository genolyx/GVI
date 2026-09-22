import { useAuth } from "@/_core/hooks/useAuth";
import { useOrganization } from "@/contexts/OrganizationContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { AppearanceControls } from "@/components/AppearanceControls";
import { GenolyxMark, GenolyxWordmark } from "@/components/BrandMark";
import {
  Activity,
  Building2,
  ChevronDown,
  ClipboardList,
  FileSignature,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Microscope,
  PanelLeft,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";

/** Login panel: Google OAuth primary, optional local Dev Login. */
function LoginPanel({ isDevAuth, isGoogleAuth }: { isDevAuth: boolean; isGoogleAuth: boolean }) {
  const [name, setName] = useState("Admin");
  const [email, setEmail] = useState("admin@localhost");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleDevLogin = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/dev/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openId: `dev_${email}`, name, email }),
      });
      if (!res.ok) throw new Error(await res.text());
      window.location.reload();
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_right,rgb(61_176_199_/_35%),transparent_32rem)] px-5">
      <div className="clinical-panel w-full max-w-lg overflow-hidden">
        <div className="border-b border-border/70 bg-[#050b14] px-8 py-7 text-foreground">
          <div className="mb-8">
            <GenolyxWordmark onDark className="h-8 max-w-[180px]" />
            <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-400">Variant Curation</p>
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Clinical evidence,<br />under expert control.</h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">Tenant isolation, evidence tracing, expert review, and immutable signed reports — all in one workspace.</p>
        </div>
        <div className="space-y-5 p-8">
          <div>
            <h2 className="font-display text-lg font-semibold">Secure Login</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isGoogleAuth
                ? "Sign in with your Google account to access your organization workspace."
                : isDevAuth
                  ? "Google OAuth is not configured. Use Dev Login for local development."
                  : "Authentication is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."}
            </p>
          </div>

          {isGoogleAuth ? (
            <>
              <Button onClick={() => startLogin()} size="lg" className="w-full">
                Continue with Google
              </Button>
              <p className="text-center text-[11px] leading-5 text-muted-foreground">
                Login activity and clinical data changes are recorded in the organization audit log.
              </p>
            </>
          ) : null}

          {/* Dev Login only when Google OAuth is not configured */}
          {isDevAuth && !isGoogleAuth ? (
            <>
              <div className="space-y-3">
                <Input placeholder="Name" value={name} onChange={e => setName(e.target.value)} />
                <Input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button onClick={handleDevLogin} size="lg" className="w-full" disabled={loading || !name || !email}>
                {loading ? "Signing in…" : "Dev Login"}
              </Button>
              <p className="text-center text-[11px] leading-5 text-amber-600">⚠ DEV_AUTH mode — disabled in production.</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const menuItems: Array<{
  icon: typeof LayoutDashboard;
  label: string;
  path: string;
  permission?: string;
  platformAdmin?: boolean;
}> = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/", permission: "case:read" },
  { icon: ClipboardList, label: "Cases", path: "/cases", permission: "case:read" },
  { icon: FlaskConical, label: "Variant Workbench", path: "/workbench", permission: "variant:read" },
  { icon: Microscope, label: "Curate Variant", path: "/curate", permission: "curation:run" },
  { icon: FileSignature, label: "Clinical Reports", path: "/reports", permission: "report:read" },
  { icon: Activity, label: "Audit Log", path: "/audit", permission: "audit:view" },
  { icon: ShieldCheck, label: "Security", path: "/security", permission: "security:view" },
  { icon: Users, label: "Organization", path: "/organization", permission: "member:manage" },
  { icon: Settings, label: "Settings", path: "/settings", platformAdmin: true },
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
  const [location] = useLocation();
  const isInviteRoute = location.startsWith("/invite/");
  useEffect(() => localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)), [sidebarWidth]);

  if (loading) return <DashboardLayoutSkeleton />;
  // Invite links render their own shell (login CTA / accept) without the app chrome.
  if (isInviteRoute) return <>{children}</>;
  if (!user) {
    const isDevAuth = import.meta.env.VITE_DEV_AUTH === "true";
    const isGoogleAuth = import.meta.env.VITE_GOOGLE_AUTH === "true";
    return <LoginPanel isDevAuth={isDevAuth} isGoogleAuth={isGoogleAuth} />;
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
  const visibleMenuItems = menuItems.filter(item => item.platformAdmin ? user?.role === "admin" : hasPermission(item.permission || ""));
  const activeMenuItem = menuItems.find(item => item.path === "/" ? location === "/" : location.startsWith(item.path));
  const ActiveIcon = activeMenuItem?.icon;

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

  if (organizationsLoading) return <div className="grid min-h-screen place-items-center bg-background px-5"><div className="w-full max-w-xl"><StatePanel type="loading" title="Verifying organization security context" description="Loading membership and role-based action permissions." /></div></div>;
  if (organizationError) return <div className="grid min-h-screen place-items-center bg-background px-5"><div className="w-full max-w-xl"><StatePanel type="error" title="Failed to load organization context" description={organizationError} onRetry={() => { void refetchOrganizations(); }} action={<Button variant="outline" onClick={logout}>Sign out</Button>} /></div></div>;

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar collapsible="icon" className="border-r border-sidebar-border/70" disableTransition={isResizing}>
          <SidebarHeader className={isCollapsed ? "border-b border-sidebar-border/60 px-1 py-3" : "border-b border-sidebar-border/60 px-3 py-4"}>
            <div className={isCollapsed ? "flex w-full flex-col items-center gap-2" : "relative flex w-full items-center justify-center"}>
              {isCollapsed ? (
                <GenolyxMark className="size-7" />
              ) : (
                <div className="flex min-w-0 flex-col items-center px-8 text-center">
                  <GenolyxWordmark className="object-center" />
                  <p className="mt-1 text-[9px] font-medium uppercase tracking-[0.16em] text-sidebar-foreground/50">Variant Curation</p>
                </div>
              )}
              <button onClick={toggleSidebar} aria-label={isCollapsed ? "Expand navigation" : "Collapse navigation"} className={isCollapsed ? "grid size-7 shrink-0 place-items-center rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring" : "absolute right-0 top-0 grid size-8 shrink-0 place-items-center rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"}><PanelLeft className="size-4" /></button>
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
            <AppearanceControls collapsed={isCollapsed} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center gap-3 rounded-lg p-1 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                  <Avatar className="size-9 shrink-0 border border-sidebar-border"><AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-foreground">{user?.name?.charAt(0).toUpperCase() || "U"}</AvatarFallback></Avatar>
                  {!isCollapsed ? <div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{user?.name || "-"}</p><div className="mt-1 flex items-center gap-2"><p className="truncate text-[9px] text-sidebar-foreground/50">{user?.email || "-"}</p>{activeOrganization ? <Badge variant="outline" className="h-4 border-sidebar-border px-1 text-[7px] uppercase text-sidebar-foreground/60">{activeOrganization.role}</Badge> : null}</div></div> : null}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52"><DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive"><LogOut className="mr-2 size-4" />Sign out</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        {!isCollapsed ? <div className="absolute right-0 top-0 z-50 h-full w-1 cursor-col-resize hover:bg-sidebar-primary/30" onMouseDown={() => setIsResizing(true)} /> : null}
      </div>
      <SidebarInset>
        <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border/70 bg-background/85 px-3 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-2">
            {isMobile ? <SidebarTrigger className="size-9" /> : null}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">{ActiveIcon ? <ActiveIcon className="size-3.5 text-primary" /> : null}<span className="font-medium text-foreground">{activeMenuItem?.label || "GVI"}</span></div>
          </div>
          {activeOrganization ? <div className="flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1.5 text-[10px] text-muted-foreground shadow-sm"><ShieldCheck className="size-3.5 text-emerald-600" /><span className="hidden sm:inline">Isolated scope</span><span className="font-semibold text-foreground">{activeOrganization.slug}</span></div> : null}
        </div>
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </SidebarInset>
    </>
  );
}

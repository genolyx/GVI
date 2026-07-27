import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Building2, CheckCircle2, Dna, LogIn, ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { useLocation, useParams } from "wouter";

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const token = params.token || "";
  const [, navigate] = useLocation();
  const { user, loading: authLoading, logout } = useAuth();
  const { setActiveOrganizationId, refetchOrganizations } = useOrganization();

  const invite = trpc.organizations.getInvite.useQuery(
    { token },
    { enabled: token.length >= 20, retry: false }
  );

  const accept = trpc.organizations.acceptInvite.useMutation({
    onSuccess: async result => {
      localStorage.setItem("gvi-active-organization", String(result.organizationId));
      setActiveOrganizationId(result.organizationId);
      await refetchOrganizations();
      toast.success(
        result.alreadyMember
          ? "You are already a member of this organization."
          : "Invitation accepted. Welcome to the workspace."
      );
      navigate("/");
    },
    onError: error => toast.error(error.message),
  });

  useEffect(() => {
    if (!token || token.length < 20) {
      toast.error("Invalid invite link.");
    }
  }, [token]);

  if (!token || token.length < 20) {
    return (
      <InviteShell>
        <StateBlock
          icon={<ShieldAlert className="size-5" />}
          title="Invalid invite link"
          description="This link is incomplete or malformed. Ask your administrator for a new invitation."
        />
      </InviteShell>
    );
  }

  if (invite.isLoading || authLoading) {
    return (
      <InviteShell>
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="mt-6 h-11 w-full" />
        </div>
      </InviteShell>
    );
  }

  if (invite.isError || !invite.data) {
    return (
      <InviteShell>
        <StateBlock
          icon={<ShieldAlert className="size-5" />}
          title="Invitation not found"
          description={invite.error?.message || "Ask an administrator to send a new invite."}
        />
        <Button className="mt-6 w-full" variant="outline" onClick={() => navigate("/")}>
          Go to home
        </Button>
      </InviteShell>
    );
  }

  const data = invite.data;
  const isPending = data.status === "pending";

  return (
    <InviteShell>
      <div className="mb-6 grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
        <Building2 className="size-5" />
      </div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Organization invite</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        You have been invited to join <span className="font-medium text-foreground">{data.organizationName}</span>
        {" "}(<span className="font-mono text-xs">{data.organizationSlug}</span>) as{" "}
        <span className="capitalize text-foreground">{data.role}</span>.
      </p>

      <dl className="mt-6 space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Invited email</dt>
          <dd className="font-medium">{data.email}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="capitalize font-medium">{data.status}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Expires</dt>
          <dd className="font-medium">{new Date(data.expiresAt).toLocaleString()}</dd>
        </div>
      </dl>

      {!isPending ? (
        <StateBlock
          className="mt-6"
          icon={<ShieldAlert className="size-5" />}
          title={`Invitation ${data.status}`}
          description="Ask an administrator to send a new invite if you still need access."
        />
      ) : !user ? (
        <div className="mt-6 space-y-3">
          <p className="text-sm text-muted-foreground">
            Sign in with the Google account for <span className="font-medium text-foreground">{data.email}</span> to accept.
          </p>
          <Button className="w-full" size="lg" onClick={() => startLogin(`/invite/${token}`)}>
            <LogIn className="mr-2 size-4" />
            Continue with Google
          </Button>
        </div>
      ) : user.email?.toLowerCase() !== data.email.toLowerCase() ? (
        <div className="mt-6 space-y-3">
          <StateBlock
            icon={<ShieldAlert className="size-5" />}
            title="Wrong Google account"
            description={`This invite is for ${data.email}. You are signed in as ${user.email || "an account without email"}.`}
          />
          <Button className="w-full" variant="outline" onClick={() => void logout().then(() => startLogin(`/invite/${token}`))}>
            Sign out and continue with Google
          </Button>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            Signed in as {user.email}. You can accept this invitation.
          </div>
          <Button
            className="w-full"
            size="lg"
            disabled={accept.isPending}
            onClick={() => accept.mutate({ token })}
          >
            {accept.isPending ? "Accepting…" : "Accept invitation"}
          </Button>
        </div>
      )}
    </InviteShell>
  );
}

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_right,oklch(0.89_0.07_181),transparent_32rem)] px-5 py-10">
      <div className="clinical-panel w-full max-w-lg overflow-hidden">
        <div className="border-b border-border/70 bg-slate-950 px-6 py-4 text-white">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl bg-teal-500 text-white">
              <Dna className="size-4" />
            </div>
            <div>
              <p className="font-display text-sm font-semibold">Genolyx</p>
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Variant Interpreter</p>
            </div>
          </div>
        </div>
        <div className="p-8">{children}</div>
      </div>
    </div>
  );
}

function StateBlock({
  icon,
  title,
  description,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-3 grid size-10 place-items-center rounded-xl bg-amber-50 text-amber-700">{icon}</div>
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

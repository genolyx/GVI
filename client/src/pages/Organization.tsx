import { useAuth } from "@/_core/hooks/useAuth";
import { CreateOrganizationForm } from "@/components/CreateOrganizationForm";
import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import type { OrganizationRole } from "@shared/permissions";
import { Building2, Copy, MailPlus, UserRoundCog, UsersRound, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const roles: { value: OrganizationRole; label: string; description: string }[] = [
  { value: "administrator", label: "Administrator", description: "Full organization, member, and security management" },
  { value: "analyst", label: "Analyst", description: "Analysis and variant interpretation" },
  { value: "clinician", label: "Clinician", description: "Clinical review and electronic sign-out" },
  { value: "viewer", label: "Viewer", description: "Read-only access to permitted clinical data" },
];

export default function OrganizationPage() {
  const { user } = useAuth();
  const { activeOrganization, activeOrganizationId, hasPermission, refetchOrganizations } = useOrganization();
  const utils = trpc.useUtils();
  const isPlatformAdmin = user?.role === "admin";
  const enabled = Boolean(activeOrganizationId && hasPermission("member:manage"));
  const members = trpc.organizations.members.useQuery({ organizationId: activeOrganizationId || 0 }, { enabled });
  const invites = trpc.organizations.invites.useQuery({ organizationId: activeOrganizationId || 0 }, { enabled });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrganizationRole>("analyst");
  const [inviteLink, setInviteLink] = useState("");
  const invite = trpc.organizations.invite.useMutation({
    onSuccess: async result => {
      const link = `${window.location.origin}/invite/${result.token}`;
      setInviteLink(link);
      setEmail("");
      await utils.organizations.invites.invalidate();
      toast.success("Invite created with a 7-day expiry.");
    },
    onError: error => toast.error(error.message),
  });
  const updateRole = trpc.organizations.updateMemberRole.useMutation({
    onSuccess: async () => {
      await members.refetch();
      toast.success("Role updated.");
    },
    onError: error => toast.error(error.message),
  });
  const revoke = trpc.organizations.revokeInvite.useMutation({
    onSuccess: async () => {
      await invites.refetch();
      toast.success("Invite revoked.");
    },
    onError: error => toast.error(error.message),
  });

  if (!hasPermission("member:manage")) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Organization" title="Organization" description="Manage membership and role boundaries for the current organization." />
        <StatePanel type="forbidden" title="You do not have permission to manage members" description="Ask your organization administrator for a role that includes the member:manage action." />
      </div>
    );
  }

  if (members.isError || invites.isError) {
    return (
      <div className="space-y-7">
        <PageHeader eyebrow="Organization administration" title="Organization & members" description={`Failed to load membership for ${activeOrganization?.name || "the current organization"}.`} />
        <StatePanel
          type="error"
          title="Failed to load organization data"
          description={members.error?.message || invites.error?.message || "Please try again later."}
          onRetry={() => {
            void Promise.all([members.refetch(), invites.refetch()]);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Organization administration"
        title="Organization & members"
        description={`Manage membership and action-level roles for ${activeOrganization?.name || "the current organization"}.`}
      />
      {invite.error || updateRole.error || revoke.error ? (
        <StatePanel
          compact
          type="error"
          title="Failed to complete organization action"
          description={(invite.error || updateRole.error || revoke.error)?.message || "Check the role and invite status, then try again."}
        />
      ) : null}

      {isPlatformAdmin ? (
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-xl bg-primary/8 text-primary">
                <Building2 className="size-4" />
              </div>
              <div>
                <CardTitle className="font-display text-base">Provision organization</CardTitle>
                <CardDescription className="mt-1 text-xs">
                  Platform admin only. Creates another isolated workspace and makes you its first administrator.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="max-w-xl">
            <CreateOrganizationForm onCreated={refetchOrganizations} submitLabel="Provision workspace" />
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-5 xl:grid-cols-[1.5fr_.8fr]">
        <Card className="clinical-card shadow-none">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-xl bg-primary/8 text-primary">
                <UsersRound className="size-4" />
              </div>
              <div>
                <CardTitle className="font-display text-base">Active members</CardTitle>
                <CardDescription className="mt-1 text-xs">Role changes are reflected in server permission boundaries immediately.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-6 text-right">Organization role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <Skeleton className="h-16" />
                    </TableCell>
                  </TableRow>
                ) : (
                  members.data?.map(member => (
                    <TableRow key={member.id}>
                      <TableCell className="pl-6">
                        <p className="text-xs font-semibold">{member.name || "Unnamed user"}</p>
                        <p className="mt-1 text-[10px] text-muted-foreground">{member.email || `User #${member.userId}`}</p>
                      </TableCell>
                      <TableCell>
                        <span className="status-pill bg-emerald-50 text-emerald-700">{member.status}</span>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Select
                          value={member.role}
                          onValueChange={value =>
                            updateRole.mutate({
                              organizationId: activeOrganizationId!,
                              memberId: member.id,
                              role: value as OrganizationRole,
                            })
                          }
                        >
                          <SelectTrigger className="ml-auto w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {roles.map(item => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="clinical-card shadow-none">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-xl bg-primary/8 text-primary">
                <MailPlus className="size-4" />
              </div>
              <div>
                <CardTitle className="font-display text-base">Invite member</CardTitle>
                <CardDescription className="mt-1 text-xs">Invite links expire after 7 days.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={event => {
                event.preventDefault();
                invite.mutate({ organizationId: activeOrganizationId!, email, role });
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  placeholder="clinician@hospital.org"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={role} onValueChange={value => setRole(value as OrganizationRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map(item => (
                      <SelectItem key={item.value} value={item.value}>
                        <div>
                          <p>{item.label}</p>
                          <p className="text-[10px] text-muted-foreground">{item.description}</p>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full" disabled={invite.isPending}>
                <MailPlus className="mr-2 size-4" />
                Create invite
              </Button>
            </form>
            {inviteLink ? (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-[10px] font-semibold text-emerald-800">Invite link</p>
                <div className="mt-2 flex gap-2">
                  <Input readOnly value={inviteLink} className="h-8 bg-white text-[10px]" />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(inviteLink);
                      toast.success("Link copied.");
                    }}
                  >
                    <Copy className="size-3" />
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <Card className="clinical-card shadow-none">
        <CardHeader>
          <div className="flex items-center gap-3">
            <UserRoundCog className="size-4 text-primary" />
            <div>
              <CardTitle className="font-display text-base">Invite history</CardTitle>
              <CardDescription className="mt-1 text-xs">Pending invites can be revoked immediately.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="pr-6 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.data?.length ? (
                invites.data.map(item => {
                  const state = item.acceptedAt
                    ? "accepted"
                    : item.revokedAt
                      ? "revoked"
                      : new Date(item.expiresAt).getTime() < Date.now()
                        ? "expired"
                        : "pending";
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="pl-6 text-xs font-medium">{item.email}</TableCell>
                      <TableCell className="text-xs capitalize">{item.role}</TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{new Date(item.expiresAt).toLocaleString()}</TableCell>
                      <TableCell className="pr-6 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span className="status-pill bg-muted text-muted-foreground">{state}</span>
                          {state === "pending" ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Revoke invite"
                              onClick={() => revoke.mutate({ organizationId: activeOrganizationId!, inviteId: item.id })}
                            >
                              <X className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-xs text-muted-foreground">
                    No invite history.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrganization } from "@/contexts/OrganizationContext";
import { formatDateTime } from "@/lib/datetime";
import { trpc } from "@/lib/trpc";
import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

function jsonBlock(value: unknown) {
  if (value == null) return "—";
  const text = JSON.stringify(value, null, 2);
  return text && text !== "undefined" ? text : "—";
}

export default function AuditLogPage() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [entityType, setEntityType] = useState("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const canView = hasPermission("audit:view");
  const query = trpc.organizations.audit.useQuery(
    { organizationId: activeOrganizationId || 0, entityType: entityType === "all" ? undefined : entityType, limit: 100 },
    { enabled: Boolean(activeOrganizationId && canView) }
  );

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Append-only trace"
        title="Audit Log"
        description="Track who changed what, when, and how — within the organization boundary."
        actions={canView ? (
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger className="w-44 bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All entities</SelectItem>
              <SelectItem value="case">Cases</SelectItem>
              <SelectItem value="variant">Variants</SelectItem>
              <SelectItem value="interpretation">Interpretations</SelectItem>
              <SelectItem value="report">Reports</SelectItem>
              <SelectItem value="organization_member">Members</SelectItem>
            </SelectContent>
          </Select>
        ) : undefined}
      />
      {!canView ? (
        <StatePanel type="forbidden" title="You do not have permission to view the audit log" description="Ask your organization administrator for a role that includes the audit:view action. Organization events outside your permissions remain hidden." />
      ) : query.isError ? (
        <StatePanel type="error" title="Failed to load audit log" description={query.error.message} onRetry={() => { void query.refetch(); }} />
      ) : query.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-10" />)}</div>
      ) : query.data?.length ? (
        <div className="clinical-card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border/70 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Actor</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map(event => {
                const open = openId === event.id;
                return (
                  <Fragment key={event.id}>
                    <tr
                      className="cursor-pointer border-b border-border/50 hover:bg-muted/40"
                      onClick={() => setOpenId(open ? null : event.id)}
                    >
                      <td className="px-3 py-2">
                        <ChevronRight className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDateTime(event.createdAt)}</td>
                      <td className="px-3 py-2 font-medium">{event.action}</td>
                      <td className="whitespace-nowrap px-3 py-2">{event.entityType} #{event.entityId || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{event.actorUserId ? `#${event.actorUserId}` : "system"}</td>
                    </tr>
                    {open ? (
                      <tr className="border-b border-border/50 bg-muted/20">
                        <td colSpan={5} className="px-4 py-3">
                          <p className="mb-3 font-mono text-xs text-muted-foreground">Request {event.requestId || "—"}</p>
                          <div className="grid items-start gap-3 sm:grid-cols-2">
                            <pre className="overflow-auto rounded-lg bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{jsonBlock(event.before)}</pre>
                            <pre className="overflow-auto rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">{jsonBlock(event.after)}</pre>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <StatePanel type="empty" title="No audit events to display" description="When clinical data or administrative actions occur within the organization, request metadata and before/after records will appear here." />
      )}
    </div>
  );
}

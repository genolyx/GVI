import { useAuth } from "@/_core/hooks/useAuth";
import { useOrganization } from "@/contexts/OrganizationContext";
import { trpc } from "@/lib/trpc";
import { isSuperAdminRole } from "@shared/permissions";
import { useEffect } from "react";

/**
 * A batch link is scoped to the selected organization. A super admin opening a
 * batch from another organization is moved to the organization that owns it.
 */
export function useOwningBatchOrg(
  batchId: number,
  missing: boolean,
  resolvedOrganizationId?: number | null
): boolean {
  const { user } = useAuth();
  const { activeOrganizationId, setActiveOrganizationId } = useOrganization();
  const superAdmin = isSuperAdminRole(user?.role);
  const located = trpc.workbench.locateBatch.useQuery(
    { batchId },
    { enabled: Boolean(superAdmin && missing && batchId), retry: false }
  );
  const organizationId = resolvedOrganizationId ?? located.data?.organizationId;

  useEffect(() => {
    if (!organizationId || organizationId === activeOrganizationId) return;
    setActiveOrganizationId(organizationId);
  }, [organizationId, activeOrganizationId, setActiveOrganizationId]);

  return Boolean(
    superAdmin &&
      missing &&
      (located.isLoading || (organizationId != null && organizationId !== activeOrganizationId))
  );
}

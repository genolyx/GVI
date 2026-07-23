import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

type Organization = {
  id: number;
  name: string;
  slug: string;
  status: "active" | "suspended";
  dataRegion: string;
  isolationMode: "shared_schema" | "dedicated_database";
  role: "administrator" | "analyst" | "clinician" | "viewer";
};

type OrganizationContextValue = {
  organizations: Organization[];
  activeOrganization: Organization | null;
  activeOrganizationId: number | null;
  setActiveOrganizationId: (id: number) => void;
  hasPermission: (permission: string) => boolean;
  isLoading: boolean;
  organizationError: string | null;
  refetchOrganizations: () => Promise<unknown>;
};

const OrganizationContext = createContext<OrganizationContextValue | null>(null);
const STORAGE_KEY = "gvi-active-organization";

export function OrganizationProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const query = trpc.organizations.list.useQuery(undefined, {
    enabled: Boolean(user) && !loading,
    retry: false,
  });
  const organizations = query.data || [];
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<number | null>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? Number(saved) : null;
  });

  useEffect(() => {
    if (!organizations.length) {
      setActiveOrganizationIdState(null);
      return;
    }
    if (!activeOrganizationId || !organizations.some(org => org.id === activeOrganizationId)) {
      setActiveOrganizationIdState(organizations[0].id);
      localStorage.setItem(STORAGE_KEY, String(organizations[0].id));
    }
  }, [organizations, activeOrganizationId]);

  const activeOrganization =
    organizations.find(org => org.id === activeOrganizationId) || null;
  const permissionCatalog = trpc.organizations.permissionCatalog.useQuery(undefined, {
    enabled: Boolean(user),
    staleTime: Infinity,
  });

  const value = useMemo<OrganizationContextValue>(
    () => ({
      organizations,
      activeOrganization,
      activeOrganizationId,
      setActiveOrganizationId: id => {
        setActiveOrganizationIdState(id);
        localStorage.setItem(STORAGE_KEY, String(id));
      },
      hasPermission: permission => {
        if (!activeOrganization || !permissionCatalog.data) return false;
        const rolePermissions = permissionCatalog.data.permissions[activeOrganization.role] || [];
        return (rolePermissions as readonly string[]).includes(permission);
      },
      isLoading: query.isLoading || permissionCatalog.isLoading,
      organizationError: query.error?.message || permissionCatalog.error?.message || null,
      refetchOrganizations: () => Promise.all([query.refetch(), permissionCatalog.refetch()]),
    }),
    [organizations, activeOrganization, activeOrganizationId, permissionCatalog.data, permissionCatalog.error?.message, permissionCatalog.isLoading, permissionCatalog.refetch, query.error?.message, query.isLoading, query.refetch]
  );

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganization() {
  const context = useContext(OrganizationContext);
  if (!context) throw new Error("useOrganization must be used inside OrganizationProvider");
  return context;
}

import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { useOrganization } from "@/contexts/OrganizationContext";
import { ArrowRight } from "lucide-react";
import { useLocation } from "wouter";

export default function WorkbenchLandingPage() {
  const { hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  return <div className="space-y-7"><PageHeader eyebrow="Variant interpretation" title="Variant Workbench" description="Review per-case variants, the Evidence Ledger, ACMG/AMP classifications, and AI-assisted drafts." />{hasPermission("variant:read") ? <StatePanel type="empty" title="Select a case to review" description="The workbench opens while preserving the case reference build, test purpose, and organization boundary." action={<Button onClick={() => navigate("/cases")}>Select case<ArrowRight className="ml-2 size-4" /></Button>} /> : <StatePanel type="forbidden" title="You do not have permission to view variants" description="Ask your organization administrator for a role that includes the variant:read action." />}</div>;
}

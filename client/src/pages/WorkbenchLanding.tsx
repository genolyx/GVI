import { PageHeader } from "@/components/PageHeader";
import { StatePanel } from "@/components/StatePanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useOrganization } from "@/contexts/OrganizationContext";
import { ArrowRight, Dna, Microscope } from "lucide-react";
import { useLocation } from "wouter";

export default function WorkbenchLandingPage() {
  const { hasPermission } = useOrganization();
  const [, navigate] = useLocation();
  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Variant interpretation"
        title="Variant Workbench"
        description="Choose the purpose-specific workflow. Germline ACMG/SAM-VC and Somatic cancer CDS remain isolated."
      />
      {hasPermission("variant:read") ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <WorkflowCard
            icon={Dna}
            title="Germline Workbench"
            description="Run and review the existing SAM-VC classifier, ACMG evidence, and germline curation batches."
            action="Open Germline"
            onClick={() => navigate("/workbench/germline")}
          />
          <WorkflowCard
            icon={Microscope}
            title="Somatic Workbench"
            description="Review target-panel cancer cases, source-native evidence, and expert-controlled AMP assertions."
            action="Open Somatic"
            onClick={() => navigate("/workbench/somatic")}
          />
        </div>
      ) : (
        <StatePanel
          type="forbidden"
          title="You do not have permission to view variants"
          description="Ask your organization administrator for a role that includes the variant:read action."
        />
      )}
    </div>
  );
}

function WorkflowCard({
  icon: Icon,
  title,
  description,
  action,
  onClick,
}: {
  icon: typeof Dna;
  title: string;
  description: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <Card className="clinical-card shadow-none">
      <CardContent className="flex h-full flex-col p-6">
        <div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <h2 className="mt-5 font-display text-xl font-semibold">{title}</h2>
        <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
        <Button className="mt-6 self-start" onClick={onClick}>
          {action}
          <ArrowRight className="ml-2 size-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

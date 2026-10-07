import { Badge } from "@/components/ui/badge";
import { clinvarShortLabels } from "@/lib/clinvarLabel";
import { cn } from "@/lib/utils";
import { classificationTone, entryChip } from "./status";

function clinvarClass(label: string) {
  if (label === "P" || label === "LP") return "pathogenic";
  if (label === "B" || label === "LB") return "benign";
  return "vus";
}

/** Short ClinVar calls, matching the case variant table: P, LP, VUS, LB, B. */
export function ClinVarMarks({ significance }: { significance: string | null | undefined }) {
  const labels = significance ? clinvarShortLabels(significance) : [];
  if (!labels.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1" title={significance || undefined}>
      {labels.map(label => (
        <Badge key={label} variant="outline" className={cn(entryChip, classificationTone(clinvarClass(label)))}>
          {label}
        </Badge>
      ))}
    </span>
  );
}

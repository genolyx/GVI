import { RESEARCH_USE_STATEMENT } from "@shared/researchUse";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import { useState } from "react";

export function ResearchUseBanner() {
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center text-xs font-semibold tracking-wide text-amber-950 dark:text-amber-100">
      Research Use Only. Not for clinical diagnosis or patient care.
    </div>
  );
}

export function ResearchUseGate({ onAccepted }: { onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const accept = trpc.auth.acceptResearchUse.useMutation({
    onSuccess: () => onAccepted(),
  });

  return (
    <div className="grid min-h-screen place-items-center bg-background px-5">
      <div className="clinical-panel w-full max-w-lg p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700 dark:text-amber-300">
          Research Use Only
        </p>
        <h1 className="mt-3 font-display text-2xl font-semibold tracking-tight">
          Confirm how this system may be used
        </h1>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">{RESEARCH_USE_STATEMENT}</p>
        <label className="mt-6 flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm leading-6">
          <Checkbox
            checked={checked}
            onCheckedChange={value => setChecked(value === true)}
            aria-label="I understand this system is for research use only"
            className="mt-1"
          />
          <span>I understand this system is for research use only and is not for clinical decision-making.</span>
        </label>
        {accept.error ? (
          <p className="mt-3 text-xs text-destructive">{accept.error.message}</p>
        ) : null}
        <Button
          className="mt-6 w-full"
          size="lg"
          disabled={!checked || accept.isPending}
          onClick={() => accept.mutate()}
        >
          {accept.isPending ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

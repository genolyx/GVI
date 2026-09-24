import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLocation } from "wouter";

export type ReusedAnalysisNotice = {
  gene: string;
  hgvsC: string;
  kind: "case" | "batch" | "single";
  label: string;
  batchId: number | null;
  caseId: number | null;
};

function placeLabel(notice: ReusedAnalysisNotice) {
  if (notice.kind === "batch") return `batch ${notice.label}`;
  if (notice.kind === "case") return `case ${notice.label}`;
  return "Single variants";
}

export function reusedHref(notice: ReusedAnalysisNotice) {
  if (notice.kind === "case" && notice.caseId) return `/cases/${notice.caseId}`;
  if (notice.batchId) return `/workbench/batches/${notice.batchId}`;
  return "/workbench";
}

export function ReusedAnalysisDialog({ notice, onClose }: { notice: ReusedAnalysisNotice | null; onClose: () => void }) {
  const [, navigate] = useLocation();
  return (
    <Dialog open={notice !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Existing analysis found</DialogTitle>
          <DialogDescription>
            {notice
              ? `${notice.gene} ${notice.hgvsC} already has a completed analysis in ${placeLabel(notice)}. This entry uses that result, so the classifier did not run again.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {notice ? (
            <Button onClick={() => { const href = reusedHref(notice); onClose(); navigate(href); }}>View existing</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

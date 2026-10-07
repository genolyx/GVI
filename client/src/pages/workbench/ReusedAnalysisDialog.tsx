import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reusedAnalysisDescription, reusedHref, type ReusedAnalysisNotice } from "@/lib/reusedAnalysis";
import { useLocation } from "wouter";

export type { ReusedAnalysisNotice };

export function ReusedAnalysisDialog({ notice, onClose }: { notice: ReusedAnalysisNotice | null; onClose: () => void }) {
  const [, navigate] = useLocation();
  return (
    <Dialog open={notice !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Existing analysis found</DialogTitle>
          <DialogDescription>
            {notice ? reusedAnalysisDescription(notice) : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {notice && reusedHref(notice) ? (
            <Button onClick={() => { const href = reusedHref(notice); onClose(); if (href) navigate(href); }}>View existing</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

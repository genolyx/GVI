import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = {
  draft: "초안",
  queued: "대기",
  running: "분석 중",
  review_ready: "검토 준비",
  in_review: "검토 중",
  reported: "보고 완료",
  failed: "실패",
  completed: "완료",
  signed: "서명 완료",
  amended: "수정 보고",
  approved: "승인됨",
  unreviewed: "미검토",
  reviewing: "검토 중",
  reviewed: "검토됨",
  flagged: "주의 필요",
};

const TONES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  queued: "bg-amber-50 text-amber-800 border-amber-200",
  running: "bg-cyan-50 text-cyan-800 border-cyan-200",
  review_ready: "bg-violet-50 text-violet-800 border-violet-200",
  in_review: "bg-indigo-50 text-indigo-800 border-indigo-200",
  reported: "bg-emerald-50 text-emerald-800 border-emerald-200",
  completed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  signed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
  failed: "bg-rose-50 text-rose-800 border-rose-200",
  flagged: "bg-rose-50 text-rose-800 border-rose-200",
};

export function ClinicalStatus({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-md px-2 py-0.5 text-[11px] font-medium", TONES[status] || TONES.draft, className)}>
      {LABELS[status] || status}
    </Badge>
  );
}

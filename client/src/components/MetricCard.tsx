import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export function MetricCard({ label, value, caption, icon: Icon, tone = "teal" }: {
  label: string;
  value: number | string;
  caption: string;
  icon: LucideIcon;
  tone?: "teal" | "violet" | "amber" | "slate";
}) {
  const tones = {
    teal: "bg-teal-50 text-teal-700 ring-teal-100",
    violet: "bg-violet-50 text-violet-700 ring-violet-100",
    amber: "bg-amber-50 text-amber-700 ring-amber-100",
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
  };
  return (
    <article className="clinical-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
        </div>
        <div className={cn("grid size-10 place-items-center rounded-xl ring-1", tones[tone])}>
          <Icon className="size-4" />
        </div>
      </div>
    </article>
  );
}

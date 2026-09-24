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
    teal: "bg-primary/10 text-primary ring-primary/25",
    violet: "bg-violet-100 text-violet-800 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-400/25",
    amber: "bg-amber-100 text-amber-900 ring-amber-200 dark:bg-[#3297ac]/15 dark:text-[#7fd4e4] dark:ring-[#3297ac]/25",
    slate: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-[#111f2e] dark:text-[#c5d0dc] dark:ring-white/10",
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

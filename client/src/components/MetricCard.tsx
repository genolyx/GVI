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
    teal: "bg-primary/10 text-primary ring-primary/20",
    violet: "bg-primary/8 text-[#8fa3b8] ring-primary/15",
    amber: "bg-[#3297ac]/15 text-[#3db0c7] ring-[#3297ac]/25",
    slate: "bg-[#111f2e] text-[#8fa3b8] ring-[rgb(61_176_199_/_14%)]",
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

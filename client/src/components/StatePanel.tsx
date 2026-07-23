import { Button } from "@/components/ui/button";
import { AlertTriangle, Ban, Inbox, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

type StatePanelProps = {
  type: "error" | "empty" | "forbidden" | "loading";
  title: string;
  description: string;
  onRetry?: () => void;
  action?: ReactNode;
  compact?: boolean;
};

const stateStyle = {
  error: { icon: AlertTriangle, iconClass: "bg-rose-50 text-rose-700", eyebrow: "Request failed" },
  empty: { icon: Inbox, iconClass: "bg-muted text-muted-foreground", eyebrow: "No records" },
  forbidden: { icon: Ban, iconClass: "bg-amber-50 text-amber-700", eyebrow: "Access restricted" },
  loading: { icon: LoaderCircle, iconClass: "bg-primary/8 text-primary", eyebrow: "Verifying context" },
} as const;

export function StatePanel({ type, title, description, onRetry, action, compact = false }: StatePanelProps) {
  const style = stateStyle[type];
  const Icon = style.icon;
  return (
    <section role={type === "error" ? "alert" : "status"} aria-live={type === "error" ? "assertive" : "polite"} className={`clinical-card flex flex-col items-center justify-center px-6 text-center ${compact ? "py-8" : "min-h-72 py-14"}`}>
      <div className={`grid size-12 place-items-center rounded-2xl ${style.iconClass}`}><Icon className={`size-5 ${type === "loading" ? "animate-spin" : ""}`} aria-hidden="true" /></div>
      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[.16em] text-muted-foreground">{style.eyebrow}</p>
      <h2 className="mt-2 font-display text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-lg text-xs leading-6 text-muted-foreground">{description}</p>
      {onRetry || action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{onRetry ? <Button variant="outline" onClick={onRetry}><RefreshCw className="mr-2 size-4" />다시 시도</Button> : null}{action}</div> : null}
    </section>
  );
}

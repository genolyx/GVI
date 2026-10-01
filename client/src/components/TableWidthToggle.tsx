import { cn } from "@/lib/utils";
import { Maximize2 } from "lucide-react";

export type TableWidthMode = "fit" | "full";

export function TableWidthToggle({
  mode,
  onChange,
}: {
  mode: TableWidthMode;
  onChange: (mode: TableWidthMode) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-lg border bg-muted/40 p-0.5"
      role="group"
      aria-label="Table width"
    >
      <button
        type="button"
        aria-pressed={mode === "fit"}
        onClick={() => onChange("fit")}
        className={cn(
          "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium",
          mode === "fit" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
        )}
      >
        Fit
      </button>
      <button
        type="button"
        aria-pressed={mode === "full"}
        onClick={() => onChange("full")}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium",
          mode === "full" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
        )}
      >
        <Maximize2 className="size-3.5" />
        Full
      </button>
    </div>
  );
}

export function tableFrameClass(mode: TableWidthMode) {
  return mode === "fit" ? "overflow-hidden" : "overflow-x-auto";
}

export function tableWidthClass(mode: TableWidthMode) {
  return mode === "fit"
    ? "w-full table-fixed [&_th]:truncate [&_td]:max-w-0 [&_td]:truncate"
    : "w-max min-w-full [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap";
}

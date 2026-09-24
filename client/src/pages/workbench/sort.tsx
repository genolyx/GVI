import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";

export type SortDirection = "asc" | "desc";

export function SortHeader({
  label,
  active,
  direction,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th className={cn("py-2 pr-3 font-semibold", className)} aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-foreground" onClick={onClick}>
        {label}
        {active ? (
          direction === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />
        ) : (
          <ChevronDown className="size-3 opacity-30" />
        )}
      </button>
    </th>
  );
}

export function compareSortValues(left: string | number | null, right: string | number | null, direction: SortDirection) {
  const leftEmpty = left === null || left === "";
  const rightEmpty = right === null || right === "";
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;
  const order =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), "en", { numeric: true, sensitivity: "base" });
  return direction === "asc" ? order : -order;
}

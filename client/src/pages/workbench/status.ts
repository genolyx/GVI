export function workbenchStatusLabel(status: string) {
  if (status === "succeeded") return "done";
  return status;
}

export function workbenchStatusClass(status: string) {
  if (status === "succeeded") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
  if (status === "running") return "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300";
  if (status === "failed") return "border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-300";
  return "border-border bg-muted text-muted-foreground";
}

export function classificationTone(cssClass?: string | null) {
  if (cssClass === "pathogenic") return "border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-300";
  if (cssClass === "benign") return "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300";
  return "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200";
}

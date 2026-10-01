/** The run a live log should follow: the one in analysis, otherwise the next queued, otherwise the latest finished. */
export function focusClassifierRun<
  T extends {
    status: string;
    queuedAt?: Date | string | null;
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
  },
>(runs: readonly T[]): T | undefined {
  const rank = (status: string) =>
    status === "running" ? 0 : status === "loading" ? 1 : status === "queued" ? 2 : 3;
  return [...runs].sort((left, right) => {
    const byStatus = rank(left.status) - rank(right.status);
    if (byStatus !== 0) return byStatus;
    const leftTime = new Date(left.completedAt || left.startedAt || left.queuedAt || 0).getTime();
    const rightTime = new Date(right.completedAt || right.startedAt || right.queuedAt || 0).getTime();
    return left.status === "queued" ? leftTime - rightTime : rightTime - leftTime;
  })[0];
}

/** Completion instant for one variant. Unfinished runs have no analyzed time. */
export function variantAnalyzedAt(status: string, completedAt: Date | string | null | undefined): number | null {
  if (status !== "succeeded" || !completedAt) return null;
  const date = completedAt instanceof Date ? completedAt : new Date(completedAt);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

/** Completion instant for a batch: the last variant, and only once every variant is done. */
export function batchAnalyzedAt(entries: { status: string; completedAt: Date | string | null | undefined }[]): number | null {
  if (!entries.length || entries.some(entry => entry.status !== "succeeded")) return null;
  const times = entries.map(entry => variantAnalyzedAt(entry.status, entry.completedAt));
  if (times.some(time => time === null)) return null;
  return Math.max(...(times as number[]));
}

function instant(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Time shown in the Analyzed column.
 * A finished group uses its last completion. A group still running uses the latest
 * queue, start, or completion instant, then the case update time.
 */
export function entryActivityAt(
  entries: {
    completedAt: Date | string | null | undefined;
    startedAt?: Date | string | null;
    queuedAt?: Date | string | null;
  }[],
  fallback?: Date | string | null
): number | null {
  const finished = batchAnalyzedAt(entries);
  if (finished !== null) return finished;
  const times = entries.flatMap(entry =>
    [entry.completedAt, entry.startedAt, entry.queuedAt]
      .map(instant)
      .filter((time): time is number => time !== null)
  );
  const fallbackTime = instant(fallback);
  if (fallbackTime !== null) times.push(fallbackTime);
  if (!times.length) return null;
  return Math.max(...times);
}

/** Shared size and radius for entry-table chips and actions. */
export const entryChip = "h-7 rounded-md px-2.5 text-xs font-medium shadow-none";
export const entryAction = "h-7 rounded-md border-border bg-muted/40 px-2.5 text-xs font-medium shadow-none hover:bg-muted/70 dark:border-border dark:bg-muted/40 dark:hover:bg-muted/70";
export const entryReview = "h-7 rounded-md border-emerald-500/30 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-800 shadow-none hover:bg-emerald-500/20 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20";
export const entryRun = "h-7 rounded-md border-primary/30 bg-primary/10 px-2.5 text-xs font-medium text-primary shadow-none hover:bg-primary/20 dark:border-primary/30 dark:bg-primary/10 dark:hover:bg-primary/20";

export function workbenchStatusLabel(status: string) {
  if (status === "succeeded") return "Done";
  if (status === "queued") return "Queued";
  if (status === "loading") return "Loading";
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return status;
}

export function workbenchStatusClass(status: string) {
  if (status === "succeeded") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
  if (status === "loading") return "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200";
  if (status === "running") return "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300";
  if (status === "failed") return "border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-300";
  return "border-border bg-muted text-muted-foreground";
}

export function classificationTone(cssClass?: string | null) {
  if (cssClass === "pathogenic") return "border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-300";
  if (cssClass === "benign") return "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300";
  return "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200";
}

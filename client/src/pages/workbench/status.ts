export function workbenchStatusLabel(status: string) {
  if (status === "succeeded") return "done";
  return status;
}

export function workbenchStatusClass(status: string) {
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "running") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "cancelled") return "border-slate-200 bg-slate-50 text-slate-500";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

export function classificationTone(cssClass?: string | null) {
  if (cssClass === "pathogenic") return "border-rose-300 bg-rose-50 text-rose-700";
  if (cssClass === "benign") return "border-sky-300 bg-sky-50 text-sky-700";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

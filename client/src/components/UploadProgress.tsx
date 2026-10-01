import { Progress } from "@/components/ui/progress";

export function UploadProgress({
  label,
  percent,
}: {
  label: string;
  percent: number;
}) {
  const shown = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="font-mono">{shown}%</span>
      </div>
      <Progress value={shown} />
    </div>
  );
}

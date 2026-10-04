import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

export function ClassifierLimitPanel() {
  const status = trpc.classifierLimit.status.useQuery();
  const [draft, setDraft] = useState("");
  const save = trpc.classifierLimit.save.useMutation({
    onSuccess: result => {
      setDraft("");
      void status.refetch();
      toast.success(`A case now classifies up to ${result.limit} variants.`);
    },
    onError: error => toast.error(error.message),
  });

  const current = status.data?.limit;
  const source = status.data?.source === "saved"
    ? "saved on this server"
    : status.data?.source === "env"
      ? "CLASSIFIER_CASE_LIMIT"
      : "the default";

  return (
    <Card className="clinical-card shadow-none">
      <CardHeader>
        <CardTitle className="font-display text-base">Variants classified per order</CardTitle>
        <CardDescription className="text-xs">
          After filtering, GVC classifies at most this many variants for one order. Variants already stored are read without running the engine. The rest wait until the limit is raised. Current: {current ?? "…"} ({source}).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          min={1}
          max={5000}
          value={draft}
          placeholder={current ? String(current) : "200"}
          onChange={event => setDraft(event.target.value)}
          className="w-32 font-mono"
          aria-label="Variants classified per order"
        />
        <Button
          type="button"
          size="sm"
          disabled={save.isPending || !draft.trim()}
          onClick={() => save.mutate({ limit: Number(draft) })}
        >
          Save
        </Button>
      </CardContent>
    </Card>
  );
}

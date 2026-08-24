import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type CreateOrganizationFormProps = {
  onCreated?: () => Promise<unknown> | void;
  submitLabel?: string;
};

export function CreateOrganizationForm({
  onCreated,
  submitLabel = "Start secure workspace",
}: CreateOrganizationFormProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const create = trpc.organizations.create.useMutation({
    onSuccess: async () => {
      await onCreated?.();
      toast.success("Organization workspace created.");
      setName("");
      setSlug("");
    },
    onError: error => toast.error(error.message),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="org-name">Organization name</Label>
        <Input
          id="org-name"
          value={name}
          onChange={event => {
            const value = event.target.value;
            setName(value);
            setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
          }}
          placeholder="Genolyx Clinical Lab"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="org-slug">Organization identifier</Label>
        <Input
          id="org-slug"
          value={slug}
          onChange={event => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          placeholder="genolyx-lab"
        />
      </div>
      {create.error ? (
        <p className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
          {create.error.message}
        </p>
      ) : null}
      <Button
        className="w-full"
        size="lg"
        disabled={create.isPending || name.length < 2 || slug.length < 2}
        onClick={() => create.mutate({ name, slug, dataRegion: "KR" })}
      >
        {create.isPending ? "Creating…" : submitLabel}
        <ArrowRight className="ml-2 size-4" />
      </Button>
    </div>
  );
}

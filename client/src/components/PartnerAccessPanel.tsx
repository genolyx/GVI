import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

export function PartnerAccessPanel() {
  const status = trpc.partnerAccess.status.useQuery();
  const [draft, setDraft] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState("http://localhost:8090");
  const [link, setLink] = useState<{ ok: boolean; message: string } | null>(null);
  const check = trpc.partnerAccess.check.useMutation({
    onSuccess: setLink,
    onError: error => setLink({ ok: false, message: error.message }),
  });
  const generate = trpc.partnerAccess.generate.useMutation({
    onSuccess: result => {
      setFresh(result.token);
      setDraft("");
      void status.refetch();
      toast.success("Token generated. Copy it into gx-portal Classification.");
    },
    onError: error => toast.error(error.message),
  });
  const saveUrl = trpc.partnerAccess.savePortalUrl.useMutation({
    onSuccess: result => {
      setPortalUrl(result.portalUrl);
      void status.refetch();
      toast.success("Portal URL saved.");
      check.mutate({ url: portalUrl });
    },
    onError: error => toast.error(error.message),
  });
  const save = trpc.partnerAccess.save.useMutation({
    onSuccess: () => {
      setDraft("");
      setFresh(null);
      void status.refetch();
      toast.success(draft.trim() ? "Partner token saved." : "Saved partner token cleared.");
    },
    onError: error => toast.error(error.message),
  });

  useEffect(() => {
    if (status.data?.portalUrl) setPortalUrl(status.data.portalUrl);
  }, [status.data?.portalUrl]);

  useEffect(() => {
    check.mutate({});
    // Check once when the settings card opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configured = status.data?.configured;
  const preview = status.data?.preview;

  return (
    <Card className="clinical-card shadow-none">
      <CardHeader>
        <CardTitle className="font-display text-base">gx-portal partner API</CardTitle>
        <CardDescription className="text-xs">
          Bearer token for interpretation jobs from gx-portal. Generate one here and paste it into the portal, or paste a token the portal generated. A saved token is used immediately and overrides PARTNER_API_TOKEN.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className={`text-sm font-medium ${link?.ok ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>
            {check.isPending ? "Checking gx-portal…" : link?.message ?? "Connection not checked."}
          </p>
          <Button type="button" variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate({ url: portalUrl })}>
            Check connection
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={portalUrl}
            onChange={event => setPortalUrl(event.target.value)}
            placeholder="http://localhost:8090"
            className="max-w-xl font-mono text-xs"
            aria-label="gx-portal URL"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saveUrl.isPending}
            onClick={() => saveUrl.mutate({ url: portalUrl })}
          >
            Save URL
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {configured
            ? `Current token ${preview}. Source: ${status.data?.source === "saved" ? "saved in Settings" : "environment"}.`
            : "Not configured. The partner API stays closed until a token of at least 32 characters is saved."}
        </p>
        {fresh ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly value={fresh} className="max-w-xl font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(fresh).then(
                  () => toast.success("Token copied"),
                  () => toast.error("Could not copy the token"),
                );
              }}
            >
              Copy
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={generate.isPending}
            onClick={() => {
              if (
                configured &&
                !window.confirm("Generate a new token? gx-portal must be updated to this token or its calls will be rejected.")
              ) {
                return;
              }
              generate.mutate();
            }}
          >
            {configured ? "Generate new token" : "Generate token"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Paste a token from gx-portal"
            className="max-w-xl font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate({ token: draft })}
          >
            Save token
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

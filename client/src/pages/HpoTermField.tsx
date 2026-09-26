import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

function tokensOf(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of value.split(/[\n,;]+/)) {
    const token = part.trim();
    const key = token.toLowerCase();
    if (!token || seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
}

export function HpoTermField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const listId = useId();
  const tokens = tokensOf(value);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setQuery(draft.trim()), 120);
    return () => window.clearTimeout(handle);
  }, [draft]);

  const search = trpc.cases.searchHpo.useQuery(
    { q: query },
    { enabled: query.length >= 2 },
  );
  const suggestions = (search.data ?? []).filter(item => !tokens.some(token => token.toLowerCase() === item.name.toLowerCase()));
  const highlighted = suggestions[Math.min(active, Math.max(suggestions.length - 1, 0))];
  const ghost = highlighted && highlighted.name.toLowerCase().startsWith(draft.trim().toLowerCase())
    ? highlighted.name.slice(draft.trim().length)
    : "";

  const commit = (name: string) => {
    const next = tokensOf(`${value}, ${name}`);
    onChange(next.join(", "));
    setDraft("");
    setQuery("");
    setActive(0);
    setOpen(false);
    inputRef.current?.focus();
  };

  const remove = (name: string) => {
    onChange(tokens.filter(token => token.toLowerCase() !== name.toLowerCase()).join(", "));
  };

  return (
    <div className="relative">
      <div
        className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring/40"
        onClick={() => inputRef.current?.focus()}
      >
        {tokens.map(token => (
          <span key={token} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm">
            {token}
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${token}`}
              onClick={event => {
                event.stopPropagation();
                remove(token);
              }}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <div className="relative min-w-36 flex-1">
          {ghost ? (
            <div className="pointer-events-none absolute inset-0 flex items-center px-2 text-sm">
              <span className="whitespace-pre text-transparent">{draft}</span>
              <span className="text-muted-foreground/70">{ghost}</span>
            </div>
          ) : null}
          <Input
            ref={inputRef}
            value={draft}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            aria-activedescendant={highlighted ? `${listId}-${highlighted.id}` : undefined}
            placeholder={tokens.length ? "" : "Start typing a phenotype"}
            className="h-8 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            onChange={event => {
              setDraft(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={event => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setActive(index => Math.min(index + 1, Math.max(suggestions.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(index => Math.max(index - 1, 0));
              } else if (event.key === "Tab" && open && highlighted && draft.trim()) {
                event.preventDefault();
                commit(highlighted.name);
              } else if ((event.key === "Enter" || event.key === ",") && draft.trim()) {
                event.preventDefault();
                commit(open && highlighted ? highlighted.name : draft);
              } else if (event.key === "Escape") {
                setOpen(false);
              } else if (event.key === "Backspace" && !draft && tokens.length) {
                remove(tokens[tokens.length - 1]);
              }
            }}
          />
        </div>
      </div>
      {open && query.length >= 2 ? (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-lg">
          {search.isError ? <li className="px-3 py-2 text-muted-foreground">Could not search HPO terms.</li> : null}
          {!search.isError && search.isFetching && suggestions.length === 0 ? <li className="px-3 py-2 text-muted-foreground">Searching HPO…</li> : null}
          {!search.isError && !search.isFetching && suggestions.length === 0 ? <li className="px-3 py-2 text-muted-foreground">No HPO term is close to that.</li> : null}
          {suggestions.map((item, index) => (
            <li
              key={item.id}
              id={`${listId}-${item.id}`}
              role="option"
              aria-selected={index === active}
              className={cn("flex cursor-pointer items-baseline justify-between gap-4 rounded-md px-3 py-2", index === active && "bg-accent text-accent-foreground")}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(item.name)}
            >
              <span>{item.name}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.id}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

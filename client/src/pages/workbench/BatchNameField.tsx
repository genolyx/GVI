import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";

export function BatchNameField({
  name,
  disabled,
  onSave,
  className,
}: {
  name: string;
  disabled?: boolean;
  onSave: (name: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  useEffect(() => {
    if (!editing) setValue(name);
  }, [editing, name]);

  if (disabled) return <span className={className}>{name}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        className={cn("inline-flex max-w-full items-center gap-1.5 text-left hover:text-primary", className)}
        onClick={() => setEditing(true)}
      >
        <span className="truncate">{name}</span>
        <Pencil className="size-3 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <Input
      autoFocus
      value={value}
      aria-label="Batch name"
      className={cn("h-8 min-w-40", className)}
      onChange={event => setValue(event.target.value)}
      onBlur={event => {
        const next = event.currentTarget.value.trim();
        setEditing(false);
        if (next && next !== name) onSave(next);
        else setValue(name);
      }}
      onKeyDown={event => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setValue(name);
          setEditing(false);
        }
      }}
    />
  );
}

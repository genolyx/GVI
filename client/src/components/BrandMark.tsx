import { cn } from "@/lib/utils";
import { useTheme } from "@/contexts/ThemeContext";

export function GenolyxWordmark({ className, onDark }: { className?: string; onDark?: boolean }) {
  const { theme } = useTheme();
  const lightInk = !onDark && theme === "light";
  return (
    <img
      src={lightInk ? "/brand/genolyx-wordmark-light.png?v=10" : "/brand/genolyx-wordmark.png?v=9"}
      alt="Genolyx"
      className={cn("h-7 w-auto max-w-[160px] object-contain object-left", className)}
    />
  );
}

export function GenolyxMark({ className }: { className?: string }) {
  const { theme } = useTheme();
  return (
    <img
      src={theme === "light" ? "/brand/genolyx-gx-light.png?v=10" : "/brand/genolyx-gx.png"}
      alt="Genolyx"
      className={cn("size-9 object-contain", className)}
    />
  );
}

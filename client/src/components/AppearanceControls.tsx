import { Slider } from "@/components/ui/slider";
import { type FontStep, useTheme } from "@/contexts/ThemeContext";
import { Moon, Sun } from "lucide-react";

export function AppearanceControls() {
  const { theme, toggleTheme, fontStep, setFontStep } = useTheme();

  return (
    <div className="space-y-3 px-2 py-2">
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        className="flex h-8 w-full items-center justify-between rounded-md px-1 text-sm hover:bg-accent"
      >
        {theme === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        <span className="flex-1 px-2 text-left font-medium">
          {theme === "dark" ? "Dark" : "Light"}
        </span>
      </button>

      <div>
        <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Text size</span>
          <span className="tabular-nums">{fontStep}/5</span>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-[10px] font-semibold text-muted-foreground">A</span>
          <Slider
            min={1}
            max={5}
            step={1}
            value={[fontStep]}
            onValueChange={value => {
              const next = value[0];
              if (next >= 1 && next <= 5) setFontStep(next as FontStep);
            }}
            aria-label="Text size"
          />
          <span aria-hidden className="text-sm font-semibold">A</span>
        </div>
      </div>
    </div>
  );
}

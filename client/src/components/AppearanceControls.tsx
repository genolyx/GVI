import { Slider } from "@/components/ui/slider";
import { type FontStep, useTheme } from "@/contexts/ThemeContext";
import { Moon, Sun } from "lucide-react";

export function AppearanceControls({ collapsed }: { collapsed: boolean }) {
  const { theme, toggleTheme, fontStep, setFontStep } = useTheme();

  return (
    <div className={collapsed ? "space-y-2" : "mb-3 space-y-3 rounded-xl border border-sidebar-border/80 bg-sidebar-accent/40 p-3"}>
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        className={
          collapsed
            ? "grid size-9 place-items-center rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            : "flex h-8 w-full items-center justify-between rounded-lg px-1 text-sidebar-foreground hover:bg-sidebar-accent/80"
        }
      >
        {theme === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        {collapsed ? null : (
          <span className="flex-1 px-2 text-left text-[10px] font-medium uppercase tracking-wider">
            {theme === "dark" ? "Dark" : "Light"}
          </span>
        )}
      </button>

      {collapsed ? null : (
        <div>
          <div className="mb-2 flex items-center justify-between text-[9px] uppercase tracking-wider text-sidebar-foreground/50">
            <span>Text size</span>
            <span className="tabular-nums">{fontStep}/5</span>
          </div>
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-[9px] font-semibold text-sidebar-foreground/55">A</span>
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
            <span aria-hidden className="text-[13px] font-semibold text-sidebar-foreground/80">A</span>
          </div>
        </div>
      )}
    </div>
  );
}

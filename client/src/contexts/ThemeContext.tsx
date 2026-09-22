import React, { createContext, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type FontStep = 1 | 2 | 3 | 4 | 5;

const THEME_KEY = "gvi-theme";
const FONT_KEY = "gvi-font-step";

export const FONT_SCALES: Record<FontStep, number> = {
  1: 1,
  2: 1.1,
  3: 1.2,
  4: 1.32,
  5: 1.45,
};

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  fontStep: FontStep;
  setFontStep: (step: FontStep) => void;
  switchable: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function readStoredTheme(fallback: Theme): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : fallback;
  } catch {
    return fallback;
  }
}

function readStoredFontStep(): FontStep {
  try {
    const raw = Number(localStorage.getItem(FONT_KEY));
    if (raw >= 1 && raw <= 5) return raw as FontStep;
  } catch {
    /* ignore */
  }
  return 1;
}

function applyAppearance(theme: Theme, fontStep: FontStep) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
  root.dataset.fontStep = String(fontStep);
  root.style.setProperty("--font-scale", String(FONT_SCALES[fontStep]));
}

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  switchable?: boolean;
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  switchable = true,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(defaultTheme));
  const [fontStep, setFontStepState] = useState<FontStep>(() => readStoredFontStep());

  useEffect(() => {
    applyAppearance(theme, fontStep);
    try {
      localStorage.setItem(THEME_KEY, theme);
      localStorage.setItem(FONT_KEY, String(fontStep));
    } catch {
      /* private mode */
    }
  }, [theme, fontStep]);

  const setTheme = (next: Theme) => setThemeState(next);
  const toggleTheme = () => setThemeState(prev => (prev === "light" ? "dark" : "light"));
  const setFontStep = (step: FontStep) => setFontStepState(step);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, fontStep, setFontStep, switchable }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

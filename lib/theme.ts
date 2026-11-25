// The browser only chooses light, dark, or the system's scheme; omp's `theme.light` / `theme.dark`
// settings choose the palette painted for each (`lib/omp-theme.ts`).
export const THEME_PREFERENCES = ["auto", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, "auto">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

export function isDarkTheme(theme: ResolvedTheme): boolean {
  return theme === "dark";
}

// Apply the saved scheme before first paint, including when storage is blocked.
export const THEME_INIT_SCRIPT = `(function(){var t="auto";try{var s=localStorage.getItem("pi-theme");if(${JSON.stringify(THEME_PREFERENCES)}.includes(s))t=s}catch(e){}if(t==="auto")t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var r=document.documentElement;r.dataset.theme=t;r.classList.toggle("dark",t==="dark")})();`;

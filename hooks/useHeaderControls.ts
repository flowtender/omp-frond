import { useSyncExternalStore } from "react";

function headerVisibilityPreference(key: string) {
  let visible: boolean | undefined;
  const listeners = new Set<() => void>();

  function snapshot() {
    if (visible === undefined) {
      try { visible = window.localStorage.getItem(key) !== "false"; }
      catch { visible = true; }
    }
    return visible;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return {
    useVisible: () => useSyncExternalStore(subscribe, snapshot, () => true),
    setVisible(next: boolean) {
      visible = next;
      try { window.localStorage.setItem(key, String(next)); } catch {}
      listeners.forEach((listener) => listener());
    },
  };
}

export const headerThemeSwitch = headerVisibilityPreference("omp-show-header-theme-switch");
export const headerLanguageSwitch = headerVisibilityPreference("omp-show-header-language-switch");

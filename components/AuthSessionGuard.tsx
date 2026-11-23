"use client";

import { useEffect } from "react";

export function AuthSessionGuard() {
  useEffect(() => {
    if (window.location.pathname === "/login" || window.location.pathname === "/recover") return;
    const controller = new AbortController();
    async function checkSession() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/web-access", { cache: "no-store", signal: controller.signal });
        if (response.status === 401) {
          window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        }
      } catch {
        // Offline clients keep their current screen until they reconnect.
      }
    }
    void checkSession();
    const timer = window.setInterval(() => void checkSession(), 60_000);
    document.addEventListener("visibilitychange", checkSession);
    window.addEventListener("online", checkSession);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkSession);
      window.removeEventListener("online", checkSession);
    };
  }, []);
  return null;
}

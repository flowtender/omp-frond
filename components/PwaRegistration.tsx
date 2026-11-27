"use client";

import { useEffect } from "react";

// Same prefixes public/sw.js deletes on activate.
const SERVICE_WORKER_CACHE_PREFIXES = ["omp-frond-", "omp-web-", "pi-web-"];

// The service worker only runs in production builds. A dev server on an origin
// that once ran a production build would otherwise keep serving that build's
// cached chunks through the old worker, so remove it and its caches.
async function removeLeftoverServiceWorker(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));

  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => SERVICE_WORKER_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .map((name) => caches.delete(name)),
  );

  // This page was loaded through the old worker; reload once so it is not.
  // After the reload there is no controller, so this cannot loop.
  if (navigator.serviceWorker.controller) window.location.reload();
}

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      removeLeftoverServiceWorker().catch((error: unknown) => {
        console.error("Failed to remove the leftover omp-frond service worker:", error);
      });
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).catch((error: unknown) => {
        console.error("Failed to register the omp-frond service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

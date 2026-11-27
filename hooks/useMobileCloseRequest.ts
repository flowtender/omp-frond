import { useEffect, useEffectEvent } from "react";

type CloseWatcher = EventTarget & { destroy(): void };

/** Let the browser deliver Android Back to an open surface without changing history. */
export function useMobileCloseRequest(active: boolean, onClose: () => void): void {
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const Watcher = (window as Window & { CloseWatcher?: new () => CloseWatcher }).CloseWatcher;
    if (!active || !Watcher) return;
    const watcher = new Watcher();
    watcher.addEventListener("close", () => close());
    return () => watcher.destroy();
  }, [active]);
}

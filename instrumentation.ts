export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Under Bun, undici is not the fetch stack.
    if (typeof process.versions.bun === "string") return;
    const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
    await configureHttpDispatcher();
  }
}

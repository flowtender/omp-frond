import type { configureHttpDispatcher as ConfigureHttpDispatcher } from "@/lib/http-dispatcher";

type DispatcherModule = { configureHttpDispatcher: typeof ConfigureHttpDispatcher };

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Under `bun --bun next` undici is not the fetch stack, so the dispatcher
  // tuning only applies to real Node. Node 22 can load the local TypeScript
  // module directly; the dynamic string specifier keeps the Node-only undici
  // graph out of Next's browser/edge instrumentation bundles.
  if (typeof process.versions.bun === "string") return;

  const importRuntimeModule = Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<DispatcherModule>;
  const moduleUrl = `file://${encodeURI(process.cwd())}/lib/http-dispatcher.ts`;
  const { configureHttpDispatcher } = await importRuntimeModule(moduleUrl);
  await configureHttpDispatcher();
}

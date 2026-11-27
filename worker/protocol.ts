import type { ModelsData } from "@/lib/models-cache";

export const WORKER_CONTROL_HOST = "127.0.0.1";
export const WORKER_ID_HEADER = "x-omp-frond-worker";
export const WORKER_BROWSER_HOST_HEADER = "x-omp-frond-browser-host";
export const WORKER_UNAVAILABLE_CODE = "worker_unavailable";
export const WORKER_UNAVAILABLE_MESSAGE = "The SDK worker is unavailable.";

export type WorkerModelsResult =
  | { status: 200; data: ModelsData }
  | { status: 400 | 403; data: { error: string } };

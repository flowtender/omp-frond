import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { modelRefProvider } from "./enabled-models";

/**
 * Which models omp-web has already shown, so the Models panel can tag the ones
 * that appeared since.
 *
 * omp's catalog has no release dates, so "new" can only mean "available now,
 * and not available the last time omp-web looked". The record lives next to
 * the agent config like the project-trust store, so it survives restarts and is
 * shared by every omp-web instance on the same agent directory.
 *
 * Baselines are per provider: the first time a provider shows up at all (the
 * store is created, or the user signs in to it), its whole catalog is recorded
 * as seen. Otherwise signing in to a provider would tag every model it offers.
 * A model stays tagged until it is switched in the panel or a prompt runs on it.
 *
 * Reads and writes are synchronous, so one read-modify-write cannot interleave
 * with another request's in this process.
 */

const SEEN_MODELS_FILE = "omp-web-seen-models.json";

interface SeenModels {
  /** Providers whose catalog has been baselined. */
  providers: string[];
  /** `provider/modelId` references already shown or used. */
  models: string[];
}

/** The stored record; empty when there is none yet or it cannot be parsed. */
function readSeenModels(agentDir: string): SeenModels {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, SEEN_MODELS_FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const { providers, models } = parsed as Record<string, unknown>;
      const strings = (value: unknown) => Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
      return { providers: strings(providers), models: strings(models) };
    }
  } catch {
    // Missing or unreadable: every provider gets baselined again.
  }
  return { providers: [], models: [] };
}

function writeSeenModels(agentDir: string, seen: SeenModels): void {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(join(agentDir, SEEN_MODELS_FILE), `${JSON.stringify(seen, null, 2)}\n`);
}

/**
 * Baseline providers seen for the first time, and return the available
 * references that have not been seen yet.
 */
export function reconcileSeenModels(agentDir: string, availableRefs: readonly string[]): Set<string> {
  const stored = readSeenModels(agentDir);
  const knownProviders = new Set(stored.providers);
  const providers = new Set(stored.providers);
  const models = new Set(stored.models);

  for (const ref of availableRefs) {
    const provider = modelRefProvider(ref);
    if (knownProviders.has(provider)) continue;
    providers.add(provider);
    models.add(ref);
  }
  if (providers.size > knownProviders.size) {
    writeSeenModels(agentDir, { providers: [...providers], models: [...models] });
  }

  return new Set(availableRefs.filter((ref) => !models.has(ref)));
}

/** Record `refs` as seen, clearing their "new" tag. */
export function markModelsSeen(agentDir: string, refs: readonly string[]): void {
  const stored = readSeenModels(agentDir);
  const models = new Set(stored.models);
  const unseen = refs.filter((ref) => !models.has(ref));
  if (unseen.length === 0) return;
  writeSeenModels(agentDir, { providers: stored.providers, models: [...models, ...unseen] });
}

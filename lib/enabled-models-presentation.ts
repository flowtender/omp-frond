import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { createModelBrowserSource } from "@oh-my-pi/pi-coding-agent/modes/model-browser-source";
import {
  buildBrowserItems,
  heldRoles,
  recentBlockLength,
  resolveRoleAssignments,
  roleChipLabel,
  sortModelItems,
  type ModelBrowserItem,
} from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/model-browser";
import type { EnabledModelsView } from "./enabled-models";

/** Order the switch rows like omp's browser without changing the switch scope. */
export function groupEnabledModelRows(
  view: EnabledModelsView,
  settings: Settings,
  registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
  models: readonly Model[],
): void {
  if (view.providers.length === 0) return;
  const source = createModelBrowserSource(settings);
  const roles = resolveRoleAssignments(source, registry.getAll("all"), registry.getAvailable("all"));
  const mruOrder = source.mruOrder;
  const byProvider = new Map<string, ModelBrowserItem[]>();
  for (const item of buildBrowserItems(models)) {
    const items = byProvider.get(item.provider);
    if (items) items.push(item);
    else byProvider.set(item.provider, [item]);
  }
  for (const provider of view.providers) {
    const items = byProvider.get(provider.id)!;
    sortModelItems(items, { roles, mruOrder });
    const recent = recentBlockLength(items, roles, mruOrder);
    const rows = new Map(provider.models.map(row => [row.ref, row]));
    provider.models = items.map((item, index) => {
      const row = rows.get(item.selector)!;
      if (index < recent) row.recent = true;
      const assignments = heldRoles(item.model, roles, source);
      if (assignments.length) {
        row.roles = assignments.map(({ role, assignment }) => ({
          role,
          label: roleChipLabel(role, source),
          ...(assignment.autoSelected ? { auto: true } : {}),
        }));
      }
      return row;
    });
  }
}

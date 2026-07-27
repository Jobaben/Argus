import { useLiveResource } from "./live/useLiveResource";

import type { Inventory, InventoryItem, PluginItem } from "@argus/contracts";

export type { Inventory, InventoryItem, PluginItem };

/** Loads the extensions inventory, refreshing on "inventory:changed" (the
 *  server watches the extension dirs), with a slow poll fallback. */
export function useInventory() {
  const { data, loading, error, refresh } = useLiveResource<Inventory | null>("/api/inventory", {
    events: ["inventory:changed"],
    select: (j) => j as Inventory,
    initial: null,
    pollMs: 30000,
  });
  return { inventory: data, loading, error, refresh };
}

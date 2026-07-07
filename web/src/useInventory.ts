import { useLiveResource } from "./live/useLiveResource";

export interface InventoryItem {
  name: string;
  description: string;
}

export interface PluginItem {
  name: string;
  description: string;
  version: string;
  marketplace: string;
}

export interface Inventory {
  agents: InventoryItem[];
  commands: InventoryItem[];
  skills: InventoryItem[];
  plugins: PluginItem[];
}

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

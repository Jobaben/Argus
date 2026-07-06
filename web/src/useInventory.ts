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

/** Loads the extensions inventory. No push event, so polls on a 10s timer. */
export function useInventory() {
  const { data, loading, error, refresh } = useLiveResource<Inventory | null>("/api/inventory", {
    select: (j) => j as Inventory,
    initial: null,
    pollMs: 10000,
  });
  return { inventory: data, loading, error, refresh };
}

import { useCallback, useEffect, useRef, useState } from "react";

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

interface InventoryState {
  inventory: Inventory | null;
  loading: boolean;
  error: string | null;
}

/** Loads the extensions inventory from /api/inventory with polling refresh. */
export function useInventory(): InventoryState & { refresh: () => void } {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/inventory");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Inventory;
      if (!mounted.current) return;
      setInventory(data);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 10000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
    };
  }, [refresh]);

  return { inventory, loading, error, refresh };
}

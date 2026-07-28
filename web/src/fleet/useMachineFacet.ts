import { useCallback, useMemo, useState } from "react";
import { useFleet } from "../useFleet";
import type { FleetMachine } from "../types";

/**
 * Which machine a fleet-wide view is currently showing.
 *
 * Held in `sessionStorage`, not the URL. The choice is a lens on the page you
 * are already on, not a different page — putting it in the hash would make the
 * back button undo a filter, and would make every deep link somebody shares
 * carry whichever machine they happened to be looking at.
 *
 * In solo mode this collapses to nothing: `machines` is empty, the picker
 * renders null, and every view takes exactly the code path it had before
 * federation existed. That is what keeps single-machine zero-config.
 */

const KEY = "argus.machineFacet";

function readStored(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    // Private mode, or storage disabled. A remembered filter is a nicety.
    return null;
  }
}

export interface MachineFacetState {
  /** Null means "this machine" — the default and the solo-mode answer. */
  selected: string | null;
  select: (machineId: string | null) => void;
  /** Empty in solo mode, so callers can render nothing without a second check. */
  machines: FleetMachine[];
  /** The chosen peer, or null when showing this machine. */
  peer: FleetMachine | null;
  soloMode: boolean;
}

export function useMachineFacet(): MachineFacetState {
  const { fleet } = useFleet();
  const [selected, setSelected] = useState<string | null>(readStored);

  const select = useCallback((machineId: string | null) => {
    setSelected(machineId);
    try {
      if (machineId) sessionStorage.setItem(KEY, machineId);
      else sessionStorage.removeItem(KEY);
    } catch {
      /* the in-memory choice still works */
    }
  }, []);

  return useMemo(() => {
    const machines = fleet.soloMode ? [] : fleet.machines;
    // A selection that no longer exists — the peer was unpaired in another tab —
    // falls back to this machine rather than showing an empty page for a
    // machine that is gone.
    const peer = machines.find((m) => !m.isSelf && m.peer.id === selected) ?? null;
    return {
      selected: peer ? selected : null,
      select,
      machines,
      peer,
      soloMode: fleet.soloMode,
    };
  }, [fleet, selected, select]);
}

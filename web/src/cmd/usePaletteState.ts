import { useCallback, useState } from "react";

/** Open/close state for the palette, kept out of the render-heavy shell — and
 *  out of `usePalette`'s module, whose command builder loads with the palette. */
export function usePaletteState(): {
  open: boolean;
  toggle: () => void;
  show: () => void;
  hide: () => void;
} {
  const [open, setOpen] = useState(false);
  return {
    open,
    toggle: useCallback(() => setOpen((o) => !o), []),
    show: useCallback(() => setOpen(true), []),
    hide: useCallback(() => setOpen(false), []),
  };
}

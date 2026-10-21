import { CommandPalette } from "./CommandPalette";
import { usePalette } from "./usePalette";

/**
 * The palette with its own command list: the search index it fetches while
 * open, and the commands built from it. In one module so the shell can load
 * all of it lazily — nothing here is needed until the first ⌘K.
 */
export function PaletteHost({
  open,
  onClose,
  context,
}: {
  open: boolean;
  onClose: () => void;
  context: Parameters<typeof usePalette>[1];
}) {
  const { commands, loading } = usePalette(open, context);
  return <CommandPalette open={open} onClose={onClose} commands={commands} loading={loading} />;
}

import { useState } from "react";
import { useSetup } from "../useSetup";
import type { PrereqResult } from "../useSetup";

function Item({ p }: { p: PrereqResult }) {
  const ok = p.status === "ok";
  return (
    <li className="flex items-baseline gap-2 font-mono text-[11px]">
      <span className={ok ? "text-ok" : "text-fail"}>{ok ? "✓" : "✗"}</span>
      <span className="text-ink-dim">{p.label}</span>
      {!ok && p.detail && <span className="text-ink-faint">— {p.detail}</span>}
    </li>
  );
}

export default function SetupBanner() {
  const { ok, prereqs, apply } = useSetup();
  const [busy, setBusy] = useState(false);

  if (ok) return null;

  const hasFixable = prereqs.some((p) => p.status === "missing" && p.fixable);

  const onApply = () => {
    setBusy(true);
    // On success the hook state re-checks and the banner unmounts; on failure we re-enable.
    void apply().catch(() => setBusy(false));
  };

  return (
    <div className="mx-auto my-4 max-w-5xl rounded-tile border border-fail/40 bg-fail/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-fail">
          Setup incomplete
        </span>
        {hasFixable && (
          <button
            type="button"
            onClick={onApply}
            disabled={busy}
            className="ml-auto rounded-md border border-ok bg-ok/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-ok disabled:opacity-40"
          >
            Apply fixes
          </button>
        )}
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {prereqs.map((p) => (
          <Item key={p.id} p={p} />
        ))}
      </ul>
    </div>
  );
}

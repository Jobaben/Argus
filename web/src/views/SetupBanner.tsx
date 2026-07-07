import { useState } from "react";
import { useSetup } from "../useSetup";
import type { PrereqResult } from "../useSetup";

function Item({ p }: { p: PrereqResult }) {
  const ok = p.status === "ok";
  const outdated = p.status === "outdated";
  const mark = ok ? "✓" : outdated ? "⚠" : "✗";
  const markClass = ok ? "text-ok" : outdated ? "text-run" : "text-fail";
  return (
    <li className="flex items-baseline gap-2 font-mono text-[11px]">
      <span className={markClass}>{mark}</span>
      <span className="text-ink-dim">{p.label}</span>
      {outdated && <span className="text-run">— outdated</span>}
      {!ok && p.detail && <span className="text-ink-faint">— {p.detail}</span>}
    </li>
  );
}

export default function SetupBanner() {
  const { ok, prereqs, apply } = useSetup();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (ok) return null;

  const hasFixable = prereqs.some(
    (p) => (p.status === "missing" || p.status === "outdated") && p.fixable,
  );

  const onApply = () => {
    setBusy(true);
    setErr(null);
    // On success the hook state re-checks and the banner unmounts; on failure
    // we surface the reason and re-enable.
    void apply().catch((e: unknown) => {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
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
            {busy ? "Applying…" : "Apply fixes"}
          </button>
        )}
      </div>
      {err && (
        <p role="alert" className="mt-2 font-mono text-[11px] text-fail">
          Apply failed: {err}
        </p>
      )}
      <ul className="mt-2 flex flex-col gap-1">
        {prereqs.map((p) => (
          <Item key={p.id} p={p} />
        ))}
      </ul>
    </div>
  );
}

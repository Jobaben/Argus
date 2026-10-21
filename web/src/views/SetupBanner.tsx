import { useState } from "react";
import { useSetup } from "../useSetup";
import type { PrereqResult } from "../useSetup";
import { Button, Icon } from "../ds";

function Item({ p }: { p: PrereqResult }) {
  const ok = p.status === "ok";
  const outdated = p.status === "outdated";
  const markClass = ok ? "text-ok" : outdated ? "text-run" : "text-fail";
  return (
    <li className="flex items-center gap-2 text-small">
      <Icon
        name={ok ? "check" : outdated ? "alert" : "close"}
        size={14}
        label={ok ? "ok" : outdated ? "outdated" : "missing"}
        className={markClass}
      />
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
    // On the page grid, not a narrower box of its own; amber, because an
    // unfinished setup is something to do rather than something that broke.
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6">
      <div className="rounded-tile border border-run/35 bg-gradient-to-r from-run/10 to-run/[0.03] px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Icon name="alert" size={18} className="text-run" />
          <span className="text-small font-semibold text-ink">Setup incomplete</span>
          <span className="text-small text-ink-dim">
            Argus needs these in place before every run can report back.
          </span>
          {hasFixable && (
            <Button
              variant="primary"
              size="sm"
              icon="bolt"
              onClick={onApply}
              disabled={busy}
              className="ml-auto"
            >
              {busy ? "Applying…" : "Apply fixes"}
            </Button>
          )}
        </div>
        {err && (
          <p role="alert" className="mt-2 text-small text-fail-ink">
            Apply failed: {err}
          </p>
        )}
        <ul className="mt-2.5 flex flex-col gap-1 pl-[30px]">
          {prereqs.map((p) => (
            <Item key={p.id} p={p} />
          ))}
        </ul>
      </div>
    </div>
  );
}

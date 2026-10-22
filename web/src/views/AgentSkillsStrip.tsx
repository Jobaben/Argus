import { useState } from "react";
import type { AgentSkillState, AgentSkillStatus } from "@argus/contracts";
import { useAgentSkills, type AgentSkillsInstallResponse } from "../useAgentSkills";
import { RUNTIME_META } from "../useRuntimes";
import { Button, Icon } from "../ds";

const STATE_TEXT: Record<AgentSkillState, string> = {
  missing: "not installed",
  current: "up to date",
  outdated: "older than this build",
  modified: "older than this build, and edited since — a copy is kept when it is replaced",
  unmanaged: "installed some other way, and different from this build — a copy is kept",
};

function Row({ s }: { s: AgentSkillStatus }) {
  const missing = s.state === "missing";
  return (
    <li className="flex flex-wrap items-center gap-x-2 text-small">
      <Icon
        name={missing ? "close" : "alert"}
        size={14}
        label={missing ? "missing" : "out of date"}
        className={missing ? "text-ink-faint" : "text-run"}
      />
      <span className="font-mono text-ink-dim">{s.skill}</span>
      <span className="text-ink-faint">· {RUNTIME_META[s.runtime].label}</span>
      <span className="text-ink-faint">— {STATE_TEXT[s.state]}</span>
    </li>
  );
}

/** One line per thing an install did that the reader should know about. */
function Outcome({ result }: { result: AgentSkillsInstallResponse }) {
  const failed = result.results.filter((r) => r.action === "failed");
  const kept = result.results.filter((r) => r.backup);
  return (
    <div className="mt-2 flex flex-col gap-1 text-small">
      {failed.length === 0 ? (
        <p className="text-ink-dim">
          Installed. A new Claude Code or Codex session picks the skills up.
        </p>
      ) : (
        failed.map((r) => (
          <p key={`${r.skill}:${r.runtime}`} role="alert" className="text-fail-ink">
            Could not write {r.skill} for {RUNTIME_META[r.runtime].label}: {r.error}
          </p>
        ))
      )}
      {kept.map((r) => (
        <p key={`${r.skill}:${r.runtime}:kept`} className="text-ink-faint">
          The {r.skill} copy it replaced for {RUNTIME_META[r.runtime].label} is saved at{" "}
          <span className="font-mono break-all">{r.backup}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * The agent skills Argus ships teach Claude Code and Codex how this build
 * works — `argus-pipeline` above all, which is how an agent authors a pipeline
 * that saves and runs. This strip says when a copy in an agent home is missing
 * or has fallen behind, and installs them on a press. Only on a press: the
 * server never writes into a person's agent homes by itself.
 */
export default function AgentSkillsStrip({ isAdmin }: { isAdmin: boolean }) {
  const { skills, upToDate, loading, error, install } = useAgentSkills();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<AgentSkillsInstallResponse | null>(null);

  // A status read that failed says nothing about the skills; the page has
  // more important things to say than that.
  if (loading || error) return null;
  if (upToDate && !result) return null;

  const stale = skills.filter((s) => s.state !== "current");

  const onInstall = () => {
    setBusy(true);
    setErr(null);
    install()
      .then((r) => setResult(r))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (upToDate && result) {
    return (
      <div className="mb-6 rounded-tile border border-ok/30 bg-ok/[0.06] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Icon name="check" size={18} className="text-ok" />
          <span className="text-small font-semibold text-ink">Agent skills up to date</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setResult(null)}>
            Dismiss
          </Button>
        </div>
        <Outcome result={result} />
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-tile border border-run/35 bg-gradient-to-r from-run/10 to-run/[0.03] px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon name="alert" size={18} className="text-run" />
        <span className="text-small font-semibold text-ink">Agent skills</span>
        <span className="min-w-0 flex-1 basis-60 text-small text-ink-dim">
          Agents on this machine learn to author pipelines from these skills, and some copies are
          missing or do not match this build of Argus.
        </span>
        {isAdmin ? (
          <Button
            variant="primary"
            size="sm"
            icon="bolt"
            onClick={onInstall}
            disabled={busy}
            className="ml-auto"
          >
            {busy ? "Installing…" : "Install skills"}
          </Button>
        ) : (
          <span className="text-small text-ink-faint">
            Sign in to install them, or run <code>argus skills install</code>.
          </span>
        )}
      </div>
      <ul className="mt-2.5 flex flex-col gap-1 pl-[30px]">
        {stale.map((s) => (
          <Row key={`${s.skill}:${s.runtime}`} s={s} />
        ))}
      </ul>
      {err && (
        <p role="alert" className="mt-2 pl-[30px] text-small text-fail-ink">
          Install failed: {err}
        </p>
      )}
      {result && (
        <div className="pl-[30px]">
          <Outcome result={result} />
        </div>
      )}
    </div>
  );
}

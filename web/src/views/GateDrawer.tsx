import { Fragment, useState } from "react";
import { Drawer, Skeleton, StatusPill, isMarkdown } from "../ds";
import { Markdown } from "../ds/Markdown";
import { useArtifactContent, useGateReview } from "../useGateReview";
import type { GateActionOptions } from "../useOverview";
import type { PhaseArtifact, PhaseReview } from "../types";

/**
 * The one place a human decides on a gate.
 *
 * A gated phase parks with whatever its agent left — a payload, a structured
 * result, Argus's own checks, and the files in its artifact directory. Before
 * this drawer the board offered Approve and Revise beside a phase with no way to
 * see any of that; approving was a leap of faith and the palette could even do
 * it blind. Now every other surface (the board's focus panel, the situation
 * strip, the palette, `argus tail`) *points here*, and the two buttons exist in
 * this component and nowhere else in the web UI.
 *
 * The review is read-only. Approve continues the pipeline with exactly what is
 * shown; Revise sends a note back and the phase runs again — the revision *is*
 * the note, so nothing here edits an artifact.
 */

export interface GateSelection {
  instanceId: string;
  phaseId: string;
  pipelineName: string;
  /** Viewport Y of the opener, so the drawer grows from that row. */
  originY?: number;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Fragment>
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-[12.5px] text-ink-dim">{children}</dd>
    </Fragment>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
      {children}
    </h3>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The prose a payload carries, in the order it is shown, and the fields left
 *  once that prose is lifted out. `reason` is one sentence, so it stays plain
 *  text; `summary` and `last_assistant_message` are the agent's own writing,
 *  which Claude Code (and the agent's closing note in general) formats as
 *  markdown. */
const PROSE_FIELDS = ["reason", "summary", "last_assistant_message"] as const;

function splitPayload(value: Record<string, unknown>) {
  const prose: Partial<Record<(typeof PROSE_FIELDS)[number], string>> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if ((PROSE_FIELDS as readonly string[]).includes(k) && typeof v === "string" && v.trim()) {
      prose[k as (typeof PROSE_FIELDS)[number]] = v;
    } else {
      rest[k] = v;
    }
  }
  return { prose, rest };
}

/**
 * The agent's closing words.
 *
 * A phase's payload is usually the whole event the runtime handed the Stop
 * hook — session id, transcript path, permission mode, background tasks — with
 * the agent's final message as one field among a dozen, plus the `reason`
 * and `failureClass` Argus attached. What a reviewer wants is the reason and
 * the note; the rest is diagnostic, so it folds behind a toggle and only
 * comes forward when there is no prose to show instead. A bare string is
 * treated as the note itself.
 */
function Payload({ value }: { value: unknown }) {
  if (value == null) return null;
  if (typeof value === "string") {
    return <ClosingNote source={value} />;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return <RawPayload value={value} />;
  }
  const { prose, rest } = splitPayload(value as Record<string, unknown>);
  const hasProse = Object.keys(prose).length > 0;
  const hasRest = Object.keys(rest).length > 0;
  if (!hasProse) return <RawPayload value={value} />;
  return (
    <div className="flex flex-col gap-2">
      {prose.reason && (
        <p
          data-testid="gate-reason"
          className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink"
        >
          {prose.reason}
        </p>
      )}
      {prose.summary && <ClosingNote source={prose.summary} />}
      {prose.last_assistant_message && <ClosingNote source={prose.last_assistant_message} />}
      {hasRest && (
        <details>
          <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint hover:text-ink-dim">
            Raw payload
          </summary>
          <div className="mt-2">
            <RawPayload value={rest} />
          </div>
        </details>
      )}
    </div>
  );
}

function ClosingNote({ source }: { source: string }) {
  return (
    <div
      data-testid="gate-closing-note"
      className="rounded-lg border border-line bg-surface px-4 py-3"
    >
      <Markdown source={source} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
    </div>
  );
}

function RawPayload({ value }: { value: unknown }) {
  return (
    <pre
      data-testid="gate-raw-payload"
      className="max-h-[30vh] overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-ink-dim"
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Verification({ report }: { report: NonNullable<PhaseReview["verification"]> }) {
  return (
    <ul data-testid="gate-verification" className="flex flex-col gap-1">
      {report.checks.map((c, i) => (
        <li key={i} className="flex items-baseline gap-2 text-[12px]">
          <span
            aria-hidden="true"
            className={
              c.status === "passed"
                ? "text-ok"
                : c.status === "failed"
                  ? "text-fail"
                  : "text-ink-faint"
            }
          >
            {c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "…"}
          </span>
          <span className="text-ink-dim">{c.label}</span>
          {c.detail && <span className="min-w-0 break-words text-ink-faint">— {c.detail}</span>}
        </li>
      ))}
      {report.checks.length === 0 && (
        <li className="text-[12px] text-ink-faint">
          {report.status === "running" ? "Checks still running." : "No checks declared."}
        </li>
      )}
    </ul>
  );
}

function ArtifactList({
  artifacts,
  selected,
  onSelect,
}: {
  artifacts: PhaseArtifact[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul aria-label="Artifacts" className="flex flex-col gap-0.5">
      {artifacts.map((a) => {
        const active = a.path === selected;
        return (
          <li key={a.path}>
            <button
              type="button"
              onClick={() => onSelect(a.path)}
              aria-current={active ? "true" : undefined}
              className={`flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left transition duration-(--duration-quick) hover:bg-surface-2 ${
                active ? "bg-surface-2 text-ink" : "text-ink-dim"
              }`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{a.path}</span>
              {a.required && (
                <span className="rounded border border-await/40 px-1 font-mono text-[8.5px] uppercase tracking-[0.1em] text-await">
                  required
                </span>
              )}
              {!a.text && (
                <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-ink-faint">
                  binary
                </span>
              )}
              <span className="font-mono text-[10px] text-ink-faint">{formatBytes(a.bytes)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ArtifactViewer({ selection, path }: { selection: GateSelection; path: string }) {
  const { content, loading, error } = useArtifactContent(
    selection.instanceId,
    selection.phaseId,
    path,
  );
  if (loading) {
    return (
      <div role="status" aria-busy="true" className="mt-3">
        <span className="sr-only">Loading {path}…</span>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-4/5" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="mt-3 text-[12px] text-fail">
        Couldn't load {path}: {error}
      </p>
    );
  }
  if (!content) return null;
  if (!content.text) {
    return (
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-5 gap-y-1.5">
        <Field label="file">
          <span className="font-mono">{content.path}</span>
        </Field>
        <Field label="size">{formatBytes(content.bytes)}</Field>
        <Field label="modified">{new Date(content.modifiedAt).toLocaleString()}</Field>
        <Field label="note">Binary — not shown here.</Field>
      </dl>
    );
  }
  const body = content.content ?? "";
  return (
    <div data-testid="artifact-viewer" className="mt-3">
      {content.truncated && (
        <p className="mb-2 text-[10.5px] text-ink-faint">
          Showing the first {formatBytes(body.length)} of {formatBytes(content.bytes)}.
        </p>
      )}
      {isMarkdown(content.path) ? (
        <div className="rounded-lg border border-line bg-surface px-4 py-3">
          <Markdown source={body} />
        </div>
      ) : (
        <pre
          data-testid="artifact-raw"
          className="max-h-[50vh] overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-ink-dim"
        >
          {body}
        </pre>
      )}
    </div>
  );
}

const BUTTON =
  "rounded-md border px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em] transition-transform duration-(--duration-press) disabled:opacity-40 motion-safe:active:scale-[0.97]";

interface GateActions {
  approve: (instanceId: string, opts?: GateActionOptions) => Promise<unknown>;
  revise: (instanceId: string, note?: string, opts?: GateActionOptions) => Promise<unknown>;
}

export function GateDrawer({
  selection,
  onClose,
  approve,
  revise,
}: GateActions & {
  selection: GateSelection | null;
  onClose: () => void;
}) {
  const { review, loading, error } = useGateReview(
    selection?.instanceId ?? null,
    selection?.phaseId ?? null,
  );
  if (!selection) return <Drawer open={false} title="" onClose={onClose} children={null} />;
  // Fresh state per gate: a different phase, or the same one on a new attempt,
  // must not inherit a half-typed note or a stale "approved" line — so the
  // panel is keyed on both and simply remounts.
  return (
    <GatePanel
      key={`${selection.instanceId}/${selection.phaseId}@${review?.attempt ?? "?"}`}
      selection={selection}
      review={review}
      loading={loading}
      error={error}
      onClose={onClose}
      approve={approve}
      revise={revise}
    />
  );
}

function GatePanel({
  selection,
  review,
  loading,
  error,
  onClose,
  approve,
  revise,
}: GateActions & {
  selection: GateSelection;
  review: PhaseReview | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // Default to the first required artifact, else the first text one, so a
  // gate with one report opens straight onto it.
  const artifacts = review?.artifacts ?? [];
  const defaultPath =
    artifacts.find((a) => a.required && a.text)?.path ??
    artifacts.find((a) => a.text)?.path ??
    artifacts[0]?.path ??
    null;
  const shownPath =
    selectedPath && artifacts.some((a) => a.path === selectedPath) ? selectedPath : defaultPath;

  // On success busy stays true: the gate is expected to leave the board on the
  // next `pipelines:changed`, which also closes the double-click window. A
  // polite status line says what was accepted until then.
  const run = (action: () => Promise<unknown>, sentLabel: string) => {
    setBusy(true);
    setErr(null);
    void action()
      .then(() => setSent(sentLabel))
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };

  const gated = review?.status === "awaiting-approval";
  const failed = review?.status === "failed";
  const retry = failed && (review?.payload as { kind?: string } | null)?.kind === "restarted";
  const reviseLabel = retry ? "Retry" : "Revise";
  const noteRequired = gated;
  const target: GateActionOptions = { phaseId: selection.phaseId };

  return (
    <Drawer
      open
      onClose={onClose}
      originY={selection.originY}
      title={review?.phaseName ?? selection.phaseId}
      subtitle={`${selection.pipelineName}${review ? ` · attempt ${review.attempt + 1}` : ""}`}
      footer={
        review && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {review.canApprove && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() => approve(selection.instanceId, target), "Approved — pipeline resuming")
                  }
                  className={`${BUTTON} border-ok bg-ok/10 text-ok`}
                >
                  Approve
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => setNoteOpen((o) => !o)}
                aria-expanded={noteOpen}
                className={`${BUTTON} border-await bg-await/10 text-await`}
              >
                {reviseLabel}
              </button>
              <span className="ml-auto">
                <StatusPill status={gated ? "await" : "failed"} />
              </span>
            </div>
            {review.canApprove && !noteOpen && (
              <p className="text-[11px] text-ink-faint">
                Approve continues the pipeline with exactly what is shown here.
              </p>
            )}
            {noteOpen && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[11px] text-ink-faint">
                  {retry
                    ? "Runs the phase again. A note is optional."
                    : "Sends it back to the agent with your note; this attempt's files are discarded and the phase runs again."}
                </p>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    aria-label="Revision note"
                    placeholder={noteRequired ? "What should change?" : "Note (optional)"}
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-faint"
                  />
                  <button
                    type="button"
                    disabled={busy || (noteRequired && note.trim() === "")}
                    onClick={() =>
                      run(
                        () => revise(selection.instanceId, note.trim() || undefined, target),
                        retry
                          ? "Retry sent — phase restarting"
                          : "Revision sent — phase restarting",
                      )
                    }
                    className={`${BUTTON} border-await bg-await/10 text-await`}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
            {sent && !err && (
              <p role="status" className="font-mono text-[10px] text-ok">
                {sent}
              </p>
            )}
            {err && (
              <p role="alert" className="font-mono text-[10px] text-fail">
                {err}
              </p>
            )}
          </div>
        )
      }
    >
      {loading && !review ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the review…</span>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="mt-2 h-3 w-4/5" />
          <Skeleton className="mt-2 h-3 w-2/3" />
        </div>
      ) : error && !review ? (
        <p role="alert" className="text-[12px] text-fail">
          Couldn't load the review: {error}
        </p>
      ) : review ? (
        <div className="flex flex-col gap-5">
          <section>
            <Heading>{gated ? "Waiting on you" : "What went wrong"}</Heading>
            {gated && (
              <p className="mb-2 text-[12px] text-ink-faint">
                The pipeline is paused here until you decide.
              </p>
            )}
            {review.payload != null ? (
              <Payload value={review.payload} />
            ) : (
              <p className="text-[12px] text-ink-faint">The agent left no closing note.</p>
            )}
          </section>

          {review.result !== undefined && (
            <section>
              <Heading>Result</Heading>
              <pre
                data-testid="gate-result"
                className="max-h-[30vh] overflow-auto rounded-lg bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-ink-dim"
              >
                {JSON.stringify(review.result, null, 2)}
              </pre>
            </section>
          )}

          {review.verification && (
            <section>
              <Heading>Checks</Heading>
              <Verification report={review.verification} />
            </section>
          )}

          <section>
            <Heading>Artifacts</Heading>
            {artifacts.length === 0 ? (
              <p data-testid="gate-no-artifacts" className="text-[12px] text-ink-faint">
                This phase left no files.
                {review.canApprove ? " Approving continues with the summary above." : ""}
              </p>
            ) : (
              <Fragment>
                {review.truncated && (
                  <p className="mb-1.5 text-[10.5px] text-ink-faint">
                    Showing the first {artifacts.length} files; more exist on disk.
                  </p>
                )}
                <ArtifactList
                  artifacts={artifacts}
                  selected={shownPath}
                  onSelect={setSelectedPath}
                />
                {shownPath && (
                  <ArtifactViewer
                    key={`${shownPath}@${review.attempt}`}
                    selection={selection}
                    path={shownPath}
                  />
                )}
              </Fragment>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

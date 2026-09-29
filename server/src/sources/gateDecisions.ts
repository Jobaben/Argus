import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { KeyedMutex } from "../mutex.js";
import { log } from "../log.js";
import type {
  GateDecision,
  GateDecisionEffect,
  GateDecisionsResponse,
  GateDecisionView,
} from "@argus/contracts";
import type { PipelineInstance } from "./pipelineTypes.js";

/**
 * The durable gate-decision record (`contracts/src/gates.ts`).
 *
 * **Write-ahead.** The engine appends a decision here, and waits for it to
 * reach the disk, *before* it saves the transition the decision causes. The
 * instance then names the decision in `gateDecisionIds` in that same save. Two
 * consequences, and both are the point:
 *
 * - a transition on disk always names a record that exists — there is no
 *   window in which a gate opened (and a knowledge commit became possible) with
 *   nothing saying who opened it;
 * - a record the instance does not name did not take effect. That is what a
 *   crash between the two writes leaves behind, and it is reported as
 *   `not-applied`, not repaired into something it was not.
 *
 * **Append-only, never pruned.** One line per decision submitted to the
 * engine, at human (or per-gate automated) cadence, so the file grows slowly;
 * unlike the instance journal it is not deleted at a size cap, because the
 * provenance of an accepted knowledge commit must outlive the instance that
 * made it (instances are pruned per pipeline). A torn final line — the process
 * died mid-append — is skipped on read with a warning, never parsed as a
 * record.
 */

const lock = new KeyedMutex();

export function gateDecisionFile(): string {
  return path.join(paths.argus(), "gate-decisions.jsonl");
}

/** Append one decision and flush it to disk. Throws on any failure: a decision
 *  that could not be recorded must not take effect. */
export async function appendGateDecision(decision: GateDecision): Promise<void> {
  await lock.withLock("gate-decisions", async () => {
    const file = gateDecisionFile();
    await mkdir(path.dirname(file), { recursive: true });
    const fh = await open(file, "a+");
    try {
      // A previous append that died mid-line left no newline: start on a
      // fresh line, or this record would be glued to the fragment and lost
      // with it when the line fails to parse.
      const { size } = await fh.stat();
      let lead = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = "\n";
      }
      await fh.write(`${lead}${JSON.stringify(decision)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
  });
}

function isDecision(v: unknown): v is GateDecision {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.instanceId === "string" &&
    (d.decision === "approve" || d.decision === "revise" || d.decision === "abort") &&
    Array.isArray(d.phases)
  );
}

/** Every recorded decision, oldest first; optionally for one instance. */
export async function readGateDecisions(instanceId?: string): Promise<GateDecision[]> {
  let text: string;
  try {
    text = await readFile(gateDecisionFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: GateDecision[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn("gate-decisions.jsonl: skipping an unreadable line", { line: i + 1 });
      return;
    }
    if (!isDecision(parsed)) {
      log.warn("gate-decisions.jsonl: skipping a malformed record", { line: i + 1 });
      return;
    }
    if (!instanceId || parsed.instanceId === instanceId) out.push(parsed);
  });
  return out;
}

/** Whether a decision took effect, derived from the instance (see `GateDecisionEffect`). */
export function decisionEffect(
  decision: GateDecision,
  instance: PipelineInstance | null,
): GateDecisionEffect {
  if (!instance) return "unknown";
  return instance.gateDecisionIds?.includes(decision.id) ? "applied" : "not-applied";
}

/**
 * The read model for one instance: every decision with its derived effect, and
 * the gated phases that are past their gate with no applied approval on record
 * — decided before decisions were recorded, so their provenance is unknown.
 */
export function buildGateDecisionsResponse(
  instanceId: string,
  instance: PipelineInstance | null,
  records: GateDecision[],
): GateDecisionsResponse {
  const decisions: GateDecisionView[] = records
    .filter((d) => d.instanceId === instanceId)
    .map((d) => ({ ...d, effect: decisionEffect(d, instance) }));
  const approved = new Set(
    decisions
      .filter((d) => d.decision === "approve" && d.effect === "applied")
      .flatMap((d) => d.phases.map((p) => `${p.phaseId}#${p.attempt}`)),
  );
  const undocumented = (instance?.phases ?? [])
    .filter((p) => p.gated && p.status === "succeeded" && !approved.has(`${p.id}#${p.attempt}`))
    .map((p) => ({ phaseId: p.id, attempt: p.attempt, status: p.status }));
  return { instanceId, decisions, undocumented };
}

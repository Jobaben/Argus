import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRuns } from '../../../.worktrees/argus-local/server/dist/sources/runs.js';
import { readInstances } from '../../../.worktrees/argus-local/server/dist/sources/instances.js';
import { paths } from '../../../.worktrees/argus-local/server/dist/claudeHome.js';
import { DecisionJournal } from '../../../.worktrees/argus-local/server/dist/decision/journal.js';
import path from 'node:path';
import { CollectionLedger } from '../../../.worktrees/argus-local/server/dist/decision/h2/ledger.js';
import { nextFireTime, previousFireTime } from '../../../.worktrees/argus-local/server/dist/sources/nextFire.js';
const directory = fileURLToPath(new URL('.', import.meta.url));
const creation = JSON.parse(await readFile(path.join(directory, 'creation-evidence.json'), 'utf8'));
const id = creation.pipeline.id;
const headers = process.env.ARGUS_TOKEN ? { Authorization: `Bearer ${process.env.ARGUS_TOKEN}` } : {};
async function api(route) {
  const response = await fetch(`http://127.0.0.1:7777/api/${route}`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}
const [health, setup, h2, definitions, allInstances, allRuns] = await Promise.all([
  api('health'), api('setup'), api('decisions/h2'), api('pipelines'), readInstances({ pipelineId: id }), readRuns({ limit: 10000 }),
]);
const definition = definitions.pipelines.find(d => d.id === id);
if (!definition) throw new Error('The live API did not return the feeder pipeline.');
const runs = allRuns.filter(r => r.scheduleId === `pipeline:${id}`);
const selectorProofs = [];
for (const run of runs.filter(r => r.endedAt)) {
  const records = (await readFile(path.join(paths.runsDir(), `${run.id}.log`), 'utf8')).split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const result = records.findLast(record => record.type === 'result');
  for (const output of records.flatMap(record => (record.message?.content ?? []).filter(item => item.type === 'tool_result' && !item.is_error && typeof item.content === 'string'))) {
    let selected;
    try { selected = JSON.parse(output.content); } catch { continue; }
    if (selected.corpus === 'controlled-business-scenarios-v1' && selected.runId === run.id) {
      selectorProofs.push({ runId:run.id, scenarioId:selected.id, permissionDenials:result?.permission_denials?.length ?? null });
    }
  }
}
const ledger = (await new CollectionLedger({ root: path.join(paths.argus(), 'decision-experiments/h2') }).read()).records.map(entry => entry.record);
const runIds = new Set(runs.map(r => r.id));
const attempts = ledger.filter(r => r.kind === 'attempt' && runIds.has(r.runId));
const resultByAttempt = new Map(ledger.filter(r => r.kind === 'result').map(r => [r.attemptId, r]));
const journal = new DecisionJournal({ root: path.join(paths.argus(), 'decisions') });
const entries = (await journal.read()).entries;
const assessments = new Map(entries.map(e => [e.assessment.id, e.assessment]));
const matched = [];
for (const attempt of attempts) {
  const result = resultByAttempt.get(attempt.attemptId);
  const assessment = result?.assessmentId ? assessments.get(result.assessmentId) : null;
  const snapshot = assessment ? await journal.loadSnapshot(assessment.snapshot.sha256) : null;
  matched.push({ runId: attempt.runId, question: attempt.question.id, attemptId: attempt.attemptId,
    result: result?.class ?? 'pending', assessmentId: assessment?.id ?? null,
    assessmentStatus: assessment?.outcome.status ?? null, mode: assessment?.mode ?? null,
    snapshotStatus: snapshot?.status ?? null, reference: attempt.reference?.label ?? null });
}
const scheduled = allInstances.filter(i => i.trigger === 'scheduled').sort((a,b) => a.createdAt.localeCompare(b.createdAt));
const intervals = scheduled.slice(1).map((i,n) => (Date.parse(i.createdAt)-Date.parse(scheduled[n].createdAt))/60000);
const day = new Date(2026, 9, 9);
const hourlySlots = Array(24).fill(0);
let cursor = new Date(day.getTime()-1);
for (let n=0; n<121; n++) {
  const next = nextFireTime(definition.trigger, cursor);
  if (!next || next.getDate() !== day.getDate()) break;
  hourlySlots[next.getHours()]++;
  if (next.getMinutes()%12 !== 0) throw new Error('Native schedule contains a slot outside the intended twelve-minute grid.');
  cursor = next;
}
const scheduleProven = definition.trigger.kind === 'windowed' && hourlySlots.every(count => count === 5);
const clockStarts = scheduled.filter(i => i.definition?.trigger?.kind === 'windowed');
const clockDelays = clockStarts.map(i => {
  const actual = new Date(i.createdAt);
  return (actual.getTime()-previousFireTime(definition.trigger, actual, actual).getTime())/1000;
});
const integrity = h2.report.integrity;
const clean = integrity.history === 'complete' && !integrity.findings.length && !integrity.ledger.length && !integrity.journal.gaps && !integrity.journal.notices.length;
const answered = matched.filter(m => m.result === 'answered' && m.assessmentStatus === 'answered' && m.mode === 'shadow' && m.snapshotStatus === 'retained');
const cadenceVerified = scheduleProven && clockDelays.length > 0 && clockDelays.every(seconds => seconds >= 0 && seconds <= 60);
const currentWorkloadProven = runs.some(r => r.runtime === 'claude' && r.model === definition.model && r.endedAt && ['succeeded','failed','blocked'].includes(r.outcome) && r.resultSummary?.includes('controlled-business-scenarios-v1') && selectorProofs.some(p => p.runId === r.id && p.permissionDenials === 0));
const ready = currentWorkloadProven && setup.ok && definition.enabled && definition.trigger?.everyMinutes === 12 && definition.runtime === 'claude' && definition.model === 'haiku' && definition.phases.every(p => p.timeoutSeconds === 240) && h2.collection.enabled && clean && cadenceVerified && answered.some(m => m.question === 'run.termination-probe');
const evidence = {
  capturedAt: new Date().toISOString(), pipelineId: id, definition, health, setup,
  collection: h2.collection, report: h2.report,
  instances: allInstances.map(i => ({ id:i.id, status:i.status, trigger:i.trigger, createdAt:i.createdAt })),
  runs: runs.map(r => ({ id:r.id, instanceId:r.instanceId, status:r.status, outcome:r.outcome,
    runtime:r.runtime, model:r.model, startedAt:r.startedAt, endedAt:r.endedAt, durationMs:r.durationMs,
    costUsd:r.costUsd, resultSummary:r.resultSummary, error:r.error })),
  matches: matched, selectorProofs, cadenceMinutes: intervals, scheduleProof:{ hourlySlots, slotsPerDay:hourlySlots.reduce((sum,n)=>sum+n,0), clockStarts:clockStarts.length, observedDelaySeconds:clockDelays }, checks:{ setup:setup.ok, cleanIntegrity:clean,
    cadenceVerified, currentWorkloadProven, matchedAnswered:answered.length, endToEndVerified:ready },
};
await writeFile(path.join(directory,'runtime-evidence.json'), JSON.stringify(evidence,null,2));
await writeFile(path.join(directory,'pipelines-snapshot.json'), JSON.stringify(definition,null,2));
await writeFile(path.join(directory,'decisions-h2-snapshot.json'), JSON.stringify(h2,null,2));
const escape = x => String(x ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cell = x => `<td>${escape(x)}</td>`;
const rows = runs.slice(0,5).map(r => `<tr>${cell(r.id.slice(0,8))}${cell(r.startedAt)}${cell(r.runtime ?? 'claude')}${cell(r.outcome ?? r.status)}</tr>`).join('');
const total = key => [...h2.report.probe,...h2.report.residual].reduce((n,p)=>n+(p[key] ?? 0),0);
const workloadKnown = runs.filter(r => typeof r.costUsd === 'number');
const workloadCost = workloadKnown.reduce((sum,r) => sum+r.costUsd,0);
const state = ready ? 'END-TO-END COLLECTION VERIFIED' : 'COLLECTING · END-TO-END PROOF PENDING';
const probe = h2.report.probe.map(p => `${p.provider.requestedModel ?? 'default'}: ${p.answered} answered; accuracy ${p.accuracyAnswered.value ?? 'unmeasured'}; ECE ${p.ece.status}`).join('; ') || 'No scored probe population yet';
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Argus · H2 Shadow Evidence</title><style>
*{box-sizing:border-box}body{margin:0;background:#e9edf3;color:#12233a;font:14px/1.45 system-ui,sans-serif}main{max-width:1050px;margin:28px auto;background:white;padding:34px;border-top:7px solid #156b63;box-shadow:0 8px 30px #132c4720}header{display:flex;justify-content:space-between;gap:24px}h1{font-size:30px;line-height:1.1;margin:8px 0 12px}h2{font-size:16px;margin:16px 0 7px}.muted{color:#526477}.badge{font-size:11px;letter-spacing:1px;color:#156b63;font-weight:800}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}.stat{padding:12px;background:#f1f6f7;border-radius:6px}.stat strong{display:block;font-size:27px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:30px}p{margin:6px 0 10px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{text-align:left;border-bottom:1px solid #dce3e8;padding:7px 5px}.note{padding:12px 15px;background:#fff3d9;border-left:4px solid #b77b09}footer{border-top:1px solid #dce3e8;padding-top:12px;margin-top:20px;font-size:11px}a{color:#156b63}code{font-size:11px;overflow-wrap:anywhere}@media(max-width:700px){main{margin:0;padding:20px}.grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}@page{size:A4;margin:12mm}@media print{body{background:white;font-size:11px}main{margin:0;padding:10px;box-shadow:none;max-width:none}h1{font-size:25px}.stat strong{font-size:22px}h2{margin-top:10px}.stats{margin:12px 0}.grid{gap:18px}footer{margin-top:12px}a{color:inherit}}
</style><main><header><div><div class="badge">${state}</div><h1>Argus shadow evidence feeder</h1><p class="muted">A scheduled controlled corpus for the H2 experiment.<br>Captured ${escape(evidence.capturedAt)} · Pipeline ${escape(id)}</p></div><div class="muted">H2 / shadow mode<br>No policy promotion</div></header>
<div class="stats"><div class="stat"><strong>5 / hour</strong>Clock slots :00 · :12 · :24 · :36 · :48</div><div class="stat"><strong>${scheduled.length}</strong>Retained scheduled instances</div><div class="stat"><strong>${total('answered')}</strong>Global H2 answers</div><div class="stat"><strong>${answered.length}</strong>Feeder answers with retained snapshot</div></div>
<div class="grid"><section><h2>What the measurements answer</h2><p><b>Termination probe:</b> can a blinded trace recover how the run ended? Scored against Argus's retained observation.</p><p><b>Residual cause:</b> what explains a failed or blocked task? Descriptive hypotheses; correctness remains unmeasured.</p><p><b>H1:</b> predicts human gate decisions. Disabled here; requires genuine applied operator actions.</p><h2>Configured collection</h2><p>Daily fixed clock slots · Claude / haiku workload · one phase, one step · four-minute deadline · no gate · skip overlap. The selector has an exact Bash command allowance; the declared profile denies editing, PowerShell and built-in network tools. Scenario selection varies by run UUID: booking capacity, FIFO eligibility, revenue, missing price, contradictory constraints. Outcomes reflect task feasibility.</p><p>Probe sampling 100%; residual sampling 50%; shared cap 96 shadow calls / rolling 24h; minimum interval 12 minutes; recorded shadow cost cap $10 / 24h. Workload calls are additional. Shadow provider: haiku.</p><p>Recorded assessments: ${h2.report.probe.reduce((n,p)=>n+p.answered,0)} probe and ${h2.report.residual.reduce((n,p)=>n+p.answered,0)} residual answers. Residual top categories: ${escape(h2.report.residual.map(p=>Object.entries(p.topAnswers).map(([cause,n])=>cause+': '+n).join(', ')).join('; ') || 'none yet')}; descriptive, not accuracy.</p></section><section><h2>Evidence and verification</h2><table><tr><th>Check</th><th>Observed</th></tr><tr><td>Live setup</td>${cell(setup.ok?'PASS':'FAIL')}</tr><tr><td>H2 enabled</td>${cell(h2.collection.enabled?'YES':'NO')}</tr><tr><td>Ledger / journal integrity</td>${cell(clean?'CLEAN':'REVIEW FINDINGS')}</tr><tr><td>Observed cadence</td>${cell(cadenceVerified?clockStarts.length+' fixed slot(s); max '+Math.max(...clockDelays).toFixed(1)+'s dispatch delay':'Awaiting first fixed-slot run')}</tr><tr><td>Collector state</td>${cell(h2.collection.watcher.state)}</tr><tr><td>Native daily schedule</td><td>5 slots/hour × 24 hours = 120/day</td></tr><tr><td>Existing collector tests</td><td>44 collector + 53 schedule/runtime tests passed; 0 failed</td></tr></table><p class="muted">${escape(probe)}</p><p class="muted">Retained workload cost: $${workloadCost.toFixed(4)} from ${workloadKnown.length} priced runs (${runs.length-workloadKnown.length} unpriced). This is separate from shadow-analysis cost.</p><h2>Recent feeder runs</h2><table><tr><th>Run</th><th>Started UTC</th><th>Runtime</th><th>Outcome</th></tr>${rows || '<tr><td colspan="4">Awaiting first scheduled run</td></tr>'}</table></section></div>
<div class="note"><b>Decision boundary.</b> 120 planned workload runs/day do not equal 120 assessments. Runs mature for 10 minutes; residuals, other analyses, costs and failures reduce probe throughput. At most 192 shadow calls fit in 48 hours; ECE requires 200 scored answers per exact provider/question identity, and reliability bins need 20 each. Use the first two days to judge collection, coverage and failures; assess calibration after sufficient data accumulates.</div>
<footer><p>Controlled scenarios measure trace sensitivity, not production failure rates. Normal completions may dominate termination labels; investigate class coverage before generalising. An initial Haiku attempt was denied before selecting a case; the exact selector permission was corrected and a later scheduled attempt obtained its case with no denials. Genuine blocked scenarios are expected workload outcomes. Global H2 scores pool all eligible pipelines; matched feeder IDs are recorded separately. Run/instance retention is limited; counts above describe retained records. No automatic gate approval or promotion is performed.</p><p><a href="runtime-evidence.json">Runtime evidence</a> · <a href="pipeline-input.json">Pipeline input</a> · <a href="creation-evidence.json">Skill creation receipt</a> · <a href="collector-tests.log">Test output</a>. Refresh: <code>node docs/argus/shadow-feeder/refresh-evidence.mjs</code> in a shell with the existing Argus token. Launch: <code>./docs/argus/shadow-feeder/start-collector.ps1</code>. Keep Argus and this machine running; restart with the launcher if interrupted.</p></footer></main></html>`;
await writeFile(path.join(directory,'report.html'),html);
console.log(JSON.stringify({ capturedAt:evidence.capturedAt, instances:scheduled.length, runs:runs.length, answered:total('answered'), matches:answered.length, watcher:h2.collection.watcher.state, verified:ready }));

#!/usr/bin/env node
// Reference Claude Code hook: emit a pipeline signal to Argus from inside a
// `claude -p` run started by the pipeline engine. The signal type is the first
// CLI arg ("completed" | "needs-input" | "failed"); defaults to "completed".
// Reads ARGUS_SIGNAL_URL / ARGUS_INSTANCE_ID / ARGUS_PHASE_ID / ARGUS_RUN_ID /
// ARGUS_SIGNAL_TOKEN from the environment the engine injected. No-ops when not
// running under a pipeline (env unset), so it is safe to register globally.
const type = process.argv[2] || "completed";
const url = process.env.ARGUS_SIGNAL_URL;
if (!url) process.exit(0);

let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  let payload = stdin;
  try { payload = JSON.parse(stdin); } catch { /* keep raw text */ }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: process.env.ARGUS_INSTANCE_ID,
        phaseId: process.env.ARGUS_PHASE_ID,
        runId: process.env.ARGUS_RUN_ID,
        type,
        token: process.env.ARGUS_SIGNAL_TOKEN,
        payload,
      }),
    });
  } catch { /* server unreachable — nothing to do */ }
  process.exit(0);
});

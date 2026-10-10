import { readFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')).cases;
const runId = process.env.ARGUS_RUN_ID;
if (!runId) throw new Error('This workload must run through Argus with ARGUS_RUN_ID.');
const index = Number.parseInt(runId.replaceAll('-', '').slice(-8), 16) % cases.length;
console.log(JSON.stringify({ corpus: 'controlled-business-scenarios-v1', runId, ...cases[index] }, null, 2));

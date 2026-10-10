import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from '../../.worktrees/argus-local/server/dist/sources/atomicWrite.js';

const archive = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(os.homedir(), '.claude', 'argus');
const store = path.join(root, 'pipelines.json');
const ids = new Set([
  'cb865f26-52b8-4c79-bc4d-f71dd4323ee9',
  '8a4a1975-0cab-49d8-b9ca-46ca22ed511e',
  '676cd88f-4ba1-4fe8-9637-c03e5ae9ed11',
  'b931a14e-6839-4bbf-b875-15e60c97c525',
  'b9c7c15c-ea0c-4033-9c76-beec1e75618e',
  'a03c5127-beb5-4c16-82a7-a323ea6f0236',
  'e3bdeeb4-854c-4267-8c70-a1d0bc4f0990',
  '7817d10e-173d-41e7-8e4d-ce6edc5e9b5b',
  'ed683c7f-5223-4fc3-bdf6-79957c8a537a',
  '8ab7e237-975f-48ce-afc1-bf0e7178eeed',
  '1ae1e164-b565-480a-9d4e-c0d258a11757',
  '6e233c2c-f257-4c44-802b-6aa2eb10282f',
  '13674de5-ed8a-467e-88ae-4fc0c462a8eb',
  '25bfc7ed-5fab-4f86-8c52-f307c0b8bdd2',
  'ed5f4863-ec04-46d2-ad6e-77bc5e057921',
  '5da5ecea-e0cc-4808-b1a6-3938296c9a5e',
  '53d6d2ab-38f7-4c23-91d8-6f1a9c04aa4f',
  '8c94e6d6-4511-4f44-9d2f-f08cdaa2f0f5',
  '5072f154-abb4-4b82-99a5-c9d3cd1876ac',
  '10a73fc8-f76c-43f4-8146-0576644e91ac',
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function evidenceHashes(directory = root) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (file === store) continue;
    if (entry.isDirectory()) Object.assign(result, await evidenceHashes(file));
    else if (entry.isFile()) result[path.relative(root, file)] = digest(await readFile(file));
    else throw new Error(`Unsupported evidence entry: ${file}`);
  }
  return result;
}

try {
  await fetch('http://127.0.0.1:7777/api/health', { signal: AbortSignal.timeout(3000) });
  throw new Error('Argus is listening; use its API rather than modifying its store concurrently.');
} catch (error) {
  if (error.cause?.code !== 'ECONNREFUSED') throw error;
}

const original = await readFile(store);
const definitions = JSON.parse(original);
if (!Array.isArray(definitions)) throw new Error('Pipeline store is not an array.');
const removed = definitions.filter(def => ids.has(def.id));
if (removed.length !== ids.size || new Set(removed.map(def => def.id)).size !== ids.size) {
  throw new Error('Expected exactly the 20 reviewed experiment definitions.');
}
const retained = definitions.filter(def => !ids.has(def.id));
for (const def of retained) {
  if (ids.has(def.trigger?.pipelineId)) throw new Error(`Retained pipeline depends on archived pipeline: ${def.id}`);
}
for (const entry of await readdir(path.join(root, 'instances'))) {
  if (!entry.endsWith('.json')) continue;
  const instance = JSON.parse(await readFile(path.join(root, 'instances', entry), 'utf8'));
  if ((ids.has(instance.pipelineId) || removed.some(def => def.name === instance.pipelineName)) &&
      ['running', 'awaiting-approval'].includes(instance.status)) {
    throw new Error(`Experiment instance is still active: ${instance.id}`);
  }
}

await mkdir(archive, { recursive: true });
const backup = path.join(archive, 'pipelines-before-cleanup.json');
await copyFile(store, backup, 1);
if (digest(await readFile(backup)) !== digest(original)) throw new Error('Backup verification failed.');
const before = await evidenceHashes();
await writeFile(path.join(archive, 'preserved-files-before.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
if (digest(await readFile(store)) !== digest(original)) throw new Error('Pipeline store changed during preparation.');
await atomicWriteJson(store, retained);
const current = JSON.parse(await readFile(store, 'utf8'));
const after = await evidenceHashes();
const storeVerified = JSON.stringify(current) === JSON.stringify(retained);
const historyVerified = JSON.stringify(before) === JSON.stringify(after);
const receipt = {
  at: new Date().toISOString(),
  store,
  backup,
  beforeCount: definitions.length,
  afterCount: current.length,
  archived: removed.map(({ id, name }) => ({ id, name })),
  originalSha256: digest(original),
  currentSha256: digest(await readFile(store)),
  storeVerified,
  preservedFiles: Object.keys(before).length,
  historyAndLedgerHashesUnchanged: historyVerified,
  liveReloadVerified: false,
  liveReloadLimitation: 'Local Argus port 7777 refused connections; cleanup verified in persisted store.',
};
await writeFile(path.join(archive, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
if (!storeVerified || !historyVerified) throw new Error('Post-cleanup verification failed; inspect receipt and backup.');
console.log(JSON.stringify({ archived: removed.length, remaining: current.length, preservedFiles: Object.keys(before).length, storeVerified, historyVerified }));

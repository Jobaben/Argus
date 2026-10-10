import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { updatePipeline, validatePipelinePatch } from '../../../.worktrees/argus-local/server/dist/sources/pipelines.js';
import { paths } from '../../../.worktrees/argus-local/server/dist/claudeHome.js';
const receipt = JSON.parse(await readFile(new URL('./creation-evidence.json', import.meta.url), 'utf8'));
const definitions = JSON.parse(await readFile(paths.pipelinesFile(), 'utf8'));
if (!Array.isArray(definitions)) throw new Error('Pipeline store is not an array.');
const existing = definitions.find(d => d.id === receipt.pipeline.id);
if (!existing) throw new Error('Feeder pipeline not found.');
const patch = validatePipelinePatch({ runtime: 'claude', model: 'haiku', trigger: { kind: 'windowed', startTime: '00:00', endTime: '23:59', everyMinutes: 12 }, phases: existing.phases.map(phase => ({...phase, timeoutSeconds: 240,
  capabilities: { filesystem: 'read-only', tools: { allow: ['Bash(node select-case.mjs)'], deny: ['PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'] } },
  steps: phase.steps.map(step => ({ ...step, prompt: step.prompt.replace('You may use a shell only to run `node select-case.mjs` in the current directory.', 'Use the Bash tool to run exactly `node select-case.mjs` in the current directory, without a cd prefix or other commands. This exact command is pre-authorized. The selector reads ARGUS_RUN_ID from the actual process environment; do not infer environment availability from the prompt. If the command is denied, report the permission denial rather than claiming an environment variable is absent. Do not use PowerShell or inspect any additional file.') }))
})) });
await copyFile(paths.pipelinesFile(), `${paths.pipelinesFile()}.before-shadow-bounds-${Date.now()}.bak`);
const updated = await updatePipeline(existing.id, patch, new Date());
if (!updated) throw new Error('Native update did not find the feeder.');
await writeFile(new URL('./pipeline-definition.json', import.meta.url), JSON.stringify(updated, null, 2));
const { id: ignoredId, createdAt: ignoredCreated, updatedAt: ignoredUpdated, lastStartedAt: ignoredLastStart, ...input } = updated;
await writeFile(new URL('./pipeline-input.json', import.meta.url), JSON.stringify(input, null, 2));
console.log(JSON.stringify({id:updated.id,runtime:updated.runtime,model:updated.model,timeoutSeconds:updated.phases[0].timeoutSeconds}));

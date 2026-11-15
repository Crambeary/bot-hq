import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

async function renderPrompt(path: string, enabled: boolean) {
  // Isolate prompt rendering from the database, credentials and integration clients.
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '');
  const stubs = `
const features = { composio: ${enabled}, xai: ${enabled}, voice: ${enabled}, orgo: ${enabled} };
export let connectedToolkitsCalls = 0;
const LIBRARY_ROOT = '/library';
const connectedToolkits = async () => { connectedToolkitsCalls++; return new Set(['slack', 'gmail']); };
const getBotRow = () => ({ name: 'Bot', label: 'Helper', engine: 'primary', is_primary: true, instructions: 'Be useful.' });
const listRoutines = () => [{ name: 'Daily', id: 'r1', enabled: true, description: 'Every day', prompt: 'Check in' }];
const db = { prepare: (sql) => ({ get: () => ({ name: 'Owner', email: 'owner@example.test' }), all: () => sql.includes('FROM skills') ? [{ name: 'Skill', body: 'Do it.' }] : sql.includes("kind='room'") ? [{ name: 'Room' }] : [{ name: 'Other', label: 'Worker', is_primary: false }] }) };
`;
  const js = ts.transpileModule(stubs + source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const prompt: string = await module.instructionsFor('user', 'bot');
  return { prompt, connectedToolkitsCalls: module.connectedToolkitsCalls };
}

function assertSnapshot(actual: string, file: string) {
  assert.deepEqual(Buffer.from(actual), readFileSync(new URL(file, import.meta.url)), file);
}

// Verbatim git show 2063e92fce5a4ea57078012ceb6d7646b47b2cf3:server/src/agent/prompt.ts
// (e8c3e12's parent). Keep this historical fixture unchanged: it proves the ON
// snapshot preserves the pre-gating bytes with exactly the same stub inputs.
const historical = await renderPrompt('./prompt-pre-gating.txt', true);
assertSnapshot(historical.prompt, './prompt-snapshot.txt');
assert.equal(historical.connectedToolkitsCalls, 1);
console.log('Pre-gating prompt matches the features-ON snapshot byte-for-byte');

const on = await renderPrompt('../src/agent/prompt.ts', true);
assertSnapshot(on.prompt, './prompt-snapshot.txt');
assert.equal(on.connectedToolkitsCalls, 1);
console.log('Features-ON prompt snapshot matches');

const off = await renderPrompt('../src/agent/prompt.ts', false);
assertSnapshot(off.prompt, './prompt-snapshot-off.txt');
assert.doesNotMatch(off.prompt, /Connected apps|COMPOSIO_|x_search|create_event_routine/);
// Checking calls outside the stub catches accidental lookups even if the prompt
// swallows a thrown error or omits the returned context.
assert.equal(off.connectedToolkitsCalls, 0);
console.log('Features-OFF prompt snapshot matches; connectedToolkits was not called');

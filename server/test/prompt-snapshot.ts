import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/agent/prompt.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');
const stubs = `
const features = { composio: true, xai: true, voice: true, orgo: true };
const LIBRARY_ROOT = '/library';
const connectedToolkits = async () => new Set(['slack', 'gmail']);
const getBotRow = () => ({ name: 'Bot', label: 'Helper', engine: 'primary', is_primary: true, instructions: 'Be useful.' });
const listRoutines = () => [{ name: 'Daily', id: 'r1', enabled: true, description: 'Every day', prompt: 'Check in' }];
const db = { prepare: (sql) => ({ get: () => ({ name: 'Owner', email: 'owner@example.test' }), all: () => sql.includes('FROM skills') ? [{ name: 'Skill', body: 'Do it.' }] : sql.includes("kind='room'") ? [{ name: 'Room' }] : [{ name: 'Other', label: 'Worker', is_primary: false }] }) };
`;
const js = ts.transpileModule(stubs + source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { instructionsFor } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const actual: string = await instructionsFor('user', 'bot');
const snapshot = new URL('./prompt-snapshot.txt', import.meta.url);
assert.equal(actual, readFileSync(snapshot, 'utf8'));
console.log('Prompt snapshot matches');

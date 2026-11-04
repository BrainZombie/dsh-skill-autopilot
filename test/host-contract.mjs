/**
 * Host-contract test: load the real plugin entry against the real DSH packages
 * and drive one `status` call through the registered tool.
 *
 * This is the closest check to "the Host will actually accept this plugin"
 * short of installing it and restarting the Host:
 *   - `defineTool` normalizes the parameter/output schema (a bad schema throws);
 *   - `apply()` runs with a context stub and registers the tool and command;
 *   - the tool's `execute` reaches the real mnemon ledger (read-only).
 *
 * Run from the plugin directory, after linking the packages it imports:
 *   node test/host-contract.mjs
 */

import { strict as assert } from 'node:assert';

const registered = [];
const commands = [];

const ctx = {
    get: (service) => (service === 'skills' ? { list: async () => [] } : undefined),
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
    commands: { register: (command) => { commands.push(command); return () => {}; } },
    inject: (deps, callback) => { if (deps.includes('commands')) callback({ ...ctx, commands: ctx.commands }); },
    effect: (factory) => factory(),
    logger: undefined,
};

const mod = await import('../lib/index.js');
console.log(`plugin: ${mod.name} — inject ${JSON.stringify(mod.inject)}`);
assert.equal(mod.name, 'dsh-skill-autopilot');
assert.ok(Array.isArray(mod.inject));

mod.apply(ctx, { enabled: true, mnemonDataDir: process.env.SELFTEST_MNEMON_DIR ?? '' });

assert.equal(registered.length, 1, 'one tool registered');
const tool = registered[0];
console.log(`tool: ${tool.name}`);
console.log(`params: ${Object.keys(tool.parameters?.properties ?? tool.parameters ?? {}).join(', ')}`);
assert.equal(tool.name, 'skill_autopilot');
assert.equal(typeof tool.execute, 'function');

assert.equal(commands.length, 1, 'one command registered');
console.log(`command: /${commands[0].name} — ${commands[0].description}`);

const status = await tool.execute({ action: 'status' }, { signal: new AbortController().signal });
console.log('\n--- status ---');
console.log(status.report ?? status.error);
assert.equal(status.ok, true, `status failed: ${status.error}`);
assert.ok(String(status.report).includes('审查模型'), 'status must report the reviewer route');
assert.ok(status.data, 'status must carry structured data');

// --- the model path: real dsh-llm assembly, mocked transport -----------------
const { createGenerator } = await import('../lib/review.js');
const fakeLlm = {
    prepareCall: async (config) => ({
        config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens },
        stream: async function* () {
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: '{"items":[' };
            yield { type: 'text-delta', index: 0, text: ']}' };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"items":[]}' } };
            yield { type: 'finish', reason: 'stop' };
        },
    }),
};
const llmCtx = { ...ctx, get: (service) => (service === 'llm' ? fakeLlm : ctx.get(service)) };
const generate = await createGenerator(llmCtx);
const text = await generate({ route: { provider: 'p', model: 'm' }, system: 'sys', prompt: 'hi', maxTokens: 16 });
console.log(`llm assembly: ${JSON.stringify(text)}`);
assert.equal(text, '{"items":[]}', 'BlockAssembler text extraction must return the model text');

// The read-only history action must work even before any run.
const history = await tool.execute({ action: 'history', limit: 3 }, { signal: new AbortController().signal });
console.log('\n--- history ---');
console.log(history.report);
assert.equal(history.ok, true);

console.log('\nhost-contract: PASS');

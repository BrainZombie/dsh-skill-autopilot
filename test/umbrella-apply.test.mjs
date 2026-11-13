/**
 * Regression: umbrella compose must land even when the composed name differs
 * from the anchor suggestion's own skillName.
 *
 * mnemon's `recordDraft` rejects `suggestionId` when
 * `suggestion.skillName !== skillName` ("suggestion is for another skill"),
 * so the audit umbrella path has to record the draft *unbound* and let the
 * pipeline dismiss every member afterwards.
 */

import { applyApproved } from '../lib/apply.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

const policy = {
    minConfidence: 0.7,
    minModelConfidence: 0.5,
    maxNewPerRun: 2,
    mergeSimilarity: 0.45,
    maxBodyChars: 16000,
    maxMergedBodyChars: 24000,
    descriptionMaxChars: 240,
    requireStrongSignal: true,
};

const BODY = [
    '## 何时使用',
    '- 需要把两条建议合成一个类级技能时。',
    '',
    '## 步骤',
    '1. 先读 `lib/apply.js` 的 `applyApproved`，确认绑定条件。',
    '2. 再跑 `node test/selftest.mjs` 看是否有回归。',
    '',
    '## 验证',
    '- `node test/umbrella-apply.test.mjs` 输出 PASS。',
].join('\n');

function fakeBridge() {
    const calls = [];
    return {
        calls,
        async recordDraft(input) {
            calls.push({ op: 'draft', input });
            return { id: `d-${calls.length}` };
        },
        async adoptDraft(id, root) {
            calls.push({ op: 'adopt', id, root });
            return { skill: { key: 'user-dsh:umbrella-x' }, version: { id: 'v1' } };
        },
    };
}

console.log('\n[umbrella] composed name differs from the anchor suggestion');

{
    const bridge = fakeBridge();
    const result = await applyApproved({
        bridge,
        suggestion: { id: 's1', skillName: 'anchor-y' },
        doc: { name: 'umbrella-x', description: '类级技能：把两条建议合成一个。', body: BODY },
        mode: 'create',
        policy,
        targetRoot: 'user-dsh',
        existingNames: [],
        gate: { reasons: ['同主题合并'] },
    });

    check('落盘成功', result.applied === true, JSON.stringify(result.notes));
    check('recordDraft 未绑定 suggestionId', bridge.calls[0]?.input?.suggestionId === undefined);
    check('返回 bound=false', result.bound === false);
    check('skillName 是 umbrella 名', bridge.calls[0]?.input?.skillName === 'umbrella-x');
    check('adoptDraft 被调用', bridge.calls[1]?.op === 'adopt');
}

console.log('\n[bound] composed name equals the anchor suggestion');

{
    const bridge = fakeBridge();
    const result = await applyApproved({
        bridge,
        suggestion: { id: 's2', skillName: 'anchor-y' },
        doc: { name: 'anchor-y', description: '单条落盘：名字与建议一致。', body: BODY },
        mode: 'create',
        policy,
        targetRoot: 'user-dsh',
        existingNames: [],
        gate: { reasons: [] },
    });

    check('落盘成功', result.applied === true, JSON.stringify(result.notes));
    check('recordDraft 绑定 suggestionId', bridge.calls[0]?.input?.suggestionId === 's2');
    check('返回 bound=true', result.bound === true);
}

console.log('\n[guard] hard lint failure still blocks the write');

{
    const bridge = fakeBridge();
    const result = await applyApproved({
        bridge,
        suggestion: { id: 's3', skillName: 'guard-z' },
        doc: { name: 'guard-z', description: '', body: '' },
        mode: 'create',
        policy,
        targetRoot: 'user-dsh',
        existingNames: [],
        gate: { reasons: [] },
    });

    check('未落盘', result.applied === false, JSON.stringify(result.notes));
    check('没有写 draft', bridge.calls.length === 0);
}

if (failures.length > 0) {
    console.log(`\nFAIL: ${failures.length} check(s) failed — ${failures.join(', ')}`);
    process.exit(1);
}
console.log(`\nPASS: ${passed}/${passed} checks passed`);

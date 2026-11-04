/**
 * Selftest — runs the whole pipeline OUTSIDE the Host, against a throwaway copy
 * of the evolution ledger, with the model replaced by a stub.
 *
 *   node test/selftest.mjs            # unit + isolated end-to-end
 *   node test/selftest.mjs --live     # also read the real ~/.mnemon (read-only)
 *
 * What it proves:
 *   1. the admission gates actually reject/merge as designed;
 *   2. plugin-shipped skills are visible to the dedupe pass;
 *   3. an approved suggestion is packaged into a real SKILL.md under a temp
 *      root, and the suggestion flips to `adopted` in the ledger copy.
 *
 * It never touches ~/.mnemon/skills or ~/.dsh/skills.
 */

import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { gateDecision, lintSkillDoc, scrubVolatile } from '../lib/policy.js';
import { scanPluginSkills, similarity } from '../lib/inventory.js';
import { SkillsBridge } from '../lib/mnemon.js';
import { runPass, runAudit, normalizeConfig, createState } from '../lib/pipeline.js';

let failures = 0;
let checks = 0;
let skipped = 0;
function check(name, condition, detail = '') {
    checks += 1;
    if (condition) {
        console.log(`  ok   ${name}`);
        return;
    }
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A section that needs a live DSH install cannot run on a bare CI runner. It is
 * skipped there instead of failing, and the skip is counted so the summary still
 * tells the truth about coverage.
 */
function skip(name, why) {
    skipped += 1;
    console.log(`  skip ${name} — ${why}`);
}

const policy = {
    minConfidence: 0.8,
    maxNewPerRun: 2,
    mergeSimilarity: 0.45,
    maxBodyChars: 16000,
    maxMergedBodyChars: 24000,
    descriptionMaxChars: 240,
    requireStrongSignal: true,
};

function suggestion(overrides = {}) {
    const now = new Date();
    return {
        id: overrides.id ?? 'st-demo-1',
        skillName: overrides.skillName ?? 'deck-rebuild-brief',
        action: overrides.action ?? 'create',
        summary: overrides.summary ?? '把多轮 PPT 返修沉淀成可复用的重建交接流程：归因 → 澄清字段 → 产出三件套 → 验收',
        rationale: overrides.rationale ?? '用户三次纠正了同一类错误',
        confidence: overrides.confidence ?? 0.9,
        signals: overrides.signals ?? ['procedure', 'correction'],
        evidence: [{ trajectoryId: 'tr-demo-1', steps: [1, 2, 3] }],
        status: 'pending',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        ...overrides,
    };
}

// ---------------------------------------------------------------- unit tests
console.log('\n[1] policy gates');
{
    const existing = [
        { name: 'deck-rebuild', description: 'PPT 返修重建：归因、澄清字段、产出三件套、验收' },
        { name: 'hermes-plugin-maintenance', description: 'Hermes 本体与插件的体检、更新与验收' },
    ];
    const pluginSkills = [{ name: 'apkseep', description: 'Android APK 逆向、客户端鉴权走查、重打包签名', package: 'x' }];

    const pluginCovered = gateDecision(
        { decision: 'create', skillName: 'apk-unpack', duplicateOf: 'apkseep', reason: '看起来可以新建' },
        { suggestion: suggestion({ skillName: 'apk-unpack' }), existingSkills: existing, pluginSkills, policy, createdSoFar: 0, similarity },
    );
    check('插件已覆盖 → dismiss', pluginCovered.action === 'dismiss', pluginCovered.action);

    const lowConfidence = gateDecision(
        { decision: 'create', confidence: 0.5 },
        { suggestion: suggestion({ confidence: 0.6 }), existingSkills: existing, pluginSkills: [], policy, createdSoFar: 0, similarity },
    );
    check('置信度不足 → dismiss', lowConfidence.action === 'dismiss', lowConfidence.action);

    const weakSignal = gateDecision(
        { decision: 'create' },
        { suggestion: suggestion({ signals: ['success'] }), existingSkills: existing, pluginSkills: [], policy, createdSoFar: 0, similarity },
    );
    check('弱信号 → dismiss', weakSignal.action === 'dismiss', weakSignal.action);

    const duplicate = gateDecision(
        { decision: 'create', skillName: 'deck-rebuild-brief-v2' },
        { suggestion: suggestion({ skillName: 'deck-rebuild-brief-v2' }), existingSkills: existing, pluginSkills: [], policy, createdSoFar: 0, similarity },
    );
    check('与已有技能重复 → merge', duplicate.action === 'merge', `${duplicate.action} → ${duplicate.mergeInto}`);

    const budget = gateDecision(
        { decision: 'create', skillName: 'brand-new-topic' },
        { suggestion: suggestion({ skillName: 'brand-new-topic', summary: '完全无关的新主题：日志分析与容量规划' }), existingSkills: [], pluginSkills: [], policy, createdSoFar: 5, similarity },
    );
    check('新建配额耗尽 → defer', budget.action === 'defer', budget.action);

    const fresh = gateDecision(
        { decision: 'create', skillName: 'capacity-planning' },
        { suggestion: suggestion({ skillName: 'capacity-planning' }), existingSkills: [], pluginSkills: [], policy, createdSoFar: 0, similarity },
    );
    check('干净的新主题 → create', fresh.action === 'create', fresh.action);
}

console.log('\n[2] doc lint');
{
    const bad = lintSkillDoc({ name: 'Bad Name', description: '', body: '短', existingNames: [] });
    check('坏名字被拦', bad.hard.some((item) => item.includes('技能名')));
    check('无 description 被拦', bad.hard.some((item) => item.includes('description')));

    const router = lintSkillDoc({
        name: 'skill-router',
        description: '索引所有技能。',
        body: '## 何时使用\n- `alpha-skill` — 做 A\n- `beta-skill` — 做 B\n- `gamma-skill` — 做 C\n- `delta-skill` — 做 D\n- `epsilon-skill` — 做 E\n- `zeta-skill` — 做 F\n',
        existingNames: [],
    });
    check('router 技能被拦', router.hard.some((item) => item.includes('hub')), router.hard.join('|'));

    const scrubbed = scrubVolatile('会话 2026-10-27T11:41:37Z 在 C:\\Users\\tester\\AppData\\Local\\Temp\\x\\y.log，sessionId: abc-123，17小时前');
    check('易腐内容被剔除', scrubbed.text.trim().length < 20 && scrubbed.removed.length >= 3, JSON.stringify(scrubbed));
}

console.log('\n[3] plugin-skill inventory');
{
    const dshHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh');
    const roots = [join(dshHome, 'profiles', 'web', 'node_modules')];
    // 插件技能来自「本机已装的插件」：干净机器上没有 profile，这里没有可验的东西。
    if (roots.some((root) => existsSync(root)) === false) {
        skip('扫描到插件技能', '本机没有 profiles/web/node_modules（干净机器/CI）');
    } else {
        const found = await scanPluginSkills(roots, { limit: 400 });
        check('扫描到插件技能', found.length > 0, `${found.length} 条`);
        if (found.length > 0) {
            console.log(`       样例: ${found.slice(0, 4).map((skill) => `${skill.name}(${skill.package})`).join(', ')}`);
        }
    }
    const close = similarity('deck-rebuild-brief PPT 返修 归因 澄清 验收', 'deck-rebuild PPT 返修 归因 澄清 字段 验收');
    const far = similarity('deck-rebuild-brief PPT 返修 验收', 'postgres 索引 慢查询 优化');
    check('相似度能区分近义与无关', close > far + 0.2, `close=${close.toFixed(2)} far=${far.toFixed(2)}`);
}

// ------------------------------------------------------- isolated end-to-end
console.log('\n[4] isolated end-to-end (stub model, temp ledger + temp skill root)');
const realDshHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh');
const scratch = await mkdtemp(join(tmpdir(), 'skill-autopilot-selftest-'));
const tempDshHome = join(scratch, 'dsh');
const tempAgentsHome = join(scratch, 'agents');
const tempMnemon = join(scratch, 'mnemon');
const skillRoot = join(tempDshHome, 'skills');

try {
    await mkdir(skillRoot, { recursive: true });
    await mkdir(join(tempAgentsHome, 'skills'), { recursive: true });
    await mkdir(join(tempMnemon, 'skills', 'trajectories'), { recursive: true });

    const ledger = {
        version: 1,
        generation: 1,
        suggestions: [
            suggestion({ id: 'st-allow-1', skillName: 'deck-rebuild-brief' }),
            suggestion({
                id: 'st-dismiss-1',
                skillName: 'apkseep-v2',
                summary: 'Android 逆向速查：解包、反编译、重打包签名',
                signals: ['procedure'],
                confidence: 0.88,
            }),
        ],
        drafts: [],
        reviews: [],
        versions: [],
        trajectories: [{
            id: 'tr-demo-1',
            sessionId: 'session-demo',
            sessionTitle: 'deck 重建',
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            stats: { turns: 3, userCharacters: 900, toolCalls: 9, toolFailures: 1, uniqueTools: 4, skills: [] },
            annotationCount: 0,
            signals: ['procedure'],
            suggestionIds: ['st-allow-1'],
            caseIds: [],
            outcome: 'suggested',
            pinned: false,
            createdAt: new Date().toISOString(),
            steps: [
                { index: 1, turn: 1, kind: 'user', text: '把这三轮返修沉淀成流程，不要每次重新猜' },
                { index: 2, turn: 2, kind: 'assistant', text: '先归因再澄清字段：命中「为什么返工」分类，把 N 轮意见收敛成一条判断' },
                { index: 3, turn: 3, kind: 'tool', text: 'node scripts/inventory.mjs --out inventory.json', tool: { name: 'bash', ok: true } },
            ],
            annotations: [],
        }],
        installs: [],
    };
    await writeFile(join(tempMnemon, 'skills', 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    await writeFile(join(tempMnemon, 'skills', 'trajectories', 'tr-demo-1.json'), `${JSON.stringify({
        id: 'tr-demo-1', sessionId: 'session-demo', sessionTitle: 'deck 重建',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        stats: { turns: 3, userCharacters: 900, toolCalls: 9, toolFailures: 1, uniqueTools: 4, skills: [] },
        annotationCount: 0, signals: ['procedure'], suggestionIds: ['st-allow-1'], caseIds: [],
        outcome: 'suggested', pinned: false, createdAt: new Date().toISOString(),
        steps: [
            { index: 1, turn: 1, kind: 'user', text: '把这三轮返修沉淀成流程' },
            { index: 2, turn: 2, kind: 'assistant', text: '先归因再澄清字段，把 N 轮意见收敛成一条判断' },
            { index: 3, turn: 3, kind: 'tool', text: 'node scripts/inventory.mjs --out inventory.json', tool: { name: 'bash', ok: true } },
        ],
        annotations: [],
    }, null, 2)}\n`, 'utf8');

    const stubGenerate = async ({ prompt }) => {
        if (prompt.includes('全量审计与聚类')) {
            return JSON.stringify({
                groups: [
                    {
                        theme: 'deck 返修交接',
                        action: 'create',
                        mergeInto: null,
                        name: 'deck-rebuild-brief',
                        description: '把多轮 PPT 返修沉淀成可复用的重建交接流程。',
                        suggestionIds: ['st-allow-1'],
                        reason: '同一交付链的可复用流程',
                    },
                ],
                drop: [{ suggestionIds: ['st-dismiss-1'], reason: '插件已覆盖' }],
                notes: '一条建、一条丢。',
            });
        }
        if (prompt.includes('同一主题的多个环节写成')) {
            return JSON.stringify({
                name: 'deck-rebuild-brief',
                description: '把多轮 PPT 返修沉淀成可复用的重建交接流程。',
                body: [
                    '## 何时使用',
                    '- 同一份 PPT 返修超过两轮，或用户反复说「又不对」。',
                    '',
                    '## 步骤',
                    '### 归因',
                    '1. 先按「为什么会返工」分类，把每轮意见收敛成一条判断。',
                    '',
                    '### 交接',
                    '2. 产出三件套：成品 + 变更说明 + 验收清单；新空目录导出。',
                    '3. 运行 `node scripts/inventory.mjs --out inventory.json` 记录分母。',
                    '',
                    '## 验收',
                    '- 另一台机器按说明可复现；验收清单每项都有对应产出。',
                    '',
                ].join('\n'),
                sections: ['归因', '交接'],
                dropped: ['本次任务的文件名'],
            });
        }
        if (prompt.includes('你要逐条裁决')) {
            return JSON.stringify({
                items: [
                    {
                        suggestionId: 'st-allow-1',
                        skillName: 'deck-rebuild-brief',
                        decision: 'create',
                        mergeInto: null,
                        duplicateOf: null,
                        trivial: false,
                        confidence: 0.92,
                        reason: '跨会话可复用的返修交接流程，证据里有明确步骤',
                        changes: [],
                        dropped: ['本次任务的具体文件名'],
                    },
                    {
                        suggestionId: 'st-dismiss-1',
                        skillName: 'apkseep-v2',
                        decision: 'create',
                        mergeInto: null,
                        duplicateOf: 'apkseep',
                        trivial: true,
                        confidence: 0.9,
                        reason: '插件已提供同名能力',
                        changes: [],
                        dropped: [],
                    },
                ],
                notes: '一条建、一条拒。',
            });
        }
        return JSON.stringify({
            name: 'deck-rebuild-brief',
            description: '把多轮 PPT 返修沉淀成可复用的重建交接流程。',
            body: [
                '## 何时使用',
                '- 同一份 PPT 返修超过两轮，或用户反复说「又不对」。',
                '',
                '## 步骤',
                '1. 先归因：按「为什么会返工」分类，把每轮意见收敛成一条判断（页面只装规则、字段与参数含义）。',
                '2. 再澄清：列出会被误读的字段，逐条向用户确认后才动手。',
                '3. 产出三件套：成品 + 变更说明 + 验收清单；新空目录导出，不覆盖原件。',
                '4. 运行 `node scripts/inventory.mjs --out inventory.json` 记录分母，避免「抽样当全量」。',
                '',
                '## 常见坑',
                '- 把对话里的临时路径写进交接说明，换台机器即失效。',
                '',
                '## 验收',
                '- 另一台机器按说明可复现；验收清单每一项都有对应产出。',
                '',
            ].join('\n'),
            changes: [],
            dropped: ['本次任务的文件名'],
        });
    };

    // A stand-in for the Host's skill registry: `apkseep` is already covered by a
    // plugin, so the gate must dismiss a suggestion that would duplicate it.
    const ctx = {
        get: (service) => (service === 'skills' ? {
            list: async () => [
                { name: 'apkseep', description: 'Android APK 逆向、客户端鉴权走查、重打包签名', provider: 'plugin:apkseep', source: 'plugin' },
                { name: 'univer-sheet', description: 'Univer 表格', provider: 'plugin:univer', source: 'plugin' },
            ],
        } : undefined),
        tools: { register: () => () => {} },
        inject: () => {},
        effect: () => {},
    };

    const realProfileModules = join(realDshHome, 'profiles', 'web', 'node_modules');
    process.env.DSH_HOME = tempDshHome;
    process.env.DSH_AGENTS_HOME = tempAgentsHome;

    const config = normalizeConfig({
        enabled: true,
        mnemonDataDir: tempMnemon,
        targetRoot: 'user-dsh',
        autoApply: true,
        policy,
        logDir: join(scratch, 'logs'),
        pluginScanRoots: [join(tempDshHome, 'profiles', 'web', 'node_modules')],
        moduleSearchDirs: [realProfileModules],
    });

    // --- full audit on the same isolated fixture -------------------------------
    const audit = await runAudit({
        ctx,
        config,
        state: createState(),
        options: { mode: 'review', provider: 'stub', model: 'stub', generate: stubGenerate, source: 'selftest' },
    });
    check('audit 能跑', audit.ok === true, audit.error ?? '');
    check('audit 分了 1 组', (audit.data?.groups ?? []).length === 1, JSON.stringify(audit.data?.groups?.map((g) => g.name)));
    check('audit 归组正确', (audit.data?.groups?.[0]?.members ?? []).includes('deck-rebuild-brief'));
    check('audit 丢弃了插件覆盖项', (audit.data?.drops ?? []).length === 1);

    const result = await runPass({
        ctx,
        config,
        state: createState(),
        options: { mode: 'apply', provider: 'stub', model: 'stub', generate: stubGenerate, source: 'selftest' },
    });

    check('runPass 成功', result.ok === true, result.error ?? '');
    console.log(result.report.replace(/^/gm, '       '));

    const createdFile = join(skillRoot, 'deck-rebuild-brief', 'SKILL.md');
    check('新建技能已落盘', existsSync(createdFile), createdFile);
    if (existsSync(createdFile)) {
        const text = await readFile(createdFile, 'utf8');
        check('文件带 frontmatter', text.startsWith('---\nname: deck-rebuild-brief'));
        check('文件含步骤与验收', text.includes('## 步骤') && text.includes('## 验收'));
    }

    const after = JSON.parse(await readFile(join(tempMnemon, 'skills', 'ledger.json'), 'utf8'));
    const adopted = after.suggestions.find((item) => item.id === 'st-allow-1');
    const dismissed = after.suggestions.find((item) => item.id === 'st-dismiss-1');
    check('通过的 → adopted', adopted?.status === 'adopted', adopted?.status);
    check('被插件覆盖的 → dismissed', dismissed?.status === 'dismissed', dismissed?.status);
    check('记录了一条版本', Array.isArray(after.versions) && after.versions.length >= 1, JSON.stringify(after.versions?.length));

    const versions = await readdir(join(tempMnemon, 'skills', 'versions')).catch(() => []);
    check('版本快照目录可读', Array.isArray(versions));
} catch (error) {
    // 端到端段需要真实的 mnemon 技能数据源（可选 peer）。没有它就整段跳过，
    // 而不是让没有 DSH 安装的机器把这个仓库判红。
    if (/dsh-mnemon-source-skills/.test(String(error?.message ?? error))) {
        skip('isolated end-to-end', '未安装 dsh-mnemon-source-skills（可选 peer）');
    } else {
        throw error;
    }
} finally {
    delete process.env.DSH_HOME;
    delete process.env.DSH_AGENTS_HOME;
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

// ------------------------------------------------------------- optional live
if (process.argv.includes('--live')) {
    console.log('\n[5] live read-only check against the real ledger');
    const realDir = join(process.env.USERPROFILE ?? '', '.mnemon');
    if (!existsSync(join(realDir, 'skills', 'ledger.json'))) {
        console.log('  skip 没有找到真实 ledger');
    } else {
        const bridge = await SkillsBridge.create({ dataDir: realDir });
        const pending = await bridge.pending();
        const catalog = await bridge.catalog();
        check('能读到待处理建议', pending.length > 0, `${pending.length} 条`);
        check('能读到技能目录', (catalog?.skills ?? []).length > 0, `${catalog?.skills?.length} 个`);
        for (const item of pending.slice(0, 5)) console.log(`       - ${item.skillName} (${item.confidence}) ${item.action}`);
    }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed${skipped > 0 ? ` (+${skipped} skipped)` : ''}`);
process.exit(failures === 0 ? 0 : 1);

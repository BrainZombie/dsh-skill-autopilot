/**
 * The pipeline itself: read pending suggestions -> model review -> deterministic
 * gates -> compose -> apply through the Skills Source. Kept free of any
 * `@deepseek-ai/dsh-tools` import so a test can drive it with a stub context.
 */

/**
 * dsh-skill-autopilot — skill-evolution autopilot for DeepSeek Harness.
 *
 * What it does, in one pass:
 *   1. read the pending suggestions of the mnemon Skills Source;
 *   2. ask the configured model to judge them against the whole existing skill
 *      library (user skills + plugin-shipped skills);
 *   3. enforce a deterministic admission policy the model cannot bypass
 *      (confidence, strong signals, plugin coverage, similarity-forced merge,
 *      per-run create budget, doc lint, volatile-content scrub);
 *   4. compose the final SKILL.md for approved items;
 *   5. write it through the Skills Source (recordDraft -> adoptDraft), which
 *      versions the change and flips the suggestion to `adopted`.
 *
 * Defaults to dry-run (`autoApply: false`): a review run shows the decisions and
 * the exact file that *would* land, and writes nothing.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import { SkillsBridge, detectMnemonDataDir } from './mnemon.js';
import { scanPluginSkills, similarity, clusterByPrefix } from './inventory.js';
import { buildComposePrompt, buildGroupComposePrompt, buildGroupingPrompt, extractJson, gateDecision } from './policy.js';
import { createGenerator, resolveRoute, reviewBatch } from './review.js';
import { applyApproved, applyConsolidation, dismissSuggestion, prepareDocument } from './apply.js';
import { appendLog, formatEntries, formatSummary, logDir, readHistory, saveLastRun } from './report.js';

/**
 * DSH home, resolved without a dependency on `@deepseek-ai/dsh-home-paths`
 * (the same order the host uses: `$DSH_HOME`, then `~/.dsh`). Keeping this
 * local lets the pipeline run in a plain Node test as well as in the Host.
 */
function resolveDshHome(configured) {
    const explicit = configured ?? process.env.DSH_HOME;
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
    return join(homedir(), '.dsh');
}

const DEFAULT_CONFIG = {
    enabled: true,
    mnemonDataDir: '',
    targetRoot: 'user-dsh',
    reviewer: { provider: '', model: '', maxTokens: 4096 },
    policy: {
        minConfidence: 0.8,
        minModelConfidence: 0.5,
        maxNewPerRun: 2,
        mergeSimilarity: 0.45,
        maxBodyChars: 16000,
        maxMergedBodyChars: 24000,
        descriptionMaxChars: 240,
        requireStrongSignal: true,
    },
    autoApply: false,
    intervalMinutes: 0,
    maxItemsPerRun: 8,
    auditMaxItems: 40,
    auditMaxCreate: 4,
    maxGroups: 6,
    dismissRejected: true,
    consolidateRoots: ['user-dsh', 'user-agents'],
    pluginScanRoots: [],
    moduleSearchDirs: [],
    logDir: '',
};

function normalizeConfig(raw = {}) {
    const merged = {
        ...DEFAULT_CONFIG,
        ...raw,
        reviewer: { ...DEFAULT_CONFIG.reviewer, ...(raw.reviewer ?? {}) },
        policy: { ...DEFAULT_CONFIG.policy, ...(raw.policy ?? {}) },
    };
    merged.selectors = { ...(raw.selectors ?? {}) };
    return merged;
}

/**
 * Per-mount state: one bridge, one plugin-skill cache, one running ticker.
 * Held in the closure of `apply()` so two profiles never share them.
 */
function createState() {
    return { bridge: undefined, bridgePromise: undefined, pluginSkills: undefined, pluginSkillsAt: 0, running: undefined };
}

const PLUGIN_SCAN_TTL_MS = 10 * 60 * 1000;

async function getBridge(ctx, config, state) {
    if (state.bridge) return state.bridge;
    if (state.bridgePromise) return state.bridgePromise;
    const dshHome = resolveDshHome();
    const agentsHome = process.env.DSH_AGENTS_HOME || join(dshHome, '..', '.agents');
    state.bridgePromise = (async () => {
        const dataDir = detectMnemonDataDir({ configured: config.mnemonDataDir, dshHome });
        const searchDirs = [
            ...(config.moduleSearchDirs ?? []),
            join(dshHome, 'profiles', 'web', 'node_modules'),
            join(dshHome, 'profiles', 'node_modules'),
        ];
        const bridge = await SkillsBridge.create({ dataDir, dshHome, agentsHome, searchDirs });
        state.bridge = bridge;
        return bridge;
    })().finally(() => {
        state.bridgePromise = undefined;
    });
    return state.bridgePromise;
}

/**
 * Every skill the Host actually advertises (plugin-shipped, virtual, managed,
 * plus the user/project ones). This is the authoritative "already covered"
 * set: the node_modules scan below is only a fallback for a bare-Node test.
 */
async function getHostSkills(ctx) {
    const registry = ctx.get('skills');
    if (!registry || typeof registry.list !== 'function') return [];
    try {
        const list = await registry.list();
        return (Array.isArray(list) ? list : []).map((skill) => ({
            name: String(skill.name ?? ''),
            description: String(skill.description ?? ''),
            provider: String(skill.provider ?? ''),
            source: String(skill.source ?? ''),
            path: skill.path,
        })).filter((skill) => skill.name);
    } catch {
        return [];
    }
}

async function getPluginSkills(ctx, config, state, catalogSkillNames) {
    const now = Date.now();
    if (state.pluginSkills && now - state.pluginSkillsAt < PLUGIN_SCAN_TTL_MS) return state.pluginSkills;
    const dshHome = resolveDshHome();
    const host = await getHostSkills(ctx);
    const known = new Set(catalogSkillNames ?? []);
    let skills;
    if (host.length > 0) {
        skills = host
            .filter((skill) => !known.has(skill.name))
            .map((skill) => ({ name: skill.name, description: skill.description, package: skill.provider || skill.source || 'host', path: skill.path }));
    } else {
        const roots = [
            ...config.pluginScanRoots,
            join(dshHome, 'profiles', 'web', 'node_modules'),
            join(dshHome, 'profiles', 'node_modules'),
        ].filter(Boolean);
        skills = await scanPluginSkills(roots);
    }
    state.pluginSkills = skills;
    state.pluginSkillsAt = now;
    return skills;
}

function catalogNames(catalog) {
    return (catalog?.skills ?? []).map((skill) => skill.name);
}

function catalogForPrompt(catalog) {
    return (catalog?.skills ?? [])
        .filter((skill) => !skill.shadowedBy)
        .map((skill) => ({ name: skill.name, description: skill.description ?? '', root: skill.root }));
}

async function buildItems(bridge, suggestions) {
    const items = [];
    for (const suggestion of suggestions) {
        try {
            const pack = await bridge.evidencePack(suggestion.id);
            items.push({
                suggestion,
                excerpts: Array.isArray(pack?.excerpts) ? pack.excerpts : [],
                cases: Array.isArray(pack?.cases) ? pack.cases : [],
            });
        } catch (error) {
            items.push({ suggestion, excerpts: [], cases: [], packError: error instanceof Error ? error.message : String(error) });
        }
    }
    return items;
}

/**
 * The main pass.
 * @param {object} params
 * @param {import('@deepseek-ai/cordis').Context} params.ctx
 * @param {object} params.config
 * @param {{mode: 'review'|'apply', ids?: string[], maxItems?: number, provider?: string, model?: string, signal?: AbortSignal, source: string}} params.options
 */
async function runPass({ ctx, config, state, options }) {
    if (!config.enabled) return { ok: false, error: '插件已禁用（config.enabled=false）' };
    const mode = options.mode;
    const dshHome = resolveDshHome();
    const dir = logDir(config, dshHome);

    const bridge = await getBridge(ctx, config, state);
    const allPending = await bridge.pending();
    const pending = allPending
        .filter((suggestion) => (options.ids?.length ? options.ids.includes(suggestion.id) : true))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, Math.max(1, options.maxItems ?? config.maxItemsPerRun));

    if (pending.length === 0) {
        return {
            ok: true,
            summary: `没有待处理建议（队列共 ${allPending.length} 条${options.ids?.length ? '，按 ids 过滤后为 0' : ''}）`,
            report: '没有需要审查的技能进化建议。',
            data: { pending: 0, entries: [] },
        };
    }

    const catalog = await bridge.catalog();
    const existingSkills = catalogForPrompt(catalog);
    const existingNames = catalogNames(catalog);
    const pluginSkills = await getPluginSkills(ctx, config, state, existingNames);

    const route = resolveRoute(ctx, config, options);
    const generate = options.generate ?? await createGenerator(ctx);
    const items = await buildItems(bridge, pending);

    const reviewed = await reviewBatch({
        generate,
        route,
        items,
        existingSkills,
        pluginSkills,
        policy: config.policy,
        maxTokens: config.reviewer?.maxTokens ?? 4096,
        signal: options.signal,
    });

    const byId = new Map(reviewed.items.map((decision) => [String(decision?.suggestionId ?? ''), decision]));
    const entries = [];
    let createdSoFar = 0;
    let applied = 0;
    let dismissed = 0;
    let deferred = 0;

    for (const item of items) {
        const decision = byId.get(item.suggestion.id) ?? {
            decision: 'defer',
            skillName: item.suggestion.skillName,
            reason: '模型没有对这一条给出裁决',
        };
        const gate = gateDecision(decision, {
            suggestion: item.suggestion,
            existingSkills,
            pluginSkills,
            policy: config.policy,
            createdSoFar,
            similarity,
        });

        const entry = { suggestion: item.suggestion, decision, gate };

        if (gate.action === 'create' || gate.action === 'merge') {
            const mergeTarget = gate.action === 'merge' ? catalog.skills.find((skill) => skill.name === gate.mergeInto) : undefined;
            const existing = mergeTarget?.key ? await bridge.skill(mergeTarget.key) : undefined;
            if (gate.action === 'merge' && !existing) {
                gate.reasons.push(`归并目标 ${gate.mergeInto} 读不到原文，改判为留待下轮`);
                gate.action = 'defer';
            }
            try {
                const prompt = buildComposePrompt({ item, decision: { ...decision, decision: gate.action, mergeInto: gate.mergeInto }, existing, policy: config.policy });
                const composeOnce = (extra, budget) => generate({
                    route,
                    prompt: extra ? `${prompt}\n\n# 重要\n${extra}` : prompt,
                    system: '你是技能作者。只输出 JSON，不输出解释。命令必须来自证据。',
                    maxTokens: budget,
                    signal: options.signal,
                    purpose: extra ? 'skill-autopilot-compose-retry' : 'skill-autopilot-compose',
                });
                const baseBudget = Math.max(4096, config.reviewer?.maxTokens ?? 4096);
                let raw = await composeOnce(undefined, baseBudget);
                let doc;
                try {
                    doc = extractJson(raw);
                } catch (first) {
                    // Truncated body: one retry with more room and a hard length cap.
                    raw = await composeOnce(
                        '上一次输出被截断。这次务必输出**完整**可解析的 JSON：正文不超过 3500 字符，只在 body 里写规则，不写过程叙述。',
                        Math.min(16384, baseBudget * 2),
                    );
                    doc = extractJson(raw);
                }
                entry.doc = doc;
                const isMerge = gate.action === 'merge';
                const prepared = prepareDocument({
                    doc,
                    existingNames: existingNames.filter((n) => !(isMerge && n === doc.name)),
                    policy: config.policy,
                    isMerge,
                    previousBody: existing?.body,
                });
                entry.prepared = prepared;
                if (prepared.hard.length > 0) {
                    const lost = [...(prepared.diff?.droppedSections ?? []), ...(prepared.diff?.droppedCommands ?? [])];
                    if (isMerge && lost.length > 0) {
                        // 门禁失败后仍有一次机会：把丢失的小节/命令回灌，要求只增补、不重写结构。
                        const retryNote = [
                            `上一次输出没通过内容保留校验：${prepared.hard.join('；')}。`,
                            `下面这些原文内容必须原样恢复（小节标题逐字保留，命令逐字保留）：${lost.slice(0, 12).join('、')}。`,
                            '只做增补，不要重写整体结构；长度超预算就压缩每条规则的表述，不许删小节或删命令。',
                        ].join('\n');
                        try {
                            const retryRaw = await composeOnce(retryNote, Math.min(16384, baseBudget * 2));
                            const retryDoc = extractJson(retryRaw);
                            const retried = prepareDocument({
                                doc: retryDoc,
                                existingNames: existingNames.filter((n) => n !== retryDoc?.name),
                                policy: config.policy,
                                isMerge: true,
                                previousBody: existing?.body,
                            });
                            entry.doc = retryDoc;
                            entry.prepared = retried;
                            entry.composeRetried = true;
                            if (retried.hard.length > 0) {
                                entry.blocked = retried.hard;
                                gate.action = 'defer';
                                gate.reasons.push(`打包校验未通过（已重试一次）：${retried.hard.join('；')}`);
                            }
                        } catch (retryError) {
                            entry.blocked = prepared.hard;
                            entry.composeRetryError = retryError instanceof Error ? retryError.message : String(retryError);
                            gate.action = 'defer';
                            gate.reasons.push(`打包校验未通过：${prepared.hard.join('；')}`);
                        }
                    } else {
                        entry.blocked = prepared.hard;
                        gate.action = 'defer';
                        gate.reasons.push(`打包校验未通过：${prepared.hard.join('；')}`);
                    }
                }
            } catch (error) {
                entry.composeError = error instanceof Error ? error.message : String(error);
                gate.action = 'defer';
                gate.reasons.push(`正文生成失败：${entry.composeError}`);
            }
        }

        if (gate.action === 'create' || gate.action === 'merge') {
            if (mode === 'apply') {
                try {
                    const result = await applyApproved({
                        bridge,
                        suggestion: item.suggestion,
                        doc: entry.doc,
                        mode: gate.action,
                        policy: config.policy,
                        targetRoot: config.targetRoot,
                        existingNames: existingNames.filter((n) => !(gate.action === 'merge' && n === entry.doc?.name)),
                        gate,
                    });
                    entry.applied = result;
                    if (result.applied) {
                        applied += 1;
                        if (gate.action === 'create') createdSoFar += 1;
                        existingNames.push(result.skillName);
                    } else {
                        gate.action = 'defer';
                        gate.reasons.push(`未落盘：${result.notes.join('；')}`);
                    }
                } catch (error) {
                    entry.applyError = error instanceof Error ? error.message : String(error);
                    gate.action = 'defer';
                    gate.reasons.push(`落盘失败：${entry.applyError}`);
                }
            } else if (gate.action === 'create') {
                createdSoFar += 1;
            }
        }

        if (gate.action === 'dismiss') {
            dismissed += 1;
            if (mode === 'apply' && config.dismissRejected) {
                try {
                    await dismissSuggestion(bridge, item.suggestion.id);
                    entry.dismissedPersisted = true;
                } catch (error) {
                    entry.dismissError = error instanceof Error ? error.message : String(error);
                }
            }
        } else if (gate.action === 'defer') {
            deferred += 1;
        }

        entries.push(entry);
        await appendLog(dir, {
            at: new Date().toISOString(),
            mode,
            source: options.source,
            suggestionId: item.suggestion.id,
            skillName: item.suggestion.skillName,
            suggestionAction: item.suggestion.action,
            confidence: item.suggestion.confidence,
            signals: item.suggestion.signals,
            route,
            decision: decision.decision,
            finalAction: gate.action,
            mergeInto: gate.mergeInto,
            reasons: gate.reasons,
            modelReason: decision.reason,
            applied: entry.applied?.applied ?? false,
            skillNameFinal: entry.doc?.name,
            notes: entry.applied?.notes ?? entry.blocked ?? [],
            error: entry.applyError ?? entry.composeError ?? entry.packError,
        });
    }

    const summary = formatSummary({
        pending: allPending.length,
        considered: entries.length,
        applied,
        dismissed,
        deferred,
        notes: reviewed.notes,
    });
    const report = [summary, '', ...formatEntries(entries)].join('\n');

    const payload = {
        at: new Date().toISOString(),
        mode,
        source: options.source,
        route,
        pending: allPending.length,
        considered: entries.length,
        applied,
        dismissed,
        deferred,
        notes: reviewed.notes,
        entries: entries.map((entry) => ({
            suggestionId: entry.suggestion.id,
            skillName: entry.suggestion.skillName,
            confidence: entry.suggestion.confidence,
            signals: entry.suggestion.signals,
            finalAction: entry.gate.action,
            mergeInto: entry.gate.mergeInto,
            reasons: entry.gate.reasons,
            modelReason: entry.decision?.reason,
            composed: entry.doc ? { name: entry.doc.name, description: entry.doc.description, body: entry.doc.body } : undefined,
            soft: entry.prepared?.soft ?? [],
            removed: entry.prepared?.removed ?? [],
            applied: entry.applied ?? undefined,
            error: entry.applyError ?? entry.composeError ?? entry.packError,
        })),
    };
    await saveLastRun(dir, payload);

    return { ok: true, summary, report, data: payload };
}

function buildConsolidationPrompt({ clusters, existingSkills, config }) {
    const clusterText = clusters
        .map((cluster, index) => {
            const rows = [cluster.keeper, ...cluster.members]
                .map((skill) => `- ${skill.name} :: ${skill.description ?? ''}`)
                .join('\n');
            return `### 簇 ${index + 1} (前缀 ${cluster.prefix})\n${rows}`;
        })
        .join('\n\n');
    return `# 任务
你是技能库维护者,现在做一轮**归并(umbrella)审查**。下面按前缀/同域聚出了若干簇,每簇已经选出一个候选 umbrella。
判断:这一簇是否应该收敛成一个类级技能?如果是,给出 umbrella 的最终 name/description/正文,并列出被吸收的成员。

# 硬性规则
- 只有「一个维护者会把它写成 N 个带标签小节」时才归并;明显不同的主题集群不要并。
- 正文:## 何时使用 → ## 步骤 → ## 常见坑 → ## 验收;800–6000 字符;只保留规则,丢掉过程叙事。
- 不写日期/会话 id/机器路径/哈希。
- description 一句话,≤ ${config.policy.descriptionMaxChars} 字符。
- 不得吸收防护类或插件提供的技能(它们不在候选里)。

# 候选簇
${clusterText}

# 全部已有技能(避免重名)
${existingSkills.map((skill) => `- ${skill.name}`).join('\n')}

# 输出 JSON
{
  "plans": [
    {
      "cluster": 1,
      "decision": "merge | keep",
      "keeper": "umbrella 技能名",
      "absorb": ["被吸收的技能名"],
      "reason": "一句理由",
      "skill": { "name": "...", "description": "...", "body": "## 何时使用\\n..." }
    }
  ]
}`;
}

async function runConsolidation({ ctx, config, state, options }) {
    if (!config.enabled) return { ok: false, error: '插件已禁用（config.enabled=false）' };
    const bridge = await getBridge(ctx, config, state);
    const catalog = await bridge.catalog();
    const scope = new Set(config.consolidateRoots ?? ['user-dsh']);
    const candidates = (catalog?.skills ?? [])
        .filter((skill) => scope.has(skill.root) && !skill.shadowedBy)
        .map((skill) => ({ name: skill.name, description: skill.description ?? '', key: skill.key, hash: skill.hash, root: skill.root }));

    if (candidates.length < 2) {
        return { ok: true, summary: `可归并技能不足（${candidates.length} 个，范围 ${[...scope].join('/')}）`, report: '没有可归并的技能。', data: { plans: [] } };
    }

    const clusters = clusterByPrefix(candidates, { minCluster: 2 })
        .slice(0, 4)
        .map((cluster) => {
            const [keeper, ...members] = cluster.skills;
            return { prefix: cluster.prefix, keeper, members };
        });

    if (clusters.length === 0) {
        return { ok: true, summary: `没有前缀簇（${candidates.length} 个技能）`, report: '没有发现可归并的前缀簇。', data: { plans: [] } };
    }

    const route = resolveRoute(ctx, config, options);
    const generate = options.generate ?? await createGenerator(ctx);
    const raw = await generate({
        route,
        prompt: buildConsolidationPrompt({ clusters, existingSkills: candidates, config }),
        system: '你是技能库维护者,只输出 JSON。',
        maxTokens: Math.max(3072, config.reviewer?.maxTokens ?? 4096),
        signal: options.signal,
        purpose: 'skill-autopilot-consolidate',
    });
    const parsed = extractJson(raw);
    const plans = Array.isArray(parsed?.plans) ? parsed.plans : [];
    const entries = [];

    for (const plan of plans) {
        const index = Number(plan?.cluster) - 1;
        const cluster = clusters[index];
        if (!cluster) continue;
        const entry = { cluster: cluster.prefix, decision: plan.decision, keeper: plan.keeper, absorb: plan.absorb, reason: plan.reason };
        if (plan.decision !== 'merge' || !plan.skill) {
            entries.push(entry);
            continue;
        }
        const keeperSkill = candidates.find((skill) => skill.name === plan.keeper) ?? cluster.keeper;
        const absorbNames = new Set(Array.isArray(plan.absorb) ? plan.absorb : cluster.members.map((member) => member.name));
        const absorbed = candidates.filter((skill) => absorbNames.has(skill.name) && skill.name !== keeperSkill.name);
        if (absorbed.length === 0) {
            entry.skipped = '没有可吸收成员';
            entries.push(entry);
            continue;
        }
        // The keeper's own body is what must survive this rewrite.
        const keeperDoc = keeperSkill?.key ? await bridge.skill(keeperSkill.key).catch(() => undefined) : undefined;
        const prepared = prepareDocument({
            doc: plan.skill,
            existingNames: candidates.map((skill) => skill.name).filter((skillName) => skillName !== plan.skill.name),
            policy: { ...config.policy, maxBodyChars: config.policy.maxMergedBodyChars },
            isMerge: true,
            previousBody: keeperDoc?.body,
        });
        entry.prepared = { soft: prepared.soft, removed: prepared.removed };
        if (prepared.hard.length > 0) {
            entry.blocked = prepared.hard;
            entries.push(entry);
            continue;
        }
        if (options.mode !== 'apply') {
            entry.plan = { keeper: keeperSkill.name, absorb: absorbed.map((skill) => skill.name) };
            entries.push(entry);
            continue;
        }
        const result = await applyConsolidation({
            bridge,
            keeper: keeperSkill,
            merged: { ...plan.skill, content: prepared.content },
            absorbed,
            targetRoot: config.targetRoot,
        });
        entry.applied = result.notes;
        entries.push(entry);
    }

    const report = [
        `归并审查：${clusters.length} 个簇｜${options.mode === 'apply' ? '已应用' : 'dry-run'}｜${route.provider}/${route.model}`,
        '',
        ...entries.map((entry) => {
            const head = `- [${entry.cluster}] ${entry.decision === 'merge' ? `归并 → ${entry.keeper}` : '保持独立'}${entry.reason ? `｜${entry.reason}` : ''}`;
            const lines = [head];
            if (entry.absorb?.length) lines.push(`  吸收：${entry.absorb.join(', ')}`);
            if (entry.blocked) lines.push(`  未执行：${entry.blocked.join('；')}`);
            if (entry.applied) for (const note of entry.applied) lines.push(`  ${note}`);
            return lines.join('\n');
        }),
    ].join('\n');

    return { ok: true, summary: `归并审查 ${clusters.length} 个簇（${options.mode}）`, report, data: { clusters: clusters.length, entries } };
}

async function statusReport({ ctx, config, state }) {
    const dshHome = resolveDshHome();
    const dir = logDir(config, dshHome);
    let bridgeInfo = '';
    let counts = '';
    try {
        const bridge = await getBridge(ctx, config, state);
        const overview = await bridge.overview();
        const revision = await bridge.revision();
        bridgeInfo = `${bridge.dataDir}（revision ${String(revision ?? '').slice(0, 12)}…）`;
        counts = JSON.stringify(overview?.counts ?? {});
    } catch (error) {
        bridgeInfo = `不可用：${error instanceof Error ? error.message : String(error)}`;
    }
    let route;
    try {
        route = resolveRoute(ctx, config, {});
    } catch (error) {
        route = { provider: '?', model: '?', source: `不可用：${error instanceof Error ? error.message : String(error)}` };
    }
    const lines = [
        `插件：dsh-skill-autopilot ${config.enabled ? '已启用' : '已禁用'}｜build=${BUILD_TAG}｜autoApply=${config.autoApply}｜interval=${config.intervalMinutes}m`,
        `技能数据源：${bridgeInfo}`,
        `计数：${counts}`,
        `审查模型：${route.provider}/${route.model}（${route.source}）`,
        `策略：minConfidence=${config.policy.minConfidence}｜maxNewPerRun=${config.policy.maxNewPerRun}｜mergeSimilarity=${config.policy.mergeSimilarity}｜descMax=${config.policy.descriptionMaxChars}`,
        `日志目录：${dir}`,
    ];
    return { ok: true, summary: lines[0], report: lines.join('\n'), data: { config, route, bridge: bridgeInfo, counts } };
}


/**
 * 全量审计：把**整队**待处理建议聚成类级主题，值得的合成一个 umbrella 技能落地，
 * 碎片并进已有技能，没价值的一次性丢光。这是按钮默认走的路径。
 */
async function runAudit({ ctx, config, state, options }) {
    if (!config.enabled) return { ok: false, error: '插件已禁用（config.enabled=false）' };
    const mode = options.mode === 'apply' ? 'apply' : 'review';
    const dshHome = resolveDshHome();
    const dir = logDir(config, dshHome);
    const bridge = await getBridge(ctx, config, state);

    const allPending = await bridge.pending();
    const cap = Math.max(1, Math.min(80, options.maxItems ?? config.auditMaxItems ?? 40));
    const pending = allPending
        .filter((suggestion) => (options.ids?.length ? options.ids.includes(suggestion.id) : true))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, cap);
    if (pending.length === 0) {
        return { ok: true, summary: `没有待处理建议（队列共 ${allPending.length} 条）`, report: '没有需要审计的建议。', data: { groups: [] } };
    }

    const catalog = await bridge.catalog();
    const existingSkills = catalogForPrompt(catalog);
    const existingNames = catalogNames(catalog);
    const pluginSkills = await getPluginSkills(ctx, config, state, existingNames);
    const route = resolveRoute(ctx, config, options);
    const generate = options.generate ?? await createGenerator(ctx);
    const items = await buildItems(bridge, pending);
    const byId = new Map(items.map((item) => [item.suggestion.id, item]));
    const baseBudget = Math.max(4096, config.reviewer?.maxTokens ?? 4096);

    // --- stage A: 聚类（整队一次调用）------------------------------------------
    const groupingPrompt = buildGroupingPrompt({
        items,
        existingSkills,
        pluginSkills,
        policy: config.policy,
        maxGroups: config.maxGroups ?? 6,
    });
    let grouped;
    try {
        grouped = extractJson(await generate({ route, prompt: groupingPrompt, system: '你是技能库维护者,只输出 JSON。', maxTokens: baseBudget, signal: options.signal, purpose: 'skill-autopilot-audit-group' }));
    } catch (first) {
        const retry = await generate({
            route,
            prompt: `${groupingPrompt}\n\n# 重要\n上一次输出被截断。只输出 JSON,reason 控制在 50 字内。`,
            system: '你是技能库维护者,只输出 JSON。',
            maxTokens: Math.min(16384, baseBudget * 2),
            signal: options.signal,
            purpose: 'skill-autopilot-audit-group-retry',
        });
        grouped = extractJson(retry);
    }

    // 每个 id 只能被认领一次；模型编出来的 id 直接忽略。
    const claimed = new Set();
    const groups = [];
    for (const raw of Array.isArray(grouped?.groups) ? grouped.groups : []) {
        const ids = (Array.isArray(raw?.suggestionIds) ? raw.suggestionIds : [])
            .map((id) => String(id))
            .filter((id) => byId.has(id) && !claimed.has(id));
        if (ids.length === 0) continue;
        for (const id of ids) claimed.add(id);
        groups.push({
            theme: String(raw?.theme ?? '').trim() || '未命名主题',
            action: raw?.action === 'merge' ? 'merge' : 'create',
            mergeInto: typeof raw?.mergeInto === 'string' && raw.mergeInto.trim() !== '' ? raw.mergeInto.trim() : undefined,
            name: String(raw?.name ?? '').trim(),
            description: String(raw?.description ?? '').trim(),
            ids,
            reason: String(raw?.reason ?? '').trim(),
        });
    }
    const drops = [];
    for (const raw of Array.isArray(grouped?.drop) ? grouped.drop : []) {
        const ids = (Array.isArray(raw?.suggestionIds) ? raw.suggestionIds : [])
            .map((id) => String(id))
            .filter((id) => byId.has(id) && !claimed.has(id));
        for (const id of ids) claimed.add(id);
        if (ids.length > 0) drops.push({ ids, reason: String(raw?.reason ?? '').trim() });
    }
    const unclaimed = items.filter((item) => !claimed.has(item.suggestion.id)).map((item) => item.suggestion.id);

    // --- stage B: 每组落一个技能 ------------------------------------------------
    const entries = [];
    let created = 0;
    let applied = 0;
    let dropped = 0;
    const createBudget = Math.max(1, config.auditMaxCreate ?? 4);

    for (const group of groups) {
        const groupItems = group.ids.map((id) => byId.get(id));
        const anchor = groupItems[0].suggestion;
        const signals = [...new Set(groupItems.flatMap((item) => item.suggestion.signals ?? []))];
        const entry = { group, items: groupItems, anchor };
        const gate = gateDecision(
            { decision: group.action === 'merge' ? 'merge' : 'create', skillName: group.name, mergeInto: group.mergeInto, confidence: 0.9, reason: group.reason },
            {
                suggestion: { ...anchor, skillName: group.name, signals, confidence: Math.max(...groupItems.map((item) => item.suggestion.confidence)) },
                existingSkills,
                pluginSkills,
                policy: { ...config.policy, maxNewPerRun: createBudget },
                createdSoFar: created,
                similarity,
            },
        );
        entry.gate = gate;
        if (gate.action === 'create' || gate.action === 'merge') {
            const mergeTarget = gate.action === 'merge' ? catalog.skills.find((skill) => skill.name === gate.mergeInto) : undefined;
            const existing = mergeTarget?.key ? await bridge.skill(mergeTarget.key) : undefined;
            try {
                const prompt = buildGroupComposePrompt({ items: groupItems, group: { ...group, mergeInto: gate.mergeInto ?? group.mergeInto }, existing, policy: config.policy });
                const composeOnce = (extra, budget) => generate({
                    route,
                    prompt: extra ? `${prompt}\n\n# 重要\n${extra}` : prompt,
                    system: '你是技能作者。只输出 JSON,不输出解释。命令必须来自证据。',
                    maxTokens: budget,
                    signal: options.signal,
                    purpose: extra ? 'skill-autopilot-audit-compose-retry' : 'skill-autopilot-audit-compose',
                });
                let raw = await composeOnce(undefined, baseBudget);
                let doc;
                try {
                    doc = extractJson(raw);
                } catch {
                    raw = await composeOnce('上一次输出被截断。这次务必输出完整 JSON,正文不超过 3500 字符。', Math.min(16384, baseBudget * 2));
                    doc = extractJson(raw);
                }
                entry.doc = doc;
                const prepared = prepareDocument({
                    doc,
                    existingNames: existingNames.filter((name) => !(gate.action === 'merge' && name === doc.name)),
                    policy: config.policy,
                    isMerge: gate.action === 'merge',
                    previousBody: existing?.body,
                });
                entry.prepared = prepared;
                if (prepared.hard.length > 0) {
                    const lost = [...(prepared.diff?.droppedSections ?? []), ...(prepared.diff?.droppedCommands ?? [])];
                    const mergeLike = gate.action === 'merge';
                    if (mergeLike && lost.length > 0) {
                        const retryNote = [
                            `上一次输出没通过内容保留校验：${prepared.hard.join('；')}。`,
                            `下面这些原文内容必须原样恢复（小节标题逐字保留，命令逐字保留）：${lost.slice(0, 12).join('、')}。`,
                            '只做增补，不要重写整体结构；长度超预算就压缩每条规则的表述，不许删小节或删命令。',
                        ].join('\n');
                        try {
                            const retryRaw = await composeOnce(retryNote, Math.min(16384, baseBudget * 2));
                            const retryDoc = extractJson(retryRaw);
                            const retried = prepareDocument({
                                doc: retryDoc,
                                existingNames: existingNames.filter((name) => name !== retryDoc?.name),
                                policy: config.policy,
                                isMerge: true,
                                previousBody: existing?.body,
                            });
                            entry.doc = retryDoc;
                            entry.prepared = retried;
                            entry.composeRetried = true;
                            if (retried.hard.length > 0) {
                                gate.action = 'defer';
                                gate.reasons.push(`打包校验未通过（已重试一次）：${retried.hard.join('；')}`);
                            }
                        } catch (retryError) {
                            entry.composeRetryError = retryError instanceof Error ? retryError.message : String(retryError);
                            gate.action = 'defer';
                            gate.reasons.push(`打包校验未通过：${prepared.hard.join('；')}`);
                        }
                    } else {
                        gate.action = 'defer';
                        gate.reasons.push(`打包校验未通过：${prepared.hard.join('；')}`);
                    }
                }
            } catch (error) {
                gate.action = 'defer';
                gate.reasons.push(`正文生成失败：${error instanceof Error ? error.message : String(error)}`);
                entry.composeError = error instanceof Error ? error.message : String(error);
            }
        }

        if (mode === 'apply' && (gate.action === 'create' || gate.action === 'merge')) {
            try {
                const result = await applyApproved({
                    bridge,
                    suggestion: anchor,
                    doc: entry.doc,
                    mode: gate.action,
                    policy: config.policy,
                    targetRoot: config.targetRoot,
                    existingNames: existingNames.filter((name) => !(gate.action === 'merge' && name === entry.doc?.name)),
                    gate,
                });
                entry.applied = result;
                if (result.applied) {
                    applied += 1;
                    if (gate.action === 'create') {
                        created += 1;
                        existingNames.push(result.skillName);
                    }
                    for (const item of groupItems) {
                        // 锚点若被绑定过，Source 已把建议翻成 adopted，无需再 dismiss
                        if (item.suggestion.id === anchor.id && result.bound) continue;
                        try {
                            await dismissSuggestion(bridge, item.suggestion.id);
                            entry.absorbed = [...(entry.absorbed ?? []), item.suggestion.skillName];
                        } catch (error) {
                            entry.absorbErrors = [...(entry.absorbErrors ?? []), `${item.suggestion.skillName}: ${error instanceof Error ? error.message : String(error)}`];
                        }
                    }
                } else {
                    gate.action = 'defer';
                    gate.reasons.push(`未落盘：${result.notes.join('；')}`);
                }
            } catch (error) {
                gate.action = 'defer';
                gate.reasons.push(`落盘失败：${error instanceof Error ? error.message : String(error)}`);
                entry.applyError = error instanceof Error ? error.message : String(error);
            }
        } else if (gate.action === 'create') {
            created += 1;
        }
        entries.push(entry);
        await appendLog(dir, {
            at: new Date().toISOString(),
            mode,
            source: options.source,
            kind: 'audit-group',
            theme: group.theme,
            skillName: entry.doc?.name ?? group.name,
            members: groupItems.map((item) => item.suggestion.skillName),
            suggestionIds: group.ids,
            finalAction: gate.action,
            mergeInto: gate.mergeInto,
            reasons: gate.reasons,
            applied: entry.applied?.applied ?? false,
            notes: entry.prepared?.soft ?? [],
            error: entry.applyError ?? entry.composeError,
        });
    }

    for (const drop of drops) {
        dropped += drop.ids.length;
        if (mode === 'apply' && config.dismissRejected !== false) {
            for (const id of drop.ids) {
                try {
                    await dismissSuggestion(bridge, id);
                } catch {
                    /* a stuck suggestion is not worth failing the audit for */
                }
            }
        }
        await appendLog(dir, {
            at: new Date().toISOString(),
            mode,
            source: options.source,
            kind: 'audit-drop',
            suggestionIds: drop.ids,
            skills: drop.ids.map((id) => byId.get(id).suggestion.skillName),
            reasons: [drop.reason],
            finalAction: 'dismiss',
        });
    }

    const unclaimedNote = unclaimed.length > 0 ? `；另有 ${unclaimed.length} 条模型没归类，留待下轮` : '';
    const summary = `全量审计 ${items.length} 条 → ${groups.length} 组｜落盘 ${applied} 个技能｜丢弃 ${dropped} 条${unclaimedNote}`;
    const lines = [summary, '', ...entries.map((entry) => {
        const head = `- [${entry.group.theme}] ${entry.gate.action === 'merge' ? `归并 → ${entry.gate.mergeInto}` : entry.gate.action === 'create' ? '新建' : entry.gate.action === 'dismiss' ? '不建' : '留待下轮'}｜${entry.group.ids.length} 条`;
        const out = [head];
        if (entry.doc?.name) out.push(`  技能：${entry.doc.name} — ${entry.doc.description ?? ''}`);
        if (entry.gate.reasons?.length) out.push(`  理由：${entry.gate.reasons.join('；')}`);
        if (entry.group.reason) out.push(`  构图：${entry.group.reason}`);
        if (entry.applied?.applied) out.push(`  已落盘${entry.absorbed?.length ? `，并吸收 ${entry.absorbed.join('、')}` : ''}`);
        if (entry.prepared?.soft?.length) out.push(`  软提示：${entry.prepared.soft.join('；')}`);
        return out.join('\n');
    })];
    if (drops.length > 0) lines.push('', ...drops.map((drop) => `- 丢弃 ${drop.ids.length} 条：${drop.reason}`));

    const payload = {
        at: new Date().toISOString(),
        mode,
        source: options.source,
        route,
        pending: allPending.length,
        considered: items.length,
        groups: entries.map((entry) => ({
            theme: entry.group.theme,
            action: entry.gate.action,
            mergeInto: entry.gate.mergeInto,
            name: entry.doc?.name ?? entry.group.name,
            description: entry.doc?.description ?? entry.group.description,
            body: entry.doc?.body,
            members: entry.items.map((item) => item.suggestion.skillName),
            reasons: entry.gate.reasons,
            applied: entry.applied?.applied ?? false,
        })),
        drops: drops.map((drop) => ({ ids: drop.ids, skills: drop.ids.map((id) => byId.get(id).suggestion.skillName), reason: drop.reason })),
        unclaimed,
    };
    await saveLastRun(dir, payload);
    return { ok: true, summary, report: lines.join('\n'), data: payload };
}

const ACTION_ENUM = ['status', 'review', 'apply', 'audit', 'consolidate', 'history'];
const BUILD_TAG = 'b9-code-safe-scrub';

export { ACTION_ENUM, normalizeConfig, createState, resolveDshHome, runAudit, runPass, runConsolidation, statusReport };

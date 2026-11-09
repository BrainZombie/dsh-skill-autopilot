/**
 * Admission policy for the skill autopilot.
 *
 * Two layers, deliberately separated:
 *   1. a prompt that makes the configured model judge like the maintainer of a
 *      *library* (class-level skills, umbrellas, fold-in instead of duplicate);
 *   2. deterministic gates below, which the model cannot talk its way past:
 *      confidence, strong signals, plugin coverage, similarity-forced merge,
 *      per-run create budget, doc lint, volatile-content scrub.
 *
 * The doctrine is distilled from Hermes' curator + skill-authoring standards
 * (`agent/curator.py`, `agent/learn_prompt.py`): a library of class-level
 * instructions, "would a human maintainer write this as N skills or one skill
 * with N labelled sections?", archive don't delete, never invent commands.
 */

export const STRONG_SIGNALS = Object.freeze([
    'procedure',
    'correction',
    'directive',
    'skill-gap',
    'skill-misleading',
    'approach-change',
]);

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

const VOLATILE_PATTERNS = Object.freeze([
    // ISO timestamps, log dates, "17小时前"
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g,
    /\b\d+\s*(?:小时|分钟|天|秒)前\b/g,
    // uuid / long hex digests
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    /\b[0-9a-f]{32,64}\b/g,
    // session pointers that rot
    /\b(?:sessionId|session_id|trajectoryId|suggestionId|draftId)\s*[:=]\s*(?!\?|<|\{|\$)[\w-]{6,}/g,
    // absolute temp/home paths of one particular machine
    /\b[A-Za-z]:\\(?:[^\\\s"']+\\){2,}(?:Temp|tmp)\\[^\s"'`]+/g,
    /\/(?:tmp|var\/folders)\/[^\s"'`]+/g,
]);

/** Remove content that goes stale and can never help a future session. */
export function scrubVolatile(text) {
    // Code is literal: a SQL placeholder, a date argument or a path inside a
    // fence or an inline span is part of the instruction, not stale prose.
    // Mask code first, scrub the prose, then put the code back untouched.
    const source = String(text ?? '');
    const code = [];
    const mask = (segment) => {
        code.push(segment);
        return `\u0000CODE${code.length - 1}\u0000`;
    };
    let masked = source
        .replace(/```[\s\S]*?```/g, (match) => mask(match))
        .replace(/`[^`\n]+`/g, (match) => mask(match));

    const removed = [];
    for (const pattern of VOLATILE_PATTERNS) {
        masked = masked.replace(pattern, (match) => {
            removed.push(match);
            return '';
        });
    }
    const out = masked.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => code[Number(index)]);
    return { text: out, removed };
}

/** Kebab-case a candidate name; returns '' when nothing usable survives. */
export function slugifySkillName(name) {
    return String(name ?? '')
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64);
}

const SECTION_HINTS = Object.freeze({
    trigger: [/^##\s*(?:when to use|何时使用|什么时候用|触发|适用场景|use when)/im, /^##\s*(?:description|overview)/im],
    procedure: [/^##\s*(?:procedure|steps|how to run|workflow|步骤|流程|怎么做|用法)/im],
    verification: [/^##\s*(?:verification|self-check|check|验收|自检|验证)/im],
    pitfalls: [/^##\s*(?:pitfalls|limits|gotchas|坑|注意|边界)/im],
});

function hasSections(body) {
    const found = {};
    for (const [key, patterns] of Object.entries(SECTION_HINTS)) {
        found[key] = patterns.some((pattern) => pattern.test(body));
    }
    return found;
}

/**
 * A router/hub skill (only points at other skills) is explicitly banned: it
 * costs a slot in the always-loaded index and teaches nothing.
 */
function looksLikeRouter(body) {
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 6) return false;
    const pointerish = lines.filter((line) => /^(?:[-*]\s*)?`?[a-z0-9][a-z0-9-]{2,}`?\s*(?:—|-|:|：)(?=\s)/.test(line)).length;
    return pointerish / lines.length > 0.6;
}

/**
 * Lint one packaged SKILL.md.
 * @returns {{hard: string[], soft: string[]}}
 */
export function lintSkillDoc({ name, description, body, existingNames = [], descriptionMaxChars = 240, maxBodyChars = 16000, isMerge = false }) {
    const hard = [];
    const soft = [];
    const skillName = String(name ?? '').trim();
    const desc = String(description ?? '').trim();
    const text = String(body ?? '');

    if (!SKILL_NAME_RE.test(skillName)) hard.push(`技能名不合法：${JSON.stringify(skillName)}（要求小写连字符 kebab-case，≤64）`);
    if (!desc) hard.push('缺少 description');
    else if (desc.length > descriptionMaxChars) hard.push(`description 超长：${desc.length} > ${descriptionMaxChars}，系统技能索引会截断，触发词等于没有`);
    else if (desc.length > 120) soft.push(`description 偏长（${desc.length} 字），建议压到一句话`);
    if (/^(?:一个|this skill|a skill that|comprehensive|powerful|强大的|全面的)/i.test(desc)) soft.push('description 开头是套话，应直接写能力而不是自夸');
    if (existingNames.includes(skillName) && !isMerge) hard.push(`同名技能已存在：${skillName}（改造走 merge/update，不要 create）`);

    if (!text.trim()) hard.push('正文为空');
    if (text.length > maxBodyChars) hard.push(`正文超长：${text.length} > ${maxBodyChars}（流水账不能进技能，先蒸馏）`);
    if (text.length < 200) soft.push(`正文偏短（${text.length} 字），可能不足以独立执行`);
    if (/^---\s*$/m.test(text) && /^name\s*:/m.test(text)) {
        hard.push('正文里不要再带 frontmatter（name/description 由打包层生成，重复会导致解析歧义）');
    }

    const sections = hasSections(text);
    if (!sections.trigger && !sections.procedure) hard.push('缺少「何时使用」或「步骤」小节，技能无法被正确路由');
    if (!sections.procedure) soft.push('缺少「步骤/流程」小节');
    if (!sections.verification) soft.push('缺少「验收/自检」小节（没有验收的技能无法判断是否生效）');
    if (looksLikeRouter(text)) hard.push('正文是一个只指向别的技能的目录（hub/router skill），政策禁止单独建');

    const properNoun = /(?:aliyuncs\.com|registry\.[a-z0-9.-]+|[a-z]{2,6}_?20\d{2}[a-z]{2,6}|\b(?:qwb|rwctf|dasctf|hxp|0ctf)\b)/i;
    if (properNoun.test(text)) soft.push('正文含项目/赛事专有名词（registry、赛事代号、镜像前缀等），建议泛化成占位符');
    const hasCommand = /`[^`\n]{3,}`|\b(?:bash|pwsh|node|python|curl|dsh)\b/.test(text);
    if (!hasCommand) soft.push('正文里没有任何可执行命令或工具调用，容易变成纯口号');

    return { hard, soft };
}

/** Deterministic gate run after the model answered. */
export function gateDecision(decision, context) {
    const {
        suggestion,
        existingSkills, // [{name, description, root}]
        pluginSkills, // [{name, description, package}]
        policy,
        createdSoFar,
        similarity, // (a, b) => number
    } = context;

    const reasons = [];
    let action = ['create', 'merge', 'dismiss', 'defer'].includes(decision.decision) ? decision.decision : 'defer';

    if (!suggestion) {
        reasons.push('找不到对应建议（可能已被处理或过期）');
        return { action: 'defer', reasons };
    }

    // 1. confidence floors.
    //    `minConfidence` applies to the suggestion (how sure the evolution pass was
    //    that this deserves to exist); the model's own number is a *calibration*
    //    signal only — a model that says "create" with 0.7 is still saying create.
    const modelConfidence = typeof decision.confidence === 'number' ? decision.confidence : 1;
    if (action !== 'dismiss' && suggestion.confidence < policy.minConfidence) {
        action = 'dismiss';
        reasons.push(`建议置信度不足：${suggestion.confidence} < ${policy.minConfidence}`);
    }
    const minModelConfidence = typeof policy.minModelConfidence === 'number' ? policy.minModelConfidence : 0.5;
    if (action === 'create' && modelConfidence < minModelConfidence) {
        action = 'defer';
        reasons.push(`审查模型自己对这条没把握（${modelConfidence} < ${minModelConfidence}），留待下轮而不是硬发`);
    }

    // 2. strong signal requirement
    if (policy.requireStrongSignal && action !== 'dismiss') {
        const signals = Array.isArray(suggestion.signals) ? suggestion.signals : [];
        if (!signals.some((signal) => STRONG_SIGNALS.includes(signal))) {
            action = 'dismiss';
            reasons.push(`信号太弱（${signals.join(',') || '无'}），只靠 success 类信号不足以建技能`);
        }
    }

    // 3. plugin coverage wins over a new skill
    if (action !== 'dismiss') {
        const pluginHit = findCoveredByPlugin(decision, pluginSkills, similarity);
        if (pluginHit) {
            action = 'dismiss';
            reasons.push(`插件 ${pluginHit.package} 已提供 ${pluginHit.name}，不重复蒸馏`);
        }
    }

    // 4. similarity forces merge (or dismiss when the model already says it is covered)
    let mergeInto = typeof decision.mergeInto === 'string' && decision.mergeInto.trim() !== '' ? decision.mergeInto.trim() : undefined;
    if (action === 'create') {
        const best = bestExisting(decision, existingSkills, similarity);
        // Prefix cluster (`deck-*`, `hermes-*`): the curator's umbrella rule —
        // sharing a domain head with an existing skill is already a reason to
        // fold in, because the description index routes by that shared word.
        const head = String(decision.skillName ?? '').split('-')[0];
        const GENERIC_HEADS = new Set(['dsh', 'skill', 'tool', 'test', 'api', 'cli', 'web', 'node', 'python', 'git', 'file', 'data', 'doc', 'ppt']);
        const sibling = head && head.length >= 3 && !GENERIC_HEADS.has(head)
            ? existingSkills.find((skill) => String(skill.name).split('-')[0] === head)
            : undefined;
        // A shared head can be a task class (`deck-*`, `ctf-*`) or just a product
        // name (`hermes-*`, `dsh-*`). Only force the umbrella when the two also
        // describe related work — otherwise a prefix must not merge anything.
        const siblingScore = sibling ? similarity(`${decision.skillName ?? ''} ${decision.skill?.description ?? ''} ${decision.reason ?? ''}`, `${sibling.name} ${sibling.description ?? ''}`) : 0;
        if (sibling && siblingScore >= 0.12) {
            action = 'merge';
            mergeInto = sibling.name;
            reasons.push(`与已有技能 ${sibling.name} 同属 ${head}-* 前缀簇且内容相关（${siblingScore.toFixed(2)}），归并成 umbrella 而不是再开一个兄弟技能`);
        } else if (best && best.score >= policy.mergeSimilarity) {
            if (best.score >= policy.mergeSimilarity + 0.25) {
                action = 'dismiss';
                reasons.push(`与已有技能 ${best.skill.name} 重复度 ${best.score.toFixed(2)}，内容基本被覆盖`);
            } else {
                action = 'merge';
                mergeInto = best.skill.name;
                reasons.push(`与已有技能 ${best.skill.name} 相似度 ${best.score.toFixed(2)} ≥ ${policy.mergeSimilarity}，强制归并而不是新建碎片`);
            }
        }
    }

    // 5. create budget for this run
    if (action === 'create' && createdSoFar >= policy.maxNewPerRun) {
        action = 'defer';
        reasons.push(`本轮新建配额已用尽（${policy.maxNewPerRun}），留到下一轮避免一次灌进一堆碎片`);
    }

    if (action === 'merge') {
        if (!mergeInto) {
            reasons.push('决定归并但没有说明归并到哪个已有技能');
            return { action: 'defer', reasons };
        }
        const target = existingSkills.find((skill) => skill.name === mergeInto);
        if (!target) {
            reasons.push(`归并目标 ${mergeInto} 不存在，改判为新建并受相似度约束`);
            action = 'create';
        } else if (mergeInto === decision.skillName && suggestion.action === 'update') {
            // legit update path
        }
    }

    return { action, reasons, mergeInto: action === 'merge' ? mergeInto : undefined };
}

function findCoveredByPlugin(decision, pluginSkills, similarity) {
    if (typeof decision.duplicateOf === 'string' && decision.duplicateOf.trim() !== '') {
        const named = pluginSkills.find((skill) => skill.name === decision.duplicateOf.trim());
        if (named) return named;
    }
    if (pluginSkills.length === 0) return undefined;
    const probe = `${decision.skillName ?? ''} ${decision.skill?.description ?? ''}`.trim();
    if (probe === '') return undefined;
    for (const skill of pluginSkills) {
        if (similarity(probe, `${skill.name} ${skill.description ?? ''}`) >= 0.62) return skill;
    }
    return undefined;
}

function bestExisting(decision, existingSkills, similarity) {
    const probe = `${decision.skillName ?? ''} ${decision.skill?.description ?? ''} ${decision.reason ?? ''}`.trim();
    if (probe === '') return undefined;
    let best;
    for (const skill of existingSkills) {
        const score = similarity(probe, `${skill.name} ${skill.description ?? ''}`);
        if (!best || score > best.score) best = { skill, score };
    }
    return best;
}

/** Stage A prompt: judge the batch, decide only (no skill text yet). */
export function buildReviewPrompt({ items, existingSkills, pluginSkills, policy }) {
    const catalog = existingSkills
        .map((skill) => `- ${skill.name} :: ${skill.description ?? ''}`)
        .join('\n');
    const plugins = pluginSkills.slice(0, 120)
        .map((skill) => `- ${skill.name} :: ${skill.description ?? ''} (plugin: ${skill.package})`)
        .join('\n');

    const batch = items
        .map((item, index) => {
            const suggestion = item.suggestion;
            const evidence = item.excerpts
                .flatMap((excerpt) => excerpt.steps)
                .slice(0, 18)
                .map((step) => {
                    const tag = step.kind === 'tool' ? `tool:${step.tool?.name ?? '?'}${step.tool?.ok === false ? '(failed)' : ''}` : step.kind;
                    const text = String(step.text ?? '').replace(/\s+/g, ' ').slice(0, 400);
                    return `    [${tag}] ${text}`;
                })
                .join('\n');
            return [
                `### 候选 ${index + 1} (suggestionId: ${suggestion.id})`,
                `name: ${suggestion.skillName}`,
                `action: ${suggestion.action}`,
                `summary: ${suggestion.summary}`,
                suggestion.rationale ? `rationale: ${suggestion.rationale}` : '',
                `confidence: ${suggestion.confidence}`,
                `signals: ${(suggestion.signals ?? []).join(', ')}`,
                `cases: ${item.cases.length} 条既有评测用例`,
                'evidence:',
                evidence || '    (无证据步骤)',
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n\n');

    return `# 任务
你是 DSH 技能库的维护者(maintainer)。下面是一批来自「技能进化」的待处理建议,每条都附了产生它的对话证据。
你要逐条裁决:**新建 / 归并到已有技能 / 丢弃 / 留待下轮**。这一步只裁决,不写正文。

# 这个技能库的目标形态
- 库是「类级知识」的集合:每个技能对应一类可复用的做法,而不是某一次任务的流水。
- 一个技能带上 N 个带标签的小节,胜过多出 N 个窄兄弟技能——因为检索是按 description 匹配的。
- 因此默认动作是「归并」和「拒绝」,**新建是例外**。

# 硬性裁决规则
1. 插件已经提供的能力,一律不建新技能:见下方「已由插件提供的技能」,重复即 dismiss。
2. 与「已有技能」语义重叠显著时,merge 到那一个,把它写成该类技能的 umbrella(补一节 + 更新 description),不要新建兄弟技能。
3. 只记录某次任务过程的、只换个说法的、只对某一台机器/某个临时路径成立的,一律 dismiss 或 defer。
4. 一小时内能靠自己重新推出来的常识、或用户已经写进 AGENTS.md 的规则,不要进技能库。
5. 证据不足(没有 procedure / correction / directive / skill-gap 这类强信号、或步骤看不出可复现做法)时,dismiss。
6. 允许 defer:事情看起来有价值但证据还不够,留待下次进化再判。

# 写技能正文的标准(下一阶段才会用到,裁决时用来判断成本)
- 一个技能正文 800–6000 字符;需要更多篇幅通常意味着它其实是 N 个技能或一份文档,应当归并或拆到 references/。
- description 一句话,直接写能力,≤ ${policy.descriptionMaxChars} 字符。

# 已有技能(可 merge 目标,不能重名新建)
${catalog || '(空)'}

# 已由插件提供的技能(与它们重复即 dismiss)
${plugins || '(无)'}

# 候选建议
${batch}

# 输出
只输出一个 JSON 对象,不要别的话,不要 markdown 代码围栏:
{
  "items": [
    {
      "suggestionId": "原样照抄候选里的 suggestionId",
      "skillName": "kebab-case 技能名(merge 时填目标技能名)",
      "decision": "create | merge | dismiss | defer",
      "mergeInto": "decision=merge 时填已有技能名,否则 null",
      "duplicateOf": "命中的插件技能名或已有技能名,没有就 null",
      "trivial": true/false,
      "confidence": 0.0-1.0,
      "reason": "一句中文理由(≤120 字),要能让用户据此复核",
      "changes": ["merge 时:计划在原技能里加哪几节"],
      "dropped": ["预计蒸馏时丢掉什么(便于审计)"]
    }
  ],
  "notes": "整批的总体判断(可选)"
}`;
}

/** Stage B prompt: compose the final SKILL.md for one approved item. */
export function buildComposePrompt({ item, decision, existing, policy }) {
    const suggestion = item.suggestion;
    const evidence = item.excerpts
        .flatMap((excerpt) => excerpt.steps)
        .slice(0, 24)
        .map((step) => {
            const tag = step.kind === 'tool' ? `tool:${step.tool?.name ?? '?'}${step.tool?.ok === false ? '(failed)' : ''}` : step.kind;
            return `[${tag}] ${String(step.text ?? '').replace(/\s+/g, ' ').slice(0, 600)}`;
        })
        .join('\n');

    const mergeBlock = existing
        ? `# 目标技能原文(必须保留其有效规则,只做增量与瘦身)
name: ${existing.name}
description: ${existing.description ?? ''}
---
${existing.body}
---`
        : '# 目标技能原文\n(本次是新建,无原文)';

    // 归并时以原文骨架为准:把现有 ## 小节列成清单,并要求逐条保留。
    // 没有这一步,固定模板会把自定义小节全部换掉,lintMergeDiff 必然判为丢内容。
    const existingHeadings = existing
        ? [...new Set((String(existing.body ?? '').match(/^##\s+.+$/gm) ?? []).map((line) => line.trim()))]
        : [];
    const isMergeCompose = existingHeadings.length > 0;
    const skeletonRule = isMergeCompose
        ? `- 章节骨架**以目标技能原文为准**:下面「必须保留的小节清单」里的每个标题都要原样出现在输出正文里(顺序可微调),**不许重命名、不许合并、不许删除**;新内容只能新增小节,或并入最贴近的现有小节。`
        : `- 章节:## 何时使用 → ## 前置条件 → ## 步骤 → ## 常见坑 → ## 验收(没有内容的可省,但「何时使用」与「步骤」必须有)。`;
    const inventoryBlock = isMergeCompose
        ? `\n# 必须保留的小节清单(${existingHeadings.length} 个,一个都不能少)\n${existingHeadings
              .map((line) => `- ${line}`)
              .join('\n')}`
        : '';

    return `# 任务
把下面这条技能进化建议写成一份可以直接落盘的 SKILL.md。裁决已经做过:${
        decision.decision === 'merge' ? `归并进已有技能 \`${decision.mergeInto}\`(输出该技能的**完整新正文**)` : '新建技能'
    }。

# 质量标准(硬性)
- 正文不写 frontmatter——name/description 单独作为字段给出。
- 章节:${skeletonRule.replace(/^- /, '')}
- 每条规则一行、祈使句;去掉「先试了 A 又试了 B」的过程叙事。
- 命令/接口/配置键必须是下面证据里**真实出现过**的;没出现过的不要写。
- 不写日期、会话 id、机器绝对路径、哈希、「N 小时前」这类会腐化的内容。
- 专有名词泛化：registry 域名/仓库前缀/赛事或项目代号/镜像 tag 前缀一律写成占位符（\`<registry-host>/<repo>:<tag>\`、\`<赛事代号>_<题目名>\`），只保留做法，不保留某一次的具体名字。
- 正文 800–6000 字符;${decision.decision === 'merge' ? `合并后整体不超过 ${policy.maxMergedBodyChars} 字符,超了先压缩每条规则的表述——**不许删小节、不许删原有命令**` : '超了说明在搬流水账'}。
- description:一句话,直接写这个技能能做什么、什么时候该被想起;不写「强大/全面」这类空话;≤ ${policy.descriptionMaxChars} 字符。
- 不要把整段旧技能原文照抄一遍充数;归并要产出「这一类」的统一规则——但**原有已证实有效的小节、命令、判据必须保留**,不许为了「写得更像新的」而删掉它们。

${mergeBlock}${inventoryBlock}

# 建议
name: ${suggestion.skillName}
action: ${suggestion.action}
summary: ${suggestion.summary}
${suggestion.rationale ? `rationale: ${suggestion.rationale}` : ''}
signals: ${(suggestion.signals ?? []).join(', ')}

# 证据
${evidence || '(无)'}

# 输出
只输出 JSON,不要 markdown 围栏:
{
  "name": "kebab-case",
  "description": "一句话",
  "body": "## 何时使用\\n...",
  "changes": ["相对原文改了什么"],
  "dropped": ["丢掉了什么"]
}`;
}

/**
 * Guard one merge/update compose against silently losing what the skill already had.
 * Deterministic, cheap, and tuned to be quiet: it speaks only when text the old body
 * carried is gone from the new one. `hard` downgrades the decision to defer; `soft`
 * rides along in the decision log for a human to skim.
 */
export function lintMergeDiff(previousBody, nextBody) {
    const before = String(previousBody ?? '');
    const after = String(nextBody ?? '');
    const hard = [];
    const soft = [];
    if (before.trim() === '') return { hard, soft, droppedSections: [], droppedCommands: [] };

    const headings = (text) => (text.match(/^##\s+.+$/gm) ?? []).map((line) => line.trim());
    // 标题归一化：去掉「一、」「1.」「（一）」「## 」与空白/标点后比较。
    // 只用于判定「这一节还在不在」，不改写正文；改个标题不算丢内容。
    const normHeading = (line) => String(line)
        .replace(/^#+\s*/, '')
        .replace(/^[（(]?[一二三四五六七八九十]+[）)、.．]\s*/, '')
        .replace(/^[（(]?\d+[）)、.．]\s*/, '')
        .replace(/[\s`*_()（）【】[\]、，,。.：:；;!！?？"'“”‘’—\-—]/g, '')
        .toLowerCase();
    const beforeHeadings = headings(before);
    const afterHeadings = new Set(headings(after));
    const afterNorm = new Set(headings(after).map(normHeading));
    const droppedSections = beforeHeadings.filter((line) => {
        if (afterHeadings.has(line)) return false;
        const norm = normHeading(line);
        return norm === '' || !afterNorm.has(norm);
    });
    const stopWords = /^(?:the|and|a|an|of|to|in|on|for|with)$/i;
    const spans = (text) => [...new Set((text.match(/`[^`\n]{4,}`/g) ?? []).map((token) => token.trim()))]
        .filter((token) => !stopWords.test(token.slice(1, -1)));
    const beforeCommands = spans(before);
    const afterText = after;
    const droppedCommands = beforeCommands.filter((token) => !afterText.includes(token));

    if (droppedSections.length > 0) {
        const ratio = droppedSections.length / Math.max(1, beforeHeadings.length);
        const note = `合并后丢了原有小节：${droppedSections.slice(0, 6).join('、')}`;
        if (ratio >= 0.5) hard.push(`${note}（${droppedSections.length}/${beforeHeadings.length}）`);
        else soft.push(note);
    }
    if (droppedCommands.length > 0) {
        const ratio = droppedCommands.length / Math.max(1, beforeCommands.length);
        const note = `合并后丢了原有命令：${droppedCommands.slice(0, 5).join('、')}`;
        if (ratio >= 0.5 && droppedCommands.length >= 3) hard.push(`${note}（${droppedCommands.length}/${beforeCommands.length}）`);
        else soft.push(note);
    }
    const shrink = before.length > 400 ? after.length / before.length : 1;
    if (shrink < 0.6) hard.push(`合并后正文只剩原文的 ${Math.round(shrink * 100)}%（${before.length}→${after.length} 字符），疑似丢内容`);
    else if (shrink < 0.85) soft.push(`合并后正文比原文短了 ${Math.round((1 - shrink) * 100)}%，请确认是有意瘦身`);

    return { hard, soft, droppedSections, droppedCommands };
}

/** Stage A of the full audit: group the whole pending queue into class-level themes. */
export function buildGroupingPrompt({ items, existingSkills, pluginSkills, policy, maxGroups }) {
    const catalog = existingSkills.map((skill) => `- ${skill.name} :: ${skill.description ?? ''}`).join('\n');
    const plugins = pluginSkills.slice(0, 120).map((skill) => `- ${skill.name} :: ${skill.description ?? ''} (plugin: ${skill.package})`).join('\n');

    const rows = items.map((item, index) => {
        const s = item.suggestion;
        const evidence = item.excerpts
            .flatMap((excerpt) => excerpt.steps)
            .slice(0, 5)
            .map((step) => String(step.text ?? '').replace(/\s+/g, ' ').slice(0, 220))
            .join(' / ');
        return [
            `${index + 1}. id=${s.id} | name=${s.skillName} | action=${s.action} | conf=${s.confidence} | signals=${(s.signals ?? []).join(',')}`,
            `   summary: ${s.summary}`,
            evidence ? `   evidence: ${evidence}` : '',
        ].filter(Boolean).join('\n');
    }).join('\n');

    return `# 任务
你是 DSH 技能库的维护者。下面是「技能进化」里**全部待处理**的建议(${items.length} 条)。
先做**全量审计与聚类**:把它们按「类级主题」分组,再决定每组是新建一个 umbrella 技能、还是并进已有技能、还是整组丢弃。

# 判据
- 目标是**类级技能**:一个主题一个技能,正文里用带标签的小节容纳组内各条的独有做法。
- 多数建议是同一类工作的不同环节(例如同一交付链的多个窄环节)→ **合成一组**,不要一条一个技能。
- 与「已有技能」同类 → action=merge,mergeInto 填那个技能名。
- 命中「已由插件提供的技能」→ 整组 drop,不要新建。
- 一次性过程、只对某台机器/某个项目成立、常识、只换个说法 → drop。
- 一组只有 1 条时,只有它确实是类级才允许;否则 drop 或并进相近组。
- 最多 ${maxGroups} 组;宁少不多。

# 已有技能(merge 目标)
${catalog || '(空)'}

# 已由插件提供(重复即 drop)
${plugins || '(无)'}

# 待处理建议
${rows}

# 输出(只输出 JSON,不要围栏)
{
  "groups": [
    {
      "theme": "一句话说清这一类工作在干什么",
      "action": "create | merge",
      "mergeInto": "action=merge 时的已有技能名,否则 null",
      "name": "kebab-case 技能名(merge 时填目标名)",
      "description": "一句话,≤ ${policy.descriptionMaxChars} 字符",
      "suggestionIds": ["原样照抄的 id", "..."],
      "reason": "为什么这些应该合成一个技能(≤80 字)"
    }
  ],
  "drop": [ { "suggestionIds": ["id"], "reason": "为什么不要(≤60 字)" } ],
  "notes": "整批的总体判断(可选)"
}`;
}

/** Stage B of the full audit: one umbrella body absorbing every suggestion in the group. */
export function buildGroupComposePrompt({ items, group, existing, policy }) {
    const suggestionBlock = items.map((item) => {
        const s = item.suggestion;
        const evidence = item.excerpts
            .flatMap((excerpt) => excerpt.steps)
            .slice(0, 12)
            .map((step) => {
                const tag = step.kind === 'tool' ? `tool:${step.tool?.name ?? '?'}${step.tool?.ok === false ? '(failed)' : ''}` : step.kind;
                return `[${tag}] ${String(step.text ?? '').replace(/\s+/g, ' ').slice(0, 500)}`;
            })
            .join('\n');
        return `## ${s.skillName}\nsummary: ${s.summary}\n${s.rationale ? `rationale: ${s.rationale}\n` : ''}signals: ${(s.signals ?? []).join(', ')}\n${evidence}`;
    }).join('\n\n');

    const mergeBlock = existing
        ? `# 目标技能原文(保留其有效规则,只做增量与瘦身)\nname: ${existing.name}\ndescription: ${existing.description ?? ''}\n---\n${existing.body}\n---`
        : '# 目标技能原文\n(本次新建)';

    return `# 任务
把这些**同类**的建议合成一个类级技能「${group.name}」${existing ? `,并进已有技能 \`${group.mergeInto}\`` : ''}。
同一主题的多个环节写成**带标签的小节**,不要一条建议一个小节标题;相同的做法只写一次。

# 质量标准(硬性)
- 正文不写 frontmatter——name/description 单独作为字段给出。
- 章节:## 何时使用 → ## 前置条件 → ## 步骤 → ## 常见坑 → ## 验收(无内容可省,但「何时使用」与「步骤」必须有)。
- 同类环节用小标题(### )分开,每节 3-8 行规则;祈使句,一句一条。
- 命令/接口/配置键必须来自下面的证据;没有的不要写。
- 不写日期、会话 id、机器绝对路径、哈希、「N 小时前」。
- 专有名词(registry 域名/仓库前缀/赛事或项目代号/镜像 tag 前缀)泛化成占位符。
- 正文 800–6000 字符;${existing ? `合并后整体不超过 ${policy.maxMergedBodyChars} 字符` : '超过说明在搬流水账'}。
- description 一句话,直接写这一类能做什么,≤ ${policy.descriptionMaxChars} 字符。

${mergeBlock}

# 组内建议(${items.length} 条)
${suggestionBlock}

# 输出(只输出 JSON,不要围栏)
{
  "name": "${group.name}",
  "description": "一句话",
  "body": "## 何时使用\n...",
  "sections": ["组内哪些环节被写成了哪一节"],
  "dropped": ["丢掉了什么"]
}`;
}

/** Extract the first balanced JSON object from a model reply. */
export function extractJson(text) {
    const raw = String(text ?? '');
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : raw;
    const start = candidate.indexOf('{');
    if (start < 0) throw new Error('模型输出里没有 JSON');
    const slice = balancedObject(candidate, start);
    const attempts = [slice, repairJson(slice), stripTrailingCommas(repairJson(slice))];
    let lastError;
    for (const attempt of attempts) {
        try {
            return JSON.parse(attempt);
        } catch (error) {
            lastError = error;
        }
    }
    throw new Error(`模型输出的 JSON 不完整或非法：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** The first balanced `{...}` from `start`, honouring strings and escapes. */
function balancedObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const ch = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(start, index + 1);
        }
    }
    // Truncated: return what exists so the repair pass can still try.
    return text.slice(start);
}

/**
 * Models routinely emit a literal newline inside a JSON string (a long
 * SKILL.md body), which is invalid JSON. Escape raw control characters that
 * appear inside string literals; leave everything else untouched.
 */
export function repairJson(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of String(text ?? '')) {
        if (inString) {
            if (escaped) {
                out += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                out += ch;
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
                out += ch;
                continue;
            }
            if (ch === '\n') {
                out += '\\n';
                continue;
            }
            if (ch === '\r') {
                out += '\\r';
                continue;
            }
            if (ch === '\t') {
                out += '\\t';
                continue;
            }
            out += ch;
            continue;
        }
        if (ch === '"') inString = true;
        out += ch;
    }
    return out;
}

/** Drop `,` that directly precedes `}` or `]` (a very common model habit). */
function stripTrailingCommas(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === ',') {
            const next = text.slice(index + 1).match(/^\s*([}\]])/);
            if (next) continue;
        }
        out += ch;
    }
    return out;
}

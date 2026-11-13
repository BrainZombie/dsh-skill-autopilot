/**
 * Packaging and applying an approved decision.
 *
 * Everything writes through the Skills Source (`recordDraft` -> `adoptDraft`),
 * never by touching SKILL.md directly, so:
 *   - the suggestion flips to `adopted` and leaves the pending list;
 *   - a version row is recorded, so 技能管理 → 版本 can roll it back;
 *   - create/update is decided by the Source itself (it knows the catalog).
 */

import { lintMergeDiff, lintSkillDoc, scrubVolatile } from './policy.js';

/** The exact file the Source will write: frontmatter + body. */
export function buildSkillFile({ name, description, body }) {
    const safeDescription = String(description ?? '').replace(/\r?\n/g, ' ').trim();
    return `---\nname: ${name}\ndescription: ${safeDescription}\n---\n\n${String(body ?? '').trim()}\n`;
}

/**
 * Scrub + lint one composed document.
 * @returns {{content: string, hard: string[], soft: string[], removed: string[]}}
 */
export function prepareDocument({ doc, existingNames, policy, isMerge, previousBody }) {
    const scrubbed = scrubVolatile(String(doc?.body ?? ''));
    const body = scrubbed.text;
    const lint = lintSkillDoc({
        name: doc?.name,
        description: doc?.description,
        body,
        existingNames,
        descriptionMaxChars: policy.descriptionMaxChars,
        maxBodyChars: isMerge ? policy.maxMergedBodyChars : policy.maxBodyChars,
        isMerge,
    });
    const diff = isMerge ? lintMergeDiff(previousBody, body) : { hard: [], soft: [], droppedSections: [], droppedCommands: [] };
    return {
        content: buildSkillFile({ name: doc?.name, description: doc?.description, body }),
        hard: [...lint.hard, ...diff.hard],
        soft: [...lint.soft, ...diff.soft],
        diff,
        removed: scrubbed.removed,
    };
}

/**
 * Write one approved result.
 * @param {object} input
 * @param {object} input.bridge   SkillsBridge
 * @param {object} input.suggestion
 * @param {object} input.doc      {name, description, body}
 * @param {'create'|'merge'} input.mode
 * @param {object} input.policy
 * @param {string} input.targetRoot
 * @param {string[]} input.existingNames
 * @param {object} input.gate     {reasons}
 * @returns {Promise<{applied: boolean, skillName: string, key?: string, versionId?: string, notes: string[]}>}
 */
export async function applyApproved({ bridge, suggestion, doc, mode, policy, targetRoot, existingNames, gate, previousBody }) {
    const prepared = prepareDocument({ doc, existingNames, policy, isMerge: mode === 'merge', previousBody });
    if (prepared.hard.length > 0) {
        return { applied: false, skillName: doc?.name ?? suggestion.skillName, notes: [`未落盘：${prepared.hard.join('；')}`] };
    }

    const notes = [];
    if (prepared.soft.length > 0) notes.push(`软提示：${prepared.soft.join('；')}`);
    if (prepared.removed.length > 0) notes.push(`已剔除易腐内容 ${prepared.removed.length} 处（日期/uuid/临时路径等）`);

    // mnemon 的 recordDraft 强制 `skillName === suggestion.skillName`：
    //   · 单条落盘时名字天然一致，绑定后建议会翻成 adopted；
    //   · umbrella 合并时名字由模型拟定，绑定必然被拒（"suggestion is for another skill"），
    //     因此只在名字一致时绑定，其余情况由调用方在落盘后逐条 dismiss。
    const bindsSuggestion = doc.name === suggestion.skillName;
    const draft = await bridge.recordDraft({
        ...(bindsSuggestion ? { suggestionId: suggestion.id } : {}),
        skillName: doc.name,
        content: prepared.content,
        notes: gate.reasons.join('；'),
        changes: Array.isArray(doc.changes) ? doc.changes : [],
        guidance: Array.isArray(doc.dropped) ? doc.dropped : [],
        ...(mode === 'create' ? { targetRoot } : {}),
    });

    const adopted = await bridge.adoptDraft(draft.id, mode === 'create' ? targetRoot : undefined);
    return {
        applied: true,
        bound: bindsSuggestion,
        skillName: doc.name,
        key: adopted?.skill?.key,
        versionId: adopted?.version?.id,
        notes,
    };
}

/** Mark a rejected suggestion as dismissed so it stops showing up. */
export async function dismissSuggestion(bridge, id) {
    await bridge.write('suggestion-dismiss', { id });
}

/**
 * Apply one consolidation: write the umbrella body over the keeper, then move
 * the absorbed siblings to the Trash (recoverable; never deleted).
 */
export async function applyConsolidation({ bridge, keeper, merged, absorbed, targetRoot }) {
    const notes = [];
    const draft = await bridge.recordDraft({
        skillName: keeper.name,
        content: merged.content,
        notes: notes.join('；') || '归并',
        changes: Array.isArray(merged.changes) ? merged.changes : [],
        guidance: Array.isArray(merged.dropped) ? merged.dropped : [],
        ...(keeper.key === undefined ? { targetRoot } : {}),
    });
    const adopted = await bridge.adoptDraft(draft.id, keeper.key === undefined ? targetRoot : undefined);
    notes.push(`umbrella 已更新：${adopted?.skill?.key ?? merged.name}`);

    for (const skill of absorbed) {
        if (!skill.key || !skill.hash) {
            notes.push(`跳过 ${skill.name}：缺少 key/hash`);
            continue;
        }
        try {
            await bridge.trashSkill({ key: skill.key, expectedHash: skill.hash });
            notes.push(`已移入回收站：${skill.name}`);
        } catch (error) {
            notes.push(`移入回收站失败：${skill.name} — ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { notes };
}

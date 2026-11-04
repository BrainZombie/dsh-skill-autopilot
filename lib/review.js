/**
 * The reviewer: one bounded, structured model call per run.
 *
 * Route resolution order — the "configured model" the user asked for:
 *   1. explicit provider/model on the tool call;
 *   2. plugin config `reviewer.provider` / `reviewer.model`;
 *   3. the Host's default model (`agentDefaultModel.currentSelection()`),
 *      i.e. whatever is selected in the settings page.
 */

import { loadHostModule } from './host.js';
import { buildReviewPrompt, extractJson } from './policy.js';

const loadLlmModule = () => loadHostModule('@deepseek-ai/dsh-llm');

export function resolveRoute(ctx, config, explicit = {}) {
    const provider = String(explicit.provider ?? config.reviewer?.provider ?? '').trim();
    const model = String(explicit.model ?? config.reviewer?.model ?? '').trim();
    if (provider && model) return { provider, model, source: 'explicit-or-config' };
    if (provider || model) {
        throw new Error('provider 与 model 必须同时给出（只给一个无法确定路由）');
    }
    // Loose read on purpose: a strict `ctx.get` returns undefined until the
    // providing fiber is active, so a call made in the host's startup window
    // would report "no model configured" even though one is.
    const defaults = ctx.get('agentDefaultModel', false);
    if (defaults && typeof defaults.currentSelection === 'function') {
        const selection = defaults.currentSelection();
        if (selection?.provider && selection?.model) {
            return { provider: selection.provider, model: selection.model, source: 'host-default' };
        }
    }
    throw new Error('没有可用模型：请在插件 config.reviewer 里填 provider/model，或在设置页选一个默认模型');
}

/** Build the one-shot generate function over `ctx.llm`. */
export async function createGenerator(ctx) {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.prepareCall !== 'function') throw new Error('ctx.llm 不可用：宿主没有安装 llm 服务');
    const { createUserMessage, BlockAssembler } = await loadLlmModule();

    return async function generate({ route, system, prompt, maxTokens, signal, purpose = 'skill-autopilot-review' }) {
        const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, signal);
        const messages = [createUserMessage({ content: [{ type: 'text', text: prompt }] })];
        const options = { ...call.config, messages, system, purpose, signal };
        const assembler = new BlockAssembler();
        for await (const chunk of call.stream(options)) {
            signal?.throwIfAborted?.();
            assembler.push(chunk);
        }
        const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : [];
        return blocks
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim();
    };
}

/**
 * Ask the model to judge one batch.
 * @returns {Promise<{items: object[], notes: string, raw: string}>}
 */
export async function reviewBatch({ generate, route, items, existingSkills, pluginSkills, policy, maxTokens, signal }) {
    const prompt = buildReviewPrompt({ items, existingSkills, pluginSkills, policy });
    let raw = await generate({ route, prompt, system: REVIEW_SYSTEM, maxTokens, signal });
    let parsed;
    try {
        parsed = extractJson(raw);
    } catch (first) {
        // A truncated reply is the usual cause: ask again with double the room
        // and an explicit "keep it short" before giving up.
        raw = await generate({
            route,
            prompt: `${prompt}\n\n# 重要\n上一次输出被截断了。这次只输出 JSON，reason 控制在 60 字内，不要任何解释性文字。`,
            system: REVIEW_SYSTEM,
            maxTokens: Math.min(16384, Math.max(2048, maxTokens) * 2),
            signal,
            purpose: 'skill-autopilot-review-retry',
        });
        try {
            parsed = extractJson(raw);
        } catch (second) {
            throw new Error(`审查模型两次都没有返回可解析的 JSON：${second instanceof Error ? second.message : String(second)}\n原始输出前 400 字:\n${raw.slice(0, 400)}`);
        }
    }
    const decisions = Array.isArray(parsed?.items) ? parsed.items : [];
    if (decisions.length === 0) throw new Error('审查模型返回了空裁决（items 为空）');
    return { items: decisions, notes: typeof parsed?.notes === 'string' ? parsed.notes : '', raw };
}

const REVIEW_SYSTEM = [
    '你是 DSH 技能库的维护者。你审的不是「这条建议写得对不对」，而是「这个技能该不该进库、进了该长什么样」。',
    '默认答案是拒绝/归并；新建必须给出理由。你输出严格 JSON，不输出任何解释性文字。',
    '不要把对话过程、时间戳、机器路径、会话 id 写进技能正文。不要编造命令或参数。',
].join('\n');

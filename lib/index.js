/**
 * dsh-skill-autopilot — plugin wiring.
 *
 * Registers the `skill_autopilot` tool and the `/skill-autopilot` command over
 * the pipeline in `./pipeline.js`, and (optionally) a background ticker.
 */

import { loadHostModule } from './host.js';
import { logDir, readHistory } from './report.js';
import { ACTION_ENUM, createState, normalizeConfig, resolveDshHome, runAudit, runConsolidation, runPass, statusReport } from './pipeline.js';

const { defineTool } = await loadHostModule('@deepseek-ai/dsh-tools');

export const name = 'dsh-skill-autopilot';
export const inject = ['tools', 'llm'];

/** What the page may read at any moment about the last/current run. */
function snapshotRun(state) {
    const last = state.last;
    return {
        running: Boolean(state.inflight),
        ok: last?.ok,
        at: last?.at,
        summary: last?.summary ?? '',
        report: last?.report ?? '',
    };
}

/** One run at a time: a second click answers "busy" instead of stacking runs. */
function startRun({ ctx, config, state, action = 'audit', mode, maxItems, signal }) {
    const source = `gui-button-${action === 'audit' ? 'audit' : 'pass'}-${mode}`;
    const runner = action === 'audit' ? runAudit : runPass;
    state.inflight = runner({ ctx, config, state, options: { mode, maxItems, source, signal } })
        .then((result) => {
            state.last = {
                at: new Date().toISOString(),
                ok: result?.ok !== false,
                summary: result?.summary ?? result?.error ?? '',
                report: result?.report ?? '',
            };
            return result;
        })
        .catch((error) => {
            state.last = {
                at: new Date().toISOString(),
                ok: false,
                summary: `运行失败：${error instanceof Error ? error.message : String(error)}`,
                report: '',
            };
        })
        .finally(() => {
            state.inflight = undefined;
        });
    return state.inflight;
}

export function apply(ctx, rawConfig = {}) {
    const config = normalizeConfig(rawConfig);
    const state = createState();

    // ToolRuntime 缺席时不要让整行崩掉：cordis 的 inject 声明保证真实宿主里它一定在，
    // 这一层只是把「没有工具可注册」变成安静返回，而不是让插件行变红。
    const tools = (() => {
        try {
            return ctx.tools;
        } catch {
            return undefined;
        }
    })();
    if (!tools || typeof tools.register !== 'function') return;

    tools.register(defineTool({
        name: 'skill_autopilot',
        description:
            'DSH 技能进化自动审批：把 mnemon「技能管理 → 进化」里待处理的建议交给已配置的大模型审查，按反碎片/反重复策略裁决（新建 / 归并到已有技能 / 不建 / 留待下轮），通过后打包成 SKILL.md 并经技能数据源落盘（带版本记录，可回滚）。'
            + ' action=audit 全量审计（默认推荐）：把整队待处理聚成类级主题，值得的合成一个 umbrella 技能落地，碎片并进已有技能，其余丢弃；review 只审不写；apply 按单条审完直接落盘；consolidate 归并已有技能；history 看最近决策。',
        parameters: {
            action: {
                type: 'string',
                enum: ACTION_ENUM,
                description: 'audit|status|review|apply|consolidate|history；默认 audit。',
            },
            ids: {
                type: 'array',
                items: { type: 'string' },
                description: '只处理这些 suggestionId（默认全量待处理）。',
            },
            maxItems: {
                type: 'integer',
                description: '本轮最多审查多少条（默认取插件配置 maxItemsPerRun）。',
            },
            provider: {
                type: 'string',
                description: '覆盖审查模型 provider（默认用插件配置或宿主默认模型）。',
            },
            model: {
                type: 'string',
                description: '覆盖审查模型 model。',
            },
            limit: {
                type: 'integer',
                description: 'history 时返回条数（默认 10）。',
            },
            confirm: {
                type: 'boolean',
                description: 'consolidate 时显式确认才真正归并落盘（否则只出方案）。',
            },
            dryRun: {
                type: 'boolean',
                description: 'audit 时只看分组与将要落盘的正文，不写盘。',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    summary: { type: 'string' },
                    report: { type: 'string' },
                    data: { type: 'string', description: 'JSON 字符串：完整决策（含将要落盘的 SKILL.md 正文）。' },
                    error: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                type: 'text',
                text: value?.ok === false ? `skill_autopilot 失败：${value.error ?? '未知错误'}` : String(value?.report ?? value?.summary ?? ''),
            }],
        },
        async execute(args = {}, exec) {
            const action = ACTION_ENUM.includes(args.action) ? args.action : 'audit';
            try {
                if (action === 'status') {
                    const result = await statusReport({ ctx, config, state });
                    return { ok: true, summary: result.summary, report: result.report, data: JSON.stringify(result.data) };
                }
                if (action === 'history') {
                    const dir = logDir(config, resolveDshHome());
                    const rows = await readHistory(dir, Math.max(1, Math.min(50, args.limit ?? 10)));
                    const report = rows.length === 0
                        ? '还没有决策记录。'
                        : rows.map((row) => `- ${row.at} ${row.skillName} → ${row.finalAction}${row.mergeInto ? ` → ${row.mergeInto}` : ''}｜${(row.reasons ?? []).join('；')}`).join('\n');
                    return { ok: true, summary: `最近 ${rows.length} 条决策`, report, data: JSON.stringify(rows) };
                }
                const mode = action === 'apply' ? 'apply' : 'review';
                const options = {
                    mode,
                    ids: Array.isArray(args.ids) ? args.ids : undefined,
                    maxItems: Number.isFinite(args.maxItems) ? Number(args.maxItems) : undefined,
                    provider: args.provider,
                    model: args.model,
                    signal: exec?.signal,
                    source: 'tool',
                };
                const result = action === 'consolidate'
                    ? await runConsolidation({ ctx, config, state, options: { ...options, mode: args.confirm === true || config.autoApply ? 'apply' : 'review' } })
                    : action === 'audit'
                        ? await runAudit({ ctx, config, state, options: { ...options, mode: args.dryRun === true ? 'review' : 'apply', ids: options.ids, maxItems: args.maxItems } })
                        : await runPass({ ctx, config, state, options });
                if (!result.ok) return { ok: false, error: result.error, summary: result.error, report: result.error };
                return { ok: true, summary: result.summary, report: result.report, data: JSON.stringify(result.data) };
            } catch (error) {
                const message = error instanceof Error ? `${error.message}` : String(error);
                return { ok: false, error: message, summary: message, report: `skill_autopilot 失败：${message}` };
            }
        },
    }));

    // --- HTTP triggers for the Skills page button --------------------------------
    // `POST /api/skill-autopilot/evolve`   {mode:'apply'|'review', maxItems}
    // `POST /api/skill-autopilot/progress` {}
    // Both take the standard Connection envelope ({type:'client-request', rpcId,
    // method, payload}) and ride the browser cookie the Host already minted.
    // A run takes 1-3 minutes, so evolve answers immediately and the page polls
    // progress instead of holding one request open.
    ctx.inject(['connection'], (connectionCtx) => {
        const registrar = connectionCtx.connection?.fetch;
        if (!registrar || typeof registrar.register !== 'function') return;

        const readEnvelope = async (request) => {
            let envelope;
            try {
                envelope = await request.json();
            } catch {
                return { error: new Response('invalid JSON', { status: 400 }) };
            }
            if (envelope?.type !== 'client-request' || typeof envelope?.rpcId !== 'string' || typeof envelope?.method !== 'string') {
                return { error: new Response('invalid RPC envelope', { status: 400 }) };
            }
            return { envelope };
        };

        registrar.register({
            path: '/api/skill-autopilot/evolve',
            methods: ['POST'],
            requestBody: 'buffered',
            async fetch(request) {
                const { envelope, error } = await readEnvelope(request);
                if (error) return error;
                const reply = (value) => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } });
                const payload = envelope?.payload ?? {};
                const action = payload.action === 'pass' ? 'pass' : 'audit';
                const mode = payload.mode === 'review' ? 'review' : 'apply';
                const requested = Number(envelope?.payload?.maxItems);
                const maxItems = Number.isFinite(requested)
                    ? Math.max(1, Math.min(80, requested))
                    : action === 'audit' ? (config.auditMaxItems ?? 40) : Math.min(3, config.maxItemsPerRun);
                if (state.inflight) {
                    return reply({ started: false, busy: true, mode, action, summary: '已有一轮在跑，等它结束', snapshot: snapshotRun(state) });
                }
                startRun({ ctx, config, state, action, mode, maxItems, signal: request.signal });
                return reply({ started: true, busy: false, mode, action, maxItems, snapshot: snapshotRun(state) });
            },
        });

        registrar.register({
            path: '/api/skill-autopilot/progress',
            methods: ['POST'],
            requestBody: 'buffered',
            async fetch(request) {
                const { envelope, error } = await readEnvelope(request);
                if (error) return error;
                return Response.json({
                    type: 'server-response',
                    rpcId: envelope.rpcId,
                    result: { ok: true, value: snapshotRun(state) },
                });
            },
        });
    });

    ctx.inject(['commands'], (commandCtx) => {
        commandCtx.commands.register({
            name: 'skill-autopilot',
            description: '技能进化自动审批：review / apply / consolidate / status / history',
            input: { hint: '[status|review|apply|consolidate|history]' },
            handler: async (invocation) => {
                const parts = String(invocation?.input ?? invocation?.args ?? '').trim().split(/\s+/).filter(Boolean);
                const action = ACTION_ENUM.includes(parts[0]) ? parts[0] : 'review';
                try {
                    if (action === 'status') {
                        const result = await statusReport({ ctx, config, state });
                        return { kind: 'text', text: result.report };
                    }
                    if (action === 'history') {
                        const rows = await readHistory(logDir(config, resolveDshHome()), 10);
                        return { kind: 'text', text: rows.length === 0 ? '还没有决策记录。' : rows.map((row) => `- ${row.at} ${row.skillName} → ${row.finalAction}`).join('\n') };
                    }
                    const result = action === 'audit'
                        ? await runAudit({ ctx, config, state, options: { mode: 'apply', source: 'command' } })
                        : action === 'consolidate'
                            ? await runConsolidation({ ctx, config, state, options: { mode: 'review', source: 'command' } })
                            : await runPass({ ctx, config, state, options: { mode: action === 'apply' ? 'apply' : 'review', source: 'command' } });
                    return { kind: 'text', text: result.ok === false ? `失败：${result.error}` : result.report };
                } catch (error) {
                    return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                }
            },
        });
    });

    if (Number(config.intervalMinutes) > 0) {
        ctx.effect(() => {
            const timer = setInterval(() => {
                if (state.running) return;
                state.running = runPass({
                    ctx,
                    config,
                    state,
                    options: { mode: config.autoApply ? 'apply' : 'review', source: 'ticker' },
                })
                    .catch((error) => {
                        const message = `定时审查失败：${error instanceof Error ? error.message : String(error)}`;
                        try {
                            if (typeof ctx.logger === 'function') ctx.logger('skill-autopilot').warn(message);
                        } catch {
                            /* logging must never break the ticker */
                        }
                    })
                    .finally(() => {
                        state.running = undefined;
                    });
            }, Number(config.intervalMinutes) * 60_000);
            timer.unref?.();
            return () => clearInterval(timer);
        }, 'dsh-skill-autopilot: interval review');
    }
}

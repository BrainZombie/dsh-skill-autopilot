/**
 * Decision log + human-readable report.
 *
 * Every run appends one line per suggestion to `decisions.jsonl` (append-only,
 * easy to grep later) and rewrites `last-run.json`. The report is what the
 * tool/command returns, so a run can be audited without opening the log.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function logDir(config, dshHome) {
    const configured = String(config.logDir ?? '').trim();
    if (configured) return configured;
    return join(dshHome, 'storages', 'skill-autopilot');
}

async function ensure(dir) {
    await mkdir(dir, { recursive: true });
}

export async function appendLog(dir, record) {
    await ensure(dir);
    await appendFile(join(dir, 'decisions.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function saveLastRun(dir, payload) {
    await ensure(dir);
    await writeFile(join(dir, 'last-run.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function readHistory(dir, limit = 10) {
    try {
        const text = await readFile(join(dir, 'decisions.jsonl'), 'utf8');
        const rows = text.split('\n').filter(Boolean).map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return undefined;
            }
        }).filter(Boolean);
        return rows.slice(-limit).reverse();
    } catch {
        return [];
    }
}

const ACTION_LABEL = { create: '新建', merge: '归并', dismiss: '不建', defer: '留待下轮' };

/**
 * One compact block per suggestion, then a total line.
 * @param {Array<{suggestion, decision, gate, applied?}>} entries
 */
export function formatEntries(entries) {
    const lines = [];
    for (const entry of entries) {
        const { suggestion, decision, gate, applied } = entry;
        const action = ACTION_LABEL[gate.action] ?? gate.action;
        const target = gate.action === 'merge' && gate.mergeInto ? ` → ${gate.mergeInto}` : '';
        const result = applied
            ? applied.applied
                ? `已落盘${applied.versionId ? `（版本 ${String(applied.versionId).slice(0, 8)}）` : ''}`
                : `未落盘（${applied.notes.join('；')}）`
            : 'dry-run';
        lines.push(`- ${suggestion.skillName}：${action}${target}｜置信 ${suggestion.confidence}｜${result}`);
        if (gate.reasons.length > 0) lines.push(`  理由：${gate.reasons.join('；')}`);
        if (decision?.reason && !gate.reasons.includes(decision.reason)) lines.push(`  模型：${decision.reason}`);
        if (applied?.notes?.length) for (const note of applied.notes) lines.push(`  注：${note}`);
        if (entry.doc?.name && gate.action !== 'dismiss') lines.push(`  技能：${entry.doc.name} — ${entry.doc.description}`);
    }
    return lines;
}

export function formatSummary({ pending, considered, applied, dismissed, deferred, notes }) {
    const parts = [`待处理 ${pending} 条`, `本轮审查 ${considered} 条`, `落盘 ${applied} 条`, `不建 ${dismissed} 条`];
    if (deferred > 0) parts.push(`留待下轮 ${deferred} 条`);
    return `${parts.join('｜')}${notes ? `\n${notes}` : ''}`;
}

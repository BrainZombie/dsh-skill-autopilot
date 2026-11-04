/**
 * Skill inventory: what already exists, and how close a candidate is to it.
 *
 * Two inventories, because they answer different questions:
 *   - the Skills Source catalog -> what may be merged into or updated;
 *   - plugin-shipped skills     -> what must NOT be re-distilled (the user's
 *     "don't duplicate what a plugin already covers" rule). Those live under
 *     `<profile>/node_modules/<pkg>/skills/<name>/SKILL.md` and never show up
 *     in the Source catalog.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';

const EN_STOP = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'your', 'you', 'use', 'using',
    'skill', 'skills', 'dsh', 'deepseek', 'harness', 'plugin', 'file', 'files', 'run', 'tool', 'tools',
    'about', 'after', 'before', 'them', 'they', 'then', 'than', 'over', 'such', 'only', 'also', 'more',
]);

/** Token set: ASCII words ≥3 chars plus CJK bigrams. */
export function tokens(text) {
    const lower = String(text ?? '').toLowerCase();
    const out = new Set();
    for (const word of lower.match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []) {
        const clean = word.replace(/[._-]+/g, ' ');
        for (const part of clean.split(' ')) {
            if (part.length >= 3 && !EN_STOP.has(part)) out.add(part);
        }
    }
    const cjk = lower.replace(/[^\u4e00-\u9fff]+/g, ' ');
    for (const run of cjk.split(' ')) {
        if (!run) continue;
        if (run.length === 1) out.add(run);
        for (let index = 0; index + 1 < run.length; index += 1) out.add(run.slice(index, index + 2));
    }
    return out;
}

/** Jaccard similarity of two token sets, 0..1. */
export function similarity(a, b) {
    const left = tokens(a);
    const right = tokens(b);
    if (left.size === 0 || right.size === 0) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / (left.size + right.size - shared);
}

/** Parse the YAML-ish frontmatter of a SKILL.md without a YAML dependency. */
export function parseFrontmatter(text) {
    const source = String(text ?? '');
    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return { data: {}, body: source, frontmatter: '' };
    const data = {};
    for (const line of match[1].split(/\r?\n/)) {
        const pair = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!pair) continue;
        let value = pair[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        data[pair[1]] = value;
    }
    return { data, body: source.slice(match[0].length), frontmatter: match[1] };
}

async function listDir(path) {
    try {
        return await readdir(path, { withFileTypes: true });
    } catch {
        return [];
    }
}

/**
 * Collect plugin-shipped skills under one or more node_modules roots.
 * Layouts covered: `<pkg>/skills/<name>/SKILL.md` and `<pkg>/skills/<name>.md`.
 * @returns {Promise<Array<{name, description, package, path}>>}
 */
export async function scanPluginSkills(roots, { limit = 600 } = {}) {
    const found = [];
    const seen = new Set();
    for (const root of roots) {
        if (!root) continue;
        const packages = await listDir(root);
        for (const entry of packages) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const packageName = entry.name;
            const base = packageName.startsWith('@') ? join(root, packageName) : join(root, packageName);
            const scoped = packageName.startsWith('@');
            const packageDirs = scoped ? (await listDir(base)).map((child) => join(base, child.name)) : [base];
            for (const pkgDir of packageDirs) {
                const skillsDir = join(pkgDir, 'skills');
                const children = await listDir(skillsDir);
                for (const child of children) {
                    if (found.length >= limit) return dedupe(found, seen);
                    const childPath = join(skillsDir, child.name);
                    const skillFile = child.isDirectory() ? join(childPath, 'SKILL.md') : child.name.endsWith('.md') ? childPath : undefined;
                    if (!skillFile) continue;
                    const loaded = await readSkillHead(skillFile);
                    if (!loaded) continue;
                    const name = String(loaded.data.name ?? basename(skillFile, '.md')).trim();
                    if (!name) continue;
                    found.push({
                        name,
                        description: String(loaded.data.description ?? loaded.data.summary ?? '').trim().slice(0, 400),
                        package: scoped ? `${basename(base)}/${basename(pkgDir)}` : packageName,
                        path: skillFile,
                    });
                }
            }
        }
    }
    return dedupe(found, seen);
}

function dedupe(rows, seen) {
    const out = [];
    for (const row of rows) {
        const key = `${row.name}::${row.package}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}

async function readSkillHead(path) {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 512 * 1024) return undefined;
        const text = await readFile(path, 'utf8');
        return parseFrontmatter(text);
    } catch {
        return undefined;
    }
}

/** Group names into prefix clusters (`deck-*`, `hermes-*`) for consolidation. */
export function clusterByPrefix(skills, { minCluster = 2 } = {}) {
    const buckets = new Map();
    for (const skill of skills) {
        const head = String(skill.name).split('-')[0];
        if (!head || head.length < 3) continue;
        const list = buckets.get(head) ?? [];
        list.push(skill);
        buckets.set(head, list);
    }
    return [...buckets.entries()]
        .filter(([, list]) => list.length >= minCluster)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([prefix, list]) => ({ prefix, skills: list }));
}

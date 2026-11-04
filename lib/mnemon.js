/**
 * Bridge to the mnemon Skills Source (`dsh-mnemon-source-skills`).
 *
 * The Source is the only writer that knows how a skill evolution suggestion,
 * its draft, the version ledger and the skill roots fit together. Instead of
 * re-implementing that (and corrupting `ledger.json`), this module builds a
 * second Source instance over the SAME data directory and calls its documented
 * management API:
 *
 *   read  : overview | catalog | suggestions | suggestion | evidence-pack | skill | revision
 *   write : draft-record | draft-adopt | skill-save | skill-delete
 *
 * `SkillsStore` reads and writes `ledger.json` per call under a storage lock,
 * so a second instance stays consistent with the one the Host owns.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const MODULE_NAME = 'dsh-mnemon-source-skills';

/** Where to look for the Source package when a bare import fails. */
function defaultSearchDirs({ dshHome }) {
    const home = homedir();
    const resolvedHome = dshHome ?? (process.env.DSH_HOME?.trim() || join(home, '.dsh'));
    const dirs = [
        join(resolvedHome, 'profiles', 'web', 'node_modules'),
        join(resolvedHome, 'profiles', 'node_modules'),
        join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
        join(home, 'AppData', 'Roaming', 'npm', 'node_modules'),
    ];
    return [...new Set(dirs.filter(Boolean))];
}

async function importModule(searchDirs) {
    const attempts = [MODULE_NAME];
    for (const dir of searchDirs) attempts.push(pathToFileURL(join(dir, MODULE_NAME, 'lib', 'index.js')).href);
    const failures = [];
    for (const specifier of attempts) {
        try {
            return await import(specifier);
        } catch (error) {
            failures.push(`${specifier}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
    }
    throw new Error(
        `找不到 ${MODULE_NAME}（技能管理数据源）。请确认 profile 里装了 dsh-mnemon，或把插件装到同一个 profile。\n尝试过:\n${failures.join('\n')}`,
    );
}

/** Find the directory whose `skills/ledger.json` is the live evolution ledger. */
export function detectMnemonDataDir({ configured, dshHome }) {
    const candidates = [];
    if (configured && String(configured).trim() !== '') candidates.push(resolve(String(configured).trim()));
    candidates.push(join(homedir(), '.mnemon'));
    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'skills', 'ledger.json'))) return candidate;
    }
    return candidates[0] ?? join(homedir(), '.mnemon');
}

export class SkillsBridge {
    #module;
    #instance;
    #dataDir;

    static async create({ dataDir, dshHome, agentsHome, searchDirs }) {
        const bridge = new SkillsBridge();
        bridge.#dataDir = dataDir;
        bridge.#module = await importModule(searchDirs ?? defaultSearchDirs({ dshHome }));
        const options = { dataDir };
        if (dshHome) options.dshHome = dshHome;
        if (agentsHome) options.agentsHome = agentsHome;
        const source = bridge.#module.createSkillsMemorySource(options);
        bridge.#instance = source.create({ configuration: {}, sourceInstanceKey: 'skill-autopilot' });
        return bridge;
    }

    get dataDir() {
        return this.#dataDir;
    }

    async #call(request) {
        return this.#instance.manage({ scope: {}, ...request });
    }

    async read(operation, input = {}) {
        const result = await this.#call({ mode: 'read', operation, input });
        return { revision: result?.revision, value: result?.value };
    }

    async revision() {
        const result = await this.read('revision');
        return result.revision;
    }

    /**
     * Run one confirmed mutation. The Source rejects a stale `expectedRevision`,
     * so a concurrent write from the Host's own page cannot be clobbered: we
     * re-read once and retry, then surface the conflict.
     */
    async write(operation, input = {}) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const expectedRevision = await this.revision();
            try {
                const result = await this.#call({ mode: 'write', operation, input, confirmed: true, expectedRevision });
                return { revision: result?.revision, value: result?.value };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (attempt === 1 || !/changed since it was read/i.test(message)) throw error;
            }
        }
        throw new Error('unreachable');
    }

    async overview() {
        return (await this.read('overview')).value;
    }

    async suggestions(statuses) {
        const input = statuses && statuses.length > 0 ? { status: statuses } : {};
        return (await this.read('suggestions', input)).value ?? [];
    }

    async pending() {
        return this.suggestions(['pending']);
    }

    async catalog() {
        return (await this.read('catalog')).value;
    }

    async evidencePack(suggestionId) {
        return (await this.read('evidence-pack', { suggestionId })).value;
    }

    async skill(key) {
        return (await this.read('skill', { key })).value;
    }

    async recordDraft(input) {
        return (await this.write('draft-record', input)).value;
    }

    async adoptDraft(id, root) {
        const input = root ? { id, root } : { id };
        return (await this.write('draft-adopt', input)).value;
    }

    async saveSkill({ key, content, expectedHash }) {
        return (await this.write('skill-save', { key, content, expectedHash })).value;
    }

    async trashSkill({ key, expectedHash }) {
        return (await this.write('skill-delete', { key, expectedHash })).value;
    }
}

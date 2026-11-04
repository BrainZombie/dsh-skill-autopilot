/**
 * Dev-only: link the DSH packages this plugin imports (and the mnemon Skills
 * Source) into ./node_modules so `node test/host-contract.mjs` can run outside
 * the Host. Idempotent; safe to re-run.
 *
 *   node test/link-deps.mjs            # create the junctions
 *   node test/link-deps.mjs --remove   # remove them
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const home = process.env.USERPROFILE ?? homedir();
const dshHome = process.env.DSH_HOME?.trim() || join(home, '.dsh');
const profiles = join(dshHome, 'profiles');

const links = [
    [join('node_modules', '@deepseek-ai', 'dsh-tools'), join(profiles, 'node_modules', '@deepseek-ai', 'dsh-tools')],
    [join('node_modules', '@deepseek-ai', 'dsh-llm'), join(profiles, 'node_modules', '@deepseek-ai', 'dsh-llm')],
    [join('node_modules', 'dsh-mnemon-source-skills'), join(profiles, 'web', 'node_modules', 'dsh-mnemon-source-skills')],
];

const remove = process.argv.includes('--remove');

for (const [relative, target] of links) {
    const link = resolve(relative);
    if (remove) {
        if (existsSync(link)) {
            rmSync(link, { recursive: true, force: true });
            console.log(`removed ${relative}`);
        }
        continue;
    }
    if (existsSync(link)) {
        console.log(`exists  ${relative}`);
        continue;
    }
    if (!existsSync(target)) {
        console.log(`skip    ${relative} (missing target ${target})`);
        continue;
    }
    mkdirSync(resolve(relative, '..'), { recursive: true });
    symlinkSync(target, link, 'junction');
    console.log(`linked  ${relative} -> ${target}`);
}

if (remove) {
    const dir = resolve('node_modules');
    try {
        rmSync(dir, { recursive: true, force: true });
        console.log('removed node_modules');
    } catch {
        /* ignore */
    }
}

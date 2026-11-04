/**
 * 给「记忆系统 → 技能管理 → 进化」的工具条加一个按钮，点一下调本插件的
 * `/api/skill-autopilot/evolve`，跑一轮自动审查。
 *
 * 为什么是补丁而不是插件：那个页面由 `dsh-mnemon-source-skills` 的客户端包
 * 自行渲染（技能/进化/评测/市场/回收站是它内部的 tab，走的是组件内 state），
 * mnemon 的客户端 SDK 只对外开「整页」插槽，没有给第三方留页内按钮位。
 * 所以这里按用户要求做补丁，并保证：可预演、可幂等、可一键回滚、语法自检。
 *
 * 用法：
 *   node patch-ui.mjs            # 预演（默认，不写文件）
 *   node patch-ui.mjs --apply    # 写入（自动备份 + node --check 自检）
 *   node patch-ui.mjs --remove   # 回滚（从备份恢复，或按标记摘除）
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dshHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh');
const candidates = [
    join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-mnemon-source-skills', 'lib', 'client.js'),
    join(dshHome, 'profiles', 'node_modules', 'dsh-mnemon-source-skills', 'lib', 'client.js'),
];
const target = candidates.find((path) => existsSync(path));
if (!target) {
    console.error('找不到 dsh-mnemon-source-skills/lib/client.js，先确认 profile 里装了 dsh-mnemon。');
    process.exit(2);
}

const MARKER = '/* skill-autopilot:ui */';
const ANCHOR = `\t\t\t\t\tchildren: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkleRegular, { size: 16 })
\t\t\t\t})]`;

const NODE = `${MARKER} (0, react_jsx_runtime.jsx)("button", {
\t\t\t\t\ttype: "button",
\t\t\t\t\tclassName: css.skIconButton,
\t\t\t\t\tdisabled: !context.writable,
\t\t\t\t\t"aria-label": "全量审计并落地（skill-autopilot）",
\t\t\t\t\ttitle: "全量审计：把整队待处理聚成类级主题，值得的合成一个技能落地，碎片并进已有技能（按住 Shift 只审不写）",
\t\t\t\t\tonClick: (event) => {
\t\t\t\t\t\tconst button = event.currentTarget;
\t\t\t\t\t\tconst mode = event.shiftKey ? "review" : "apply";
\t\t\t\t\t\tconst label = mode === "apply" ? "全量审计中" : "审计预览中";
\t\t\t\t\t\tconst rpcId = () => (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
\t\t\t\t\t\tconst call = (endpoint, payload) => fetch("/api/skill-autopilot/" + endpoint, {
\t\t\t\t\t\t\tmethod: "POST",
\t\t\t\t\t\t\tcredentials: "same-origin",
\t\t\t\t\t\t\theaders: { "content-type": "application/json" },
\t\t\t\t\t\t\tbody: JSON.stringify({ type: "client-request", rpcId: rpcId(), method: "skill-autopilot/" + endpoint, payload: payload })
\t\t\t\t\t\t}).then((response) => response.json());
\t\t\t\t\t\tconst settle = (summary) => {
\t\t\t\t\t\t\tbutton.disabled = false;
\t\t\t\t\t\t\tdelete button.dataset.pulse;
\t\t\t\t\t\t\tbutton.title = summary || "完成";
\t\t\t\t\t\t\tconsole.info("[skill-autopilot]", summary);
\t\t\t\t\t\t\ttry { context.refresh(); } catch (ignored) {}
\t\t\t\t\t\t};
\t\t\t\t\t\tbutton.dataset.pulse = "";
\t\t\t\t\t\tbutton.disabled = true;
\t\t\t\t\t\tbutton.title = label + "…";
\t\t\t\t\t\tvoid call("evolve", { action: "audit", mode: mode, maxItems: 40 }).then((reply) => {
\t\t\t\t\t\t\tconst started = (reply && reply.result && reply.result.value) || {};
\t\t\t\t\t\t\tif (started.busy) { settle("已有一次在跑，等它结束再点"); return; }
\t\t\t\t\t\t\tlet ticks = 0;
\t\t\t\t\t\t\tconst timer = setInterval(() => {
\t\t\t\t\t\t\t\tticks += 1;
\t\t\t\t\t\t\t\tbutton.title = label + "… " + ticks * 4 + "s";
\t\t\t\t\t\t\t\tvoid call("progress", {}).then((poll) => {
\t\t\t\t\t\t\t\t\tconst snap = (poll && poll.result && poll.result.value) || {};
\t\t\t\t\t\t\t\t\tif (snap.running) return;
\t\t\t\t\t\t\t\t\tclearInterval(timer);
\t\t\t\t\t\t\t\t\tsettle(snap.summary ? snap.summary : (snap.ok === false ? "失败" : "完成"));
\t\t\t\t\t\t\t\t}).catch(() => {});
\t\t\t\t\t\t\t}, 4000);
\t\t\t\t\t\t}).catch((error) => {
\t\t\t\t\t\t\tsettle("失败：" + ((error && error.message) || error));
\t\t\t\t\t\t});
\t\t\t\t\t},
\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChecklistOutlineRegular, { size: 16 })
\t\t\t\t})`;

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--remove') ? 'remove' : 'dry-run';
const source = readFileSync(target, 'utf8');
const patched = source.includes(MARKER);
const nodeCheck = () => {
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    return { ok: result.status === 0, message: (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | ') };
};

function backups() {
    return readdirSync(dirname(target))
        .filter((name) => name.startsWith('client.js.bak-skill-autopilot-'))
        .sort()
        .reverse()
        .map((name) => join(dirname(target), name));
}

if (mode === 'dry-run') {
    console.log(`target : ${target}`);
    console.log(`状态   ：${patched ? '已打过补丁' : '未打补丁'}`);
    console.log(`备份   ：${backups()[0] ?? '(无)'}`);
    console.log(`计划   ：${patched ? '跳过（幂等）' : '在「进化」工具条 ✨ 按钮后追加 1 个按钮'}`);
    process.exit(0);
}

if (mode === 'remove') {
    const list = backups();
    if (list.length > 0) {
        copyFileSync(list[0], target);
        console.log(`已从备份恢复：${list[0]}`);
    } else if (patched) {
        const stripped = source.replace(`, ${MARKER} (0, react_jsx_runtime.jsx)("button", {`, '\n__CUT__')
            .replace(/__CUT__[\s\S]*?\n\t\t\t\t\}\)(?=\])/, '');
        writeFileSync(target, stripped, 'utf8');
        console.log('已按标记摘除按钮');
    } else {
        console.log('没有补丁，也没有备份，什么都不用做');
        process.exit(0);
    }
    const check = nodeCheck();
    console.log(check.ok ? '语法自检：通过' : `语法自检：失败 — ${check.message}`);
    process.exit(check.ok ? 0 : 1);
}

if (patched) {
    console.log('已经打过补丁（幂等），跳过。');
    process.exit(0);
}
if (!source.includes(ANCHOR)) {
    console.error('锚点不匹配：这个版本的 client.js 结构与预期不同，未做修改。');
    process.exit(3);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${target}.bak-skill-autopilot-${stamp}`;
copyFileSync(target, backup);
writeFileSync(target, source.replace(ANCHOR, `${ANCHOR.slice(0, ANCHOR.length - 2)}),\n\t\t\t\t${NODE}]`), 'utf8');

const check = nodeCheck();
if (!check.ok) {
    copyFileSync(backup, target);
    console.error(`语法自检失败，已自动回滚：${check.message}`);
    process.exit(1);
}
console.log(`已写入：${target}`);
console.log(`备份  ：${backup}`);
console.log('语法自检：通过');
console.log('生效  ：刷新页面（Ctrl+Shift+R）；若客户端模块被 Host 缓存，重启 DSH 后再刷新。');

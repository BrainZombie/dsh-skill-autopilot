// 手工合并：把 pending 建议 dsh-session-query-timeboxed 的「按时间窗检索 DSH 会话」
// 作为新一节追加进已有技能 hermes-session-recall，原文所有小节逐字保留。
// 走 Skills Source 的 draft-record → adopt（会留版本行），并跑 lintMergeDiff 做守恒校验。
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// 从脚本自身位置推回 lib/，这样仓库 clone 到任何目录都能跑。
const plugin = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const { SkillsBridge } = await import(pathToFileURL(`${plugin}/mnemon.js`).href);
const { applyApproved } = await import(pathToFileURL(`${plugin}/apply.js`).href);
const { lintMergeDiff } = await import(pathToFileURL(`${plugin}/policy.js`).href);

const bridge = await SkillsBridge.create({ dataDir: join(homedir(), '.mnemon') });
const SKILL = 'user-dsh:hermes-session-recall';
const suggestion = (await bridge.pending()).find((s) => s.skillName === 'dsh-session-query-timeboxed');
if (!suggestion) throw new Error('pending 建议不见了');
const skill = await bridge.skill(SKILL);
if (!skill) throw new Error('技能不存在: ' + SKILL);

const SECTION = `
## DSH 侧按时间窗检索（没有会话 ID 时的等价路径）

Hermes 的会话在 \`state.db\`，DSH 自己的会话不在那里——走 DSH 的检索工具。原则不变：**先定位到会话，再把原文取回核对**，不要指望一次全文搜索就直接捞出结论。

### 三件工具与它们的 30 秒预算

- \`session_search\`：跨会话字面检索，每条会话只回最相关的一条事件。
- \`session_event_search\`：单个会话内检索事件（已知会话 ID 时用这个）。
- \`session_trace\`：会话血缘（父子/派生关系）。

三者默认都挂 **30 s** 上限（\`dsh-tool-session-query\` 的 \`searchTimeoutMs=30000\`）。到点未返回会被 \`tool-call-timeout-policy\` 替换成固定错误文本 \`Error: tool call timed out after 30000ms\`——**超时只说明"没跑完"，不代表"没有这条会话"**。

### 语料体量（本机 2026-11-02 实测）

379 个会话转写、95 MB（zstd，平均 45 个压缩帧）、485 个投影缓存 58 MB。冷查询对全量扫一遍必然超 30 s，所以**缩窗口，不要先想加大预算**。

### 阶梯查法（一级一级放宽，命中就停）

1. 先给时间窗，从近 7 天起：\`session_search({query, created_at_from, created_at_to})\`。
2. 有候选就精确到会话：\`session_ids\` 或 \`parent_session_ids\` 收窄；此时不要同时叠一个宽时间窗，两者会互相限制。
3. 还太宽就加 \`event_types\`、\`availability\` 过滤。
4. 仍 0 命中再逐级放宽：7 天 → 30 天 → 90 天。
5. **已知会话 ID 直接 \`session_event_search\`**（只扫一个会话，几乎不会超时）；要看血缘用 \`session_trace\`。

### 旁路：找"哪条会话在干什么"不必全文搜

标题与首条用户消息就在投影缓存里，字段是 \`record.rows.title.val\` 与 \`record.rows.titleInput.first.text\`：

\`\`\`bash
cd "$HOME/.dsh/storages/session_projcache/sessions" && node -e "
const fs=require('fs');
const q=process.argv[1];
for (const f of fs.readdirSync('.')) {
  if (!f.endsWith('.json')) continue;
  const s=fs.readFileSync(f,'utf8');
  if (s.includes(q)) console.log(f.replace('.json',''), '|', (s.match(/\"title\":\\{\"ver\":1,\"seq\":\\d+,\"val\":\"([^\"]{0,60})/)||[])[1]||'');
}" rhg
\`\`\`

485 个文件全量匹配约 0.2 s（实测 191 ms），比让模型去搜会话稳得多；命中后按会话 ID 用 \`session_event_read\` 取原文。

### 坑

- 超时被替换成固定错误文本，不是"检索为空"——别据此断定没聊过。
- 关键词越长越容易 0 命中；**靠时间窗比靠缩关键词有效**。
- 检索按 workspace 收敛；要跨工作区找，显式给 \`session_ids\` 或换到该会话所在 workspace。
- \`session_search\` 一条会话只给一条事件，要全文必须再 \`session_event_read\`。
- 真要调预算：\`dsh-tool-session-query\` 的 \`searchTimeoutMs\`（默认 30000）可以调大，但那是治标，先缩时间窗。

### 验收

- 结论里带 \`会话 id + 标题 + 时间窗 + 命中 seq\`，并能用同一条 \`session_event_read\` 复读出同一事件。
- 报告写明走了哪一级阶梯（7 天／30 天／90 天／按 ID），以及过程中是否出现过 \`TOOL_TIMEOUT\`。
`;

const previousBody = skill.body;
const mergedBody = `${previousBody.replace(/\s+$/, '')}\n${SECTION}`;
const description =
    '按会话 ID 或时间窗只读回捞 Hermes/DSH 会话原文，并以「聊天记录当索引、磁盘最终件才是口径」定位最新 docx/pptx 核对；用户说「按 hermes 最新情况来」「把这个会话的原文调出来」「最后定稿到哪一版」时使用。';

const diff = lintMergeDiff(previousBody, mergedBody);
console.log('=== 守恒校验 ===');
console.log('hard:', diff.hard.length ? diff.hard : 'none');
console.log('soft:', diff.soft.length ? diff.soft : 'none');
console.log('原文小节保留:', diff.droppedSections.length === 0 ? `全部 ${previousBody.match(/^## /gm).length} 节都在` : diff.droppedSections);
console.log('原文长度 →', previousBody.length, '→', mergedBody.length, '| description', description.length, '字');

if (diff.hard.length > 0) {
    console.error('硬拦，未落盘');
    process.exit(1);
}

const result = await applyApproved({
    bridge,
    suggestion,
    doc: {
        name: 'hermes-session-recall',
        description,
        body: mergedBody,
        changes: ['新增「DSH 侧按时间窗检索」一节（时间窗阶梯 + 30s 预算 + projcache 旁路）'],
        dropped: [],
    },
    mode: 'merge',
    policy: { descriptionMaxChars: 240, maxMergedBodyChars: 24000 },
    targetRoot: 'user-dsh',
    existingNames: [],
    gate: { reasons: ['手工合并：保留英文原文所有小节，追加中文补充节'] },
    previousBody,
});
console.log('=== 落盘 ===');
console.log(JSON.stringify(result, null, 2));

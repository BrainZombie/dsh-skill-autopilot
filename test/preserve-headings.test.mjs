// 回归：归并时以原文骨架为准 + 标题归一化比对。
// 运行：node test/preserve-headings.test.mjs
import { pathToFileURL } from 'node:url';

const base = new URL('../lib/policy.js', import.meta.url);
const m = await import(base.href + '?v=' + Date.now());

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name);
  }
};

const policy = { maxMergedBodyChars: 24000, descriptionMaxChars: 240 };
const item = { suggestion: { skillName: 'docker-local-ops', action: 'update', summary: 's', rationale: 'r', signals: [] }, excerpts: [] };
const body = '## 一、部署形态裁定\n读 build.sh 判产物用途 `build.sh`\n## 二、镜像归档\n多 tag 只打一个 tar `docker save`\n';

console.log('[P1] 归并提示词带小节清单');
const pMerge = m.buildComposePrompt({ item, decision: { decision: 'merge', mergeInto: 'docker-local-ops' }, existing: { name: 'docker-local-ops', description: 'd', body }, policy });
ok(pMerge.includes('# 必须保留的小节清单(2 个'), '出现小节清单标题');
ok(pMerge.includes('## 一、部署形态裁定') && pMerge.includes('## 二、镜像归档'), '清单列出全部现有小节');
ok(pMerge.includes('不许重命名、不许合并、不许删除'), '带逐条保留要求');
ok(!pMerge.includes('## 何时使用 → ## 前置条件'), '归并时不再强制五节模板');

console.log('[P1] 新建提示词保持原模板');
const pNew = m.buildComposePrompt({ item, decision: { decision: 'create' }, existing: undefined, policy });
ok(pNew.includes('## 何时使用 → ## 前置条件'), '新建仍用五节骨架');
ok(!pNew.includes('必须保留的小节清单'), '新建无清单');

console.log('[P3] 标题归一化比对');
const filler = '规则一行。'.repeat(200);
const before = body + filler;
const renamed = '## 部署形态裁定\n读 build.sh 判产物用途 `build.sh`\n## 镜像归档\n多 tag 只打一个 tar `docker save`\n' + filler;
const r1 = m.lintMergeDiff(before, renamed);
ok(r1.droppedSections.length === 0, '仅改名不算丢小节（dropped=' + r1.droppedSections.length + '）');
ok(r1.hard.length === 0, '仅改名不触发 hard');

const dropped = '## 部署形态裁定\n读 build.sh 判产物用途 `build.sh`\n' + filler;
const r2 = m.lintMergeDiff(before, dropped);
ok(r2.droppedSections.length === 1, '真删一个小节仍被识别（dropped=' + r2.droppedSections.length + '）');

console.log(`\nPASS: ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);

# dsh-skill-autopilot

把 DSH「记忆系统 → 技能管理 → 进化」里那批**待处理建议**，交给**你配置的大模型**审查，按一套反碎片化的准入策略裁决，通过后打包成 `SKILL.md` 并经技能数据源落盘（带版本记录、可回滚）。

解决的问题：进化页每次攒 5–10 条建议，每条都要人点开看一遍；而模型自己提的建议又常常是「一次任务的流水」，直接采纳会让技能库迅速变成几百个窄技能。这个插件把「审」和「发」都自动化，但把「什么样的技能才配进库」写成硬性规则，模型只能在这个框里做判断。

## Requirements

| 需要什么 | 版本 | 为什么 |
| --- | --- | --- |
| DeepSeek Harness | >= 0.2.0 | 提供 `tools` / `llm` 服务与插件挂载点 |
| Node.js | >= 20 | 主机侧全是 ESM |
| `dsh-mnemon-source-skills`（可选 peer） | >= 0.4.0 | 技能数据源；缺失时插件仍可加载，但读不到 `pending` 建议 |
| 一个可用的审查模型 | — | 走设置页默认模型，或在 `config.reviewer` 里显式填 `provider` / `model` |

---

## 1. 它做什么（一次运行）

```
pending 建议 ──► 审查模型(你选的) ──► 确定性闸门 ──► 打包 SKILL.md ──► 落盘 + 版本记录
   (mnemon)        (语义判断)          (不可绕过)        (蒸馏/清洗)        (adopt)
```

1. **读**：从 mnemon 的 Skills Source 取 `pending` 建议、证据轨迹、评测用例、以及**全量技能目录**。
2. **审**：一次批量调用审查模型，逐条给出 `create / merge / dismiss / defer` + 理由 + 归并目标。
3. **闸**（模型说完不算数，代码再判一遍）：
   - 建议置信度 < `minConfidence` → 不建；
   - 模型自己对「新建」的把握 < `minModelConfidence` → 留待下轮（不硬发）；
   - 没有强信号（`procedure / correction / directive / skill-gap / skill-misleading / approach-change`）→ 不建；
   - **插件已提供该能力** → 不建（对照的是宿主实际广告的技能，含插件技能）；
   - 与已有技能相似度 ≥ `mergeSimilarity`，或与已有技能同属 `xxx-*` 前缀簇**且内容确实相关** → **强制归并**，不许新增兄弟技能；
   - 本轮 `create` 超过 `maxNewPerRun` → 留到下一轮（防止一次灌进一堆碎片）；
   - 打包后的 `SKILL.md` 过 lint（见 §3）。
4. **打包**：为通过的条目单独再调一次模型，产出正文；顺手剔除会腐化的内容（日期、会话 id、uuid、机器绝对路径、「N 小时前」）。
5. **落盘**：`recordDraft` → `adoptDraft`，走技能数据源自己的写入口：建议置为 `adopted`、生成版本记录、必要时可 `技能管理 → 版本/回收站` 回滚。**不直接写 SKILL.md**。

默认 `autoApply: false`：`review` 只出决策 + 将要落盘的正文，一个字节都不写；确认后 `apply` 才落盘。

## 2. 反碎片策略（本插件的核心）

| 规则 | 判据 | 出处 |
|---|---|---|
| 库是「类级知识」，不是流水 | 一个技能带 N 个带标签小节 > N 个窄兄弟技能 | Hermes curator |
| 归并优先于新建 | 同 `xxx-*` 前缀簇**且内容相关**、或 description 相似 → merge | 同上（只共用产品名不算：`hermes-session-recall` 与 `hermes-plugin-maintenance` 是两条工作流，不并） |
| **不重复造插件已有的能力** | 对照 `ctx.skills.list()`（宿主实际广告的技能），命中即 dismiss | 你的要求 |
| 小打小闹不单独建 | 强信号 + 置信度 + `minNewPerRun` + 正文长度下限 | 你的要求 |
| 不写 hub/router 技能 | 正文 >60% 行是「指向别的技能」→ 拒绝 | Hermes 作者规范 |
| description 一句话 | 超长会被系统技能索引截断，触发词等于没有 | Hermes（60 字规则，这里放宽到可配） |
| 归档不删除 | 归并时被吸收的技能进「回收站」，可恢复 | Hermes curator |

`consolidate` 动作是配套的「存量体检」：对**已有**技能按前缀/同域聚簇，让模型判断哪些该收敛成一个 umbrella，应用时把合并后的正文写到 keeper、把被吸收的移入回收站（可恢复）。

## 3. 打包校验（`lib/policy.js: lintSkillDoc`）

硬拦：名字非 kebab-case / 重名；缺 description 或超长；正文为空、过短、超长；正文里又带 frontmatter；缺「何时使用」或「步骤」；是 router 技能。

软提示：缺验收小节、正文没有可执行命令、description 开头是套话。

## 4. 用法

装好并重启后，任意会话里：

```
/skill-autopilot status       # 看队列、计数、审查模型、策略、日志目录
/skill-autopilot review       # 只审不写（默认 dry-run）
/skill-autopilot apply        # 审完直接落盘
/skill-autopilot consolidate  # 存量归并审查（只出方案）
/skill-autopilot history      # 最近决策
```

或者直接让 agent 调工具：

```json
{"action": "review", "maxItems": 3}
{"action": "apply", "ids": ["<suggestionId>"]}
{"action": "apply", "provider": "deepseek-official", "model": "deepseek-reasoner"}
{"action": "consolidate", "confirm": true}
```

决策日志（append-only JSONL + 最近一次完整结果）在 `$DSH_HOME/storages/skill-autopilot/`：

- `decisions.jsonl`：每条建议一行，含最终动作、理由、是否落盘、错误；
- `last-run.json`：最近一次运行的完整内容，含将要落盘/已落盘的 `SKILL.md` 正文。

## 5. 配置

插件 patch 里的 `config`（见 [cordis.patch.yml](cordis.patch.yml)）都可省略：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后工具仍在，任何运行直接返回 disabled |
| `mnemonDataDir` | `~/.mnemon` | 其下应有 `skills/ledger.json`；自动探测 |
| `targetRoot` | `user-dsh` | 新技能写到 `~/.dsh/skills`（也可 `user-agents`） |
| `reviewer.provider/model` | 空 = 宿主默认模型 | 留空时用「设置页里选的那个模型」 |
| `reviewer.maxTokens` | `4096` | 审查/打包单次上限 |
| `policy.minConfidence` | `0.8` | 建议置信度低于此值 → 不建（不进模型审） |
| `policy.minModelConfidence` | `0.5` | 模型对「新建」的把握低于此值 → 留待下轮 |
| `policy.maxNewPerRun` | `2` | 每轮最多新建几个 |
| `policy.mergeSimilarity` | `0.45` | 相似度阈值（超过即强制归并） |
| `policy.descriptionMaxChars` | `240` | description 上限 |
| `policy.maxBodyChars` / `maxMergedBodyChars` | `16000` / `24000` | 正文字符上限 |
| `policy.requireStrongSignal` | `true` | 必须有强信号 |
| `autoApply` | `false` | 定时任务是否直接落盘 |
| `intervalMinutes` | `0` | >0 时后台定时跑（默认只 review） |
| `logDir` | 空 = `$DSH_HOME/storages/skill-autopilot` | 日志目录 |

想让判断更狠/更准：把 `reviewer.model` 指向更强的模型（如 `deepseek-reasoner`），把 `mergeSimilarity` 调到 `0.55`、`maxNewPerRun` 调到 `1`。

> 实测提醒：`deepseek-flash` 给「新建」的自评通常在 0.65–0.8 之间；这是**校准值**不是裁决值，所以 `minModelConfidence` 默认只设 0.5。真正决定「配不配进库」的是建议置信度、强信号、去重与文档 lint。

## 6. 安装

```powershell
# 标准模式：写 profile package.json（link: 依赖 + dsh.profile.bundles）并 pnpm install
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun     # 先看计划
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 免 pnpm 模式：只建软链 + 往 profile 的 cordis.patch.yml 追加 insert 条目
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Link

# 回滚（两种模式都认；会还原 package.json / cordis.patch.yml 的备份）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Rollback
```

预检（不启动、不重启）：

```powershell
dsh --profile web --dump-config | Select-String skill-autopilot
```

**生效需要重启 DSH**（重启由使用者自己执行）。

## 7. 验证

```bash
node test/selftest.mjs          # 20 项：闸门/去重/打包/落盘（临时 ledger + 临时技能根，不动真实数据）
node test/selftest.mjs --live   # 追加：只读真实 ledger，确认能读到 pending 与目录
node test/host-contract.mjs     # 用真实 dsh-tools/dsh-llm 走一遍注册与一次 llm 组装调用
```

`selftest` 从不碰 `~/.mnemon/skills` 与 `~/.dsh/skills`：它在 `%TEMP%` 下复制一份 ledger、建一个空的临时技能根，跑完即删。

## 8. 风险与边界

- **写的是真技能**：`apply` 会真的新增/修改 `~/.dsh/skills` 下的技能。但只经数据源写入口，因此有版本记录（`技能管理 → 版本`）与回收站两条退路。
- **模型判断不会 100% 合意**：所以默认 dry-run，且 `review` 会把将要落盘的完整正文放进 `last-run.json` 供先读后发。
- **不要把 `autoApply` + 短 `intervalMinutes` 一起开**：那等于让模型无限自增长技能库。建议 `apply` 手动触发，或 `autoApply` 只配合 `maxNewPerRun: 1`。
- **依赖 mnemon 的内部契约**：本插件通过 `dsh-mnemon-source-skills` 的 `manage()` 读写同一份 ledger；mnemon 升级若改了 operation 名，需要跟着改 `lib/mnemon.js`（所有调用集中在 `read/write` 两个方法里）。
- **项目级技能**（`project-dsh`/`project-agents`）默认只读不建；`consolidate` 只处理 `user-dsh`/`user-agents`，避免动别人仓库里的东西。

## 9. 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 插件接线：工具、`/skill-autopilot` 命令、定时器 |
| `lib/pipeline.js` | 主流程：取建议 → 审查 → 闸门 → 打包 → 落盘；含存量归并 |
| `lib/policy.js` | 审查提示词、确定性闸门、正文 lint、易腐内容清洗、JSON 提取 |
| `lib/review.js` | 模型路由解析 + 一次性结构化调用（`ctx.llm.prepareCall` + `BlockAssembler`） |
| `lib/mnemon.js` | Skills Source 桥：读建议/证据/目录，`draft-record`/`draft-adopt`/`skill-save`/`skill-delete` |
| `lib/inventory.js` | 技能清点：宿主技能目录、插件技能扫描、分词相似度、前缀聚类 |
| `lib/apply.js` | 打包成 SKILL.md、走数据源落盘、归并应用（含入回收站） |
| `lib/report.js` | 决策日志与运行报告 |
| `lib/host.js` | 宿主包解析（免 pnpm 安装时也能找到 `@deepseek-ai/dsh-*`） |
| `install.ps1` | 安装/回滚（标准 / 免 pnpm 两种模式） |
| `test/*.mjs` | 自测、宿主契约测试、开发期依赖软链 |

## 10. 与 Hermes 机制的对应

| Hermes | 本插件 |
|---|---|
| `agent/learn_prompt.py` 的作者规范（frontmatter、章节顺序、60 字 description、不写 hub 技能、命令必须来自来源） | 审查提示词 + `lintSkillDoc` 硬拦/软提示 |
| `agent/curator.py` 的 umbrella 归并（"一个维护者会写成 N 个技能还是 N 个小节？"）、前缀簇、归档不删除、pinned 不动 | `gateDecision` 的前缀簇强制归并 + `consolidate` + 归并时进回收站 |
| `skill_manage` 的「先读后写」 | 归并前先 `bridge.skill(key)` 读原文，再整篇重写 |
| `/learn` 的「已有同类技能就 patch 而不是 create」 | `mergeInto` + 相似度/前缀闸门 |

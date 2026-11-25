---
name: friction-drive
description: 某个正在使用的工具过线后必须使用。已登记工具改它自己的字段。其他工具改为新增或修改本插件的工具，并查看 friction_status 的 notes。反复成功的片段见 compilable，调用 propose_compiled_procedure 前先看候选 asset_id。复杂任务先看 friction_status.quality，未同意不要开始找茬流程。
---

# 更好的 DSH

只处理已经过线的那一个工具。其他工具继续用。

已登记的示例工具仍用它自己的字段，例如 `pageSize`，并继续调用原来的名字。`metric` 只能是 `projected_calls`。补丁键必须和 `friction_status.definitions[].patchKeys` 一致。插件按公式计算调用次数，没有下降就拒绝。然后调用 `apply_tool_change`。

正在使用、但没有登记的工具，不修改它的定义。过线后调用 `propose_tool_goal`，`patch_json` 写：

- `name`：可以省略。实际工具名由插件生成，形如 `fd_原工具_时间`
- `problem`：原工具的问题
- `usage`：新工具怎么用
- `schema`：写成 `{ "dir": { "type": "string", "required": true, "description": "目录" } }`。带 `properties` 和 `required` 的 JSON Schema 也可以。
- `run`：`{ "kind": "script", "command": "命令" }`，或直接写命令字符串。其他工具用 `{ "kind": "delegate", "tool": "原工具名", "overrides": {} }`。`usage` 和 `problem` 最多 200 字，脚本最长 4000 字。

同意之后调用新工具，并查看 `friction_status` 返回的 `notes`。那里写着原工具的问题、新工具的用法和 schema。原工具在这个会话里会被拦住，定义本身不变。

新工具属于本插件，可以再改。对它再次调用 `propose_tool_goal`，写一份不同的 `problem`、`usage`、`schema` 或 `run`。相同的一版会被拒绝。名字保持不变。同意后，本轮仍使用旧的 schema 和说明。这一轮结束后，schema、执行方式和 notes 一起换成新的一版。

调用次数、截断和慢调用只在结果值里有对应标记时才计入。参数校验失败不计分。审批卡不引用模型的概述。不要请用户回复「已授权」。

同意只改变当前会话。要恢复，调用 `restore_tool_definition`。没有更早的版本时，新工具会卸掉，原工具重新可以调用。

同一段外部工具连续成功时，读取 `friction_status.compilable`。那里只有互不重叠的最长片段。调用 `propose_compiled_procedure`，`contract_json` 写：

- `operations`：每步有 `id`、`tool`、`mode`（`program` 或 `agent`）、`pre`、`post`、`run`
- `order`：与观察到的工具顺序一致
- `edges`：上一步输出若出现在下一步参数里，必须写上 `{ "from", "to", "path" }`
- `slots`：槽位名、路径和类型，必须来自观察到的变化参数
- `constants`：必须等于观察到的常量，对象键顺序不影响相等
- `run`：观察到的工具是 `bash` 时写 `{ "kind": "script", "command": "观察到的命令，槽位写成 {{名}}" }`。其他工具只能 `{ "kind": "delegate", "tool": "原工具名", "overrides": {} }`，覆盖值等于观察到的常量

零个已有资产时不要传 `asset_id`。恰好一个时，`asset_id` 必须等于那一个。多个候选时，先看返回里的 `asset_id`，再点名其中一个；不要自己挑脚本。停用的旧版不能当候选。

审批卡会按步列出全部脚本和覆盖值。同意是给当前会话安装 `ec_` 工具，不是放行这一次调用。之后第一步在常量匹配时会被拒绝并改走 `ec_`。槽位只在被校验的两次绑定上有参照。没有审批界面时不要重试安装。

`ec_` 遇到 `agent` 步会停下并返回 `resume_token`。做完该步后，用同一个 `ec_` 工具提交 `resume_token` 和 `step_output`，才会执行后面的程序步。某一步失败时，只重提那一步的 `run`、`pre` 或 `post`，并带上 `revise_step`。不要用 `propose_tool_goal` 整份替换 `ec_`。失败步在新验收通过前仍是 `agent`。已登记示例工具继续用原名。

复杂任务才使用找茬再实现。复杂指会改行为、跨过记分、审批、会话隔离或已同意的工具，或者用户明确要求找茬、实现对抗。一次查询、改一句文案、只读查看，不要提议。

先调用 `propose_quality_loop`，写清任务和为什么复杂。用户没同意就按普通方式做，不要自己写两轮。同意后先 `record_quality_critique`，至少两条，每条有场景和后果。再 `record_quality_plan`：每条修改都要写次生影响，并盖住全部问题。`friction_status.quality.ready` 还是 false 时，不要改代码，也不要改工具。这个流程不代替工具改造或程序沉淀的审批。方案就绪后只改方案里写过的点。

---
name: friction-drive
description: 某个正在使用的工具过线后必须使用。已登记工具改它自己的字段。其他工具改为新增或修改本插件的工具，并查看 friction_status 的 notes。
---

# 摩擦驱动的工具改造

只处理已经过线的那一个工具。其他工具继续用。

已登记的示例工具仍用它自己的字段，例如 `pageSize`，并继续调用原来的名字。`metric` 只能是 `projected_calls`。补丁键必须和 `friction_status.definitions[].patchKeys` 一致。插件按公式计算调用次数，没有下降就拒绝。然后调用 `apply_tool_change`。

正在使用、但没有登记的工具，不修改它的定义。过线后调用 `propose_tool_goal`，`patch_json` 写：

- `name`：可以省略。实际工具名由插件生成，形如 `fd_原工具_时间`
- `problem`：原工具的问题
- `usage`：新工具怎么用
- `schema`：Harness 能表达的参数，可以包含数组和对象
- `run`：`{ "kind": "delegate", "tool": "原工具名", "overrides": {} }`，或 `{ "kind": "script", "command": "含 {{参数}} 的命令" }`

同意之后调用新工具，并查看 `friction_status` 返回的 `notes`。那里写着原工具的问题、新工具的用法和 schema。原工具在这个会话里会被拦住，定义本身不变。

新工具属于本插件，可以再改。对它再次调用 `propose_tool_goal`，写一份不同的 `problem`、`usage`、`schema` 或 `run`。相同的一版会被拒绝。名字保持不变。同意后，本轮仍使用旧的 schema 和说明。这一轮结束后，schema、执行方式和 notes 一起换成新的一版。

调用次数、截断和慢调用只在结果值里有对应标记时才计入。参数校验失败不计分。审批卡不引用模型的概述。不要请用户回复「已授权」。

同意只改变当前会话。要恢复，调用 `restore_tool_definition`。没有更早的版本时，新工具会卸掉，原工具重新可以调用。

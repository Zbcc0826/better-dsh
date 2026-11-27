# dsh-friction-drive

DeepSeek Harness 本地插件（仓库 `Zbcc0826/better-dsh`，不发布到 npm；这不是 `pgmi-builds/better-dsh`，不提供 IPython REPL，也不替换 DSH 的编程能力）。

## 记分与拦线

- 按会话记录正在使用的工具：失败、同参数重试，以及结果值里带截断标记的调用都会计分。参数校验失败不计分；调用次数、截断和慢调用只在结果值里有对应标记时才计入。
- 分数按轮数和时间衰减，工具身份单独保存。
- 同一失败签名第三次，或分数到了拦线时，下一次直接调用不执行，返回 `GATED` 和 `friction_status.card`。
- `friction_status.card` 给出三个选项：沉淀替代、继续一次、本会话暂停。继续一次和暂停都要用户点允许（不要替用户点允许）；继续一次只放行一次，执行完重新评估。
- `friction_pause` 只有用户点允许才暂停本会话闸门，会话结束自动恢复。
- 提示线只在结果后加一句。审批卡不引用模型的概述，也不要请用户回复「已授权」。

## 替代工具、撤回与提案

- 正在使用的工具不需要事先登记，原工具定义不改。
- 摩擦没过线时，直接造替代工具会得到 `BELOW_THRESHOLD`。只有用户明确要求新工具时才调用 `propose_tool_goal`，先请用户确认，不允许就什么都不记下；允许后再调用 `apply_tool_change` 进行第二次审批，装上后原工具仍可调用。只有过线并同意替代后，当前会话才改走新工具。
- 替换工具第一次就报 `inactive context` 时，原工具立刻恢复可用。
- `apply_tool_change` 走一次性审批。没有审批界面时立刻返回未批准，不会安装也不会挂起。同意只影响当前会话（提案设为 `persist: true` 并同意后才跨会话保留）。`restore_tool_definition` 可以撤回；没有更早版本时新工具卸掉，原工具重新可以调用。
- 主动提案写 `name`、`problem`（最多 200 字）、`usage`（最多 200 字）、`schema`（简写对象或带 `properties`/`required` 的 JSON Schema；可选字段不要写 `required: false`，未传变为 `""`，未知参数直接报未知参数）、`run`（脚本最长 4000 字，或 `delegate`；`${dir}`/`{{dir}}` 带 shell 单引号，模板不加引号；`$dir`/`FD_ARGS` 为去引号原值）。名字可保留 `plugin_check`（不会变成 `fd_bash_时间`），`confirmed` 写在补丁里无用。
- 已经用 `ctx.friction.register` 登记的工具仍按自己的公式和字段修改，并继续使用原名；`metric` 只能是 `projected_calls`，补丁键必须和 `patchKeys` 一致，预计调用次数没有下降就拒绝。

## 程序沉淀与复杂任务

- 同一段外部工具连续成功时，`friction_status.compilable` 只有互不重叠的最长片段。调用 `propose_compiled_procedure` 前先看候选 `asset_id`。审批前不执行原工具或脚本；同意后当前会话安装 `ec_` 工具。
- 复杂任务可另行征求同意，走找茬再实现；简单查询不会自动进入。需在 `friction_status.quality.ready` 为真之后才动手，且该流程不代替上面的审批。

## 工具清单

- `dsh-friction-drive` 只注册这 10 个工具：`friction_status`、`friction_choose`、`friction_pause`、`propose_quality_loop`、`record_quality_critique`、`record_quality_plan`、`propose_tool_goal`、`apply_tool_change`、`restore_tool_definition`、`propose_compiled_procedure`。
- 同一个 bundle 还会装上 `dsh-friction-demo`，注册 3 个示例工具：`ledger_lookup`、`fx_convert`、`window_overlap`（它们只是示例，不是账本产品）。

## 安装与状态路径

- 插件页填 `github:Zbcc0826/better-dsh`；或命令行运行 `dsh plugin --profile <profile> add github:Zbcc0826/better-dsh`；或在仓库根目录运行 `node install.mjs`。
- `<profile>` 不是 `desktop`，`dsh plugin --profile desktop` 会被拒绝。装完后重启桌面应用。
- 不要把绝对路径写进 `$DSH_HOME/cordis.patch.yml`（`node install.mjs` 也会清掉那里的旧插入）。不要同时再执行另一套 `dsh plugin add`，两套安装叠在一起会把工具登记两次。
- 状态写在 `$DSH_HOME/friction-drive/sessions/<会话 id>/`。同意一次只改这个会话的 `catalog.json`。

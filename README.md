# Better DSH

Local DeepSeek Harness plugin (`dsh-friction-drive`, repo `Zbcc0826/better-dsh`, not `pgmi-builds/better-dsh`, not published to npm) for user-approved tool repair and compiled procedures.

Records failures, same-argument retries, and truncated results in the current session, then waits for approval (`GATED` + `friction_status.card`) before switching to a replacement tool or `ec_` procedure while keeping original tool definitions unchanged. Full English guide: [README.en.md](README.en.md).

# 更好的 DSH

这是一个本地 DeepSeek Harness（DSH）插件，包名为 `dsh-friction-drive`，GitHub 仓库是 `Zbcc0826/better-dsh`。它不是 `pgmi-builds/better-dsh`：这里不提供 IPython REPL，也不替换 DSH 的编程能力。

插件不发布到 npm，克隆后在本机安装即可；桌面应用和命令行共用一份配置。插件行为来自 Agent 的使用体验，并按 DeepSeek 模型在 DSH 中的真实反馈持续调整。替代工具、沉淀程序以及复杂任务的找茬再实现，都会在执行前征求用户同意，这可能增加 token 消耗。

## 环境

- DeepSeek Harness `0.2.2-rc.3` 或更高，且低于 `0.3.0`
- 已能启动 `dsh` 命令行或桌面应用
- 桌面应用已自带安装插件所需的 pnpm，不必另外安装

## 安装与卸载

下面三种方式任选其一，不要叠加安装。

### 1. 桌面插件页安装

打开 **插件**，点 **添加插件** 旁边的箭头，选择 **安装第三方插件**。从 GitHub 安装请填写：

```text
github:Zbcc0826/better-dsh
```

本地克隆也可以填这个仓库的绝对路径。安装完成后选择 **立即启用**。卡片会出现在 **实验性插件** 下面的 **已安装插件**，标题是「更好的 DSH」，右侧带开关。

### 2. 命令行安装

```sh
dsh plugin --profile <profile> add github:Zbcc0826/better-dsh
```

这里的 `<profile>` 是命令行 profile 的名字，不是 `desktop`。`dsh plugin --profile desktop` 会被命令行拒绝；桌面端请用插件页或下面的 `node install.mjs`。

### 3. 仓库根目录脚本安装

```sh
node install.mjs
```

脚本会把仓库装进 `$DSH_HOME`（默认 `~/.dsh`）里已有的各个 profile 并打开开关，同时清理 `$DSH_HOME/cordis.patch.yml` 里的旧插入。用本地路径安装时，脚本还会把 `@deepseek-ai/dsh-tools` 放进 `.dsh-deps` 并链接到 `node_modules`（因为链接到仓库外的目录时，桌面应用不会改用自己包里的那一份）。`.dsh-deps` 和 `node_modules` 不要提交进仓库。

### 安装注意事项与卸载

- 装完后请重启正在运行的桌面应用。
- 不要把绝对路径写进 `$DSH_HOME/cordis.patch.yml`，那种插入不会出现在插件页，开关也关不掉。
- 不要同时再执行另一套 `dsh plugin add`：两套安装叠在一起会把工具登记两次。
- 卸载时先在插件页卡片上关闭开关（卸下 `dsh-friction-drive` 这一层），再卸载。

## 工作方式

### 摩擦记分与拦线

- 当前会话会记录正在使用的工具：失败、同参数重试，以及结果值里带截断标记的调用都会计分。
- 参数校验失败不计分。调用次数、截断和慢调用只在结果值里有对应标记时才计入。
- 过线后，下一次直接调用不执行，直接返回 `GATED` 和 `friction_status.card`。
- 卡片提供三个选项：**沉淀替代**、**继续一次**、**本会话暂停**。选「继续一次」只放行一次，执行完重新评估。请由用户决定，不要替用户点允许。
- `friction_pause` 只有用户点允许才暂停本会话的闸门，会话结束自动恢复。
- 提示线只在结果后加一句。审批卡不引用模型的概述。不要请用户回复「已授权」。

### 替代工具与审批规则

- 原工具的定义保持不变。只有摩擦过线并同意替代后，当前会话才会改走新工具。
- 没过线时直接造替代工具会得到 `BELOW_THRESHOLD`。
- 只有用户明确要求新工具时，才调用 `propose_tool_goal`：系统会先确认，不允许就什么都不记下；允许后再调用 `apply_tool_change`（第二次审批），同意后才安装，且原工具仍可调用。已经过线的工具不需要这张额外确认。
- 同意默认只影响当前会话。若提案中设置 `"persist": true` 并获同意，新工具会跨会话保留，以后会话可直接调用而不必再审批两次（新会话里的原工具仍可调用）。
- 替换工具第一次调用就报 `inactive context` 时，原工具立刻恢复可用。
- 没有审批界面时，审批会立刻返回未批准，不会安装也不会挂起（无审批界面的命令行会话不会自动改工具）。
- 新工具安装后还可以再改，改的是它自己的 schema、执行方式和说明。`friction_status` 的 `notes` 会写出原工具问题、新工具用法和 schema，并标明来源是 `voluntary`（用户主动要求）还是 `friction`（摩擦过线）。
- `restore_tool_definition` 可以撤回修改；没有更早版本时，新工具会卸掉，原工具重新可以调用。

### 提案字段与限制

- `name`：可保留 `plugin_check` 这类语义名，不要指望变成 `fd_bash_时间`。
- `problem` 和 `usage`：各自最多 200 字。
- `schema`：支持简写对象（如 `{ "dir": { "type": "string", "required": true, "description": "目录" } }`）以及带 `properties` 和 `required` 的 JSON Schema 两种写法。可选字段不要写 `required: false`。
- 参数处理：没传的可选字段会变成空字符串；只有必填字段缺失才报缺少参数；schema 里没有的参数名会直接报未知参数，不会当成没传。
- `run`：可以是脚本（`{ "kind": "script", "command": "node --check ${dir}" }` 或命令字符串）或委派（`{ "kind": "delegate", "tool": "原工具名", "overrides": {} }`）。脚本最长 4000 字。
- 模板替换与环境变量：`${dir}` 和 `{{dir}}` 会换成带 shell 单引号的值，模板不要再加引号；`$dir` 和 `FD_ARGS` 指向的 JSON 文件里是去掉 shell 引号后的原值。
- 补丁与指标约束：`metric` 只能是 `projected_calls`；补丁键必须和 `patchKeys` 一致；预计调用次数没有下降就会拒绝；补丁里写 `confirmed` 没有用。

### 程序沉淀（`ec_` 工具）

- 同一段外部工具连续成功时，`friction_status.compilable` 只保留互不重叠的最长片段。
- 调用 `propose_compiled_procedure` 前先看候选 `asset_id`。审批前不会执行原工具或脚本。
- 同意后会在当前会话安装一个 `ec_` 工具。后续第一步的工具名和常量匹配时，直接调用会改走这个 `ec_` 工具。槽位只在被校验的两次绑定上有参照。没有审批界面时不会安装。

### 复杂任务的找茬再实现

- 复杂任务可以另行征求同意，走找茬再实现流程；简单查询不会自动进入。
- 同意后先记录问题，再写每条修改的次生影响。`friction_status.quality.ready` 为真之后才动手。
- 这个流程不代替上面的工具或程序审批。

## 包含的插件与工具

- **`dsh-friction-drive`**：只注册这 10 个工具：`friction_status`、`friction_choose`、`friction_pause`、`propose_quality_loop`、`record_quality_critique`、`record_quality_plan`、`propose_tool_goal`、`apply_tool_change`、`restore_tool_definition`、`propose_compiled_procedure`。
- **`dsh-friction-demo`**：同一个 bundle 还会装上这个示例包，注册 3 个示例工具：`ledger_lookup`、`fx_convert`、`window_overlap`。它们只是示例，不是账本产品；修改时仍按各自登记的字段调整，并继续使用原来的名字。

## 会话状态与密钥

- 会话状态保存在 `$DSH_HOME/friction-drive/sessions/<会话 id>/`。
- 不要把 API 密钥写进仓库。命令行示例 `./run-dsh.sh` 只从环境变量 `DEEPSEEK_API_KEY` 或仓库内被忽略的 `.deepseek-key` 读取。

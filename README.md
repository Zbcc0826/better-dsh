# Better DSH

DeepSeek Harness plugin for human-approved runtime tool repair and self-improvement. Shaped by real feedback from DeepSeek models running in DSH.

When a tool fails, retries the same arguments, or keeps returning a truncated result, the next direct call waits for approval. After you allow it, the plugin can add a session-local replacement tool or a compiled procedure. The original tool definition stays unchanged. Full English guide: [README.en.md](README.en.md).

# 更好的 DSH

行为来自 Agent 自己的使用体验，并按 DeepSeek 模型在 DSH 中运行时的真实反馈继续改。替代工具或沉淀程序在执行前征求同意。可能增加 token 消耗。

这是两个本地插件，不需要发布到 npm。克隆后在你自己的机器上运行安装脚本即可。桌面应用和命令行共用一份配置。包名仍是 `dsh-friction-drive`。

## 环境

- DeepSeek Harness `0.2.2-rc.3` 或更高，且低于 `0.3.0`
- 已能启动 `dsh` 或桌面应用
- 桌面应用自带安装插件用的 pnpm，不必再装一个

## 安装

打开 **插件**，点 **添加插件** 旁边的箭头，选择 **安装第三方插件**。本地克隆填这个仓库的绝对路径；从 GitHub 安装则填：

```text
github:Zbcc0826/better-dsh
```

安装结束后选择 **立即启用**。卡片出现在 **实验性插件** 下面的 **已安装插件**，标题是「更好的 DSH」，右侧是开关。关掉开关会卸下 `dsh-friction-drive` 这一层，不再加载。

也可以在仓库目录运行：

```sh
node install.mjs
```

脚本装进 `DSH_HOME`（默认 `~/.dsh`）里已有的各个 profile，并打开开关。桌面端的 profile 不能用 `dsh plugin --profile desktop`，所以脚本直接改那个目录。装完后重启正在运行的桌面应用。用本地路径安装时，脚本还会把 `@deepseek-ai/dsh-tools` 放进 `.dsh-deps`，因为链接到仓库外的目录时，桌面应用不会改用自己包里的那一份。`.dsh-deps` 和 `node_modules` 不要提交。

卸掉时在这张卡片上关闭开关，再卸载。不要把绝对路径写进 `$DSH_HOME/cordis.patch.yml`，那种插法不会出现在插件页，开关也关不掉。

## 会得到什么

装上之后，当前会话里正在使用的工具都会被记账。某个工具失败、同参数重试，或结果值带有截断标记，分数过线后，下一次直接调用会被拦住。没过线时不能直接造替代工具。你如果明确要求新工具，会先看到一张确认；不允许就什么都不会记下。允许之后还要再同意一次才会装上，原工具仍然可以调用。只有摩擦过线并同意替代时，这个会话才会改走新工具。名字可以保留提案里的语义，例如 `plugin_check`。命令写成 `node --check ${dir}`。`${dir}` 会换成带 shell 单引号的参数，模板不要再加引号。参数 JSON 写到环境变量 `FD_ARGS` 指向的文件。`friction_status` 的 `notes` 会写上原工具的问题、新工具的用法和 schema，并标明这是用户主动要求（voluntary）还是摩擦过线（friction）。原工具的定义不动。这个新工具之后还可以再改，改的是它自己的 schema、执行方式和说明。

同一段调用反复成功时，插件会把互不重叠的最长片段放进 `friction_status.compilable`。模型可以调用 `propose_compiled_procedure` 提议沉淀。审批前不会执行原工具或脚本。你同意后，当前会话安装一个 `ec_` 工具；第一步的工具名和常量再次被直接调用时，会改走这个工具。槽位只在被校验的那两次绑定上有参照。没有审批界面时不会安装。

示例工具 `ledger_lookup`、`fx_convert`、`window_overlap` 仍然按各自登记的字段修改，并继续使用原来的名字。没有审批界面的命令行会话不会自动改工具。

复杂任务可以另行征求同意，使用找茬再实现。简单查询不会自动进入这个流程。同意后先记下问题，再写每条修改的次生影响。`friction_status.quality.ready` 为真之后才动手。这个流程不代替上面的审批。

## 密钥

不要把 API 密钥写进仓库。命令行示例 `./run-dsh.sh` 只从环境变量 `DEEPSEEK_API_KEY` 或仓库内被忽略的 `.deepseek-key` 读取。

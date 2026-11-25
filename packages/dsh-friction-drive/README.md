# dsh-friction-drive

按会话记录正在使用的工具。摩擦没过线时，直接造替代工具会得到 `BELOW_THRESHOLD`。用户明确要求时，先弹出确认，允许后才记录提案，装上还要再同意一次。已登记示例按公式改自身字段，并且预计调用次数必须下降。过线并同意后，这个会话才改走新工具。

某个工具过线后，下一次直接调用被拦住。`apply_tool_change` 走一次性审批。没有审批界面时立刻返回未批准。同意只影响当前会话。`restore_tool_definition` 可以撤回。

安装不需要 pnpm。在仓库根目录运行 `node install.mjs`。脚本把本机路径写入 `$DSH_HOME/cordis.patch.yml`，因此桌面应用和普通 profile 都会加载。`dsh plugin --profile desktop add` 会被命令行拒绝，不要用那条命令。

不要同时再执行 `dsh plugin add`。两套安装叠在一起会把工具登记两次。

状态写在 `$DSH_HOME/friction-drive/sessions/<会话 id>/`。同意一次只改这个会话的 `catalog.json`。没有审批界面时，`apply_tool_change` 立刻返回未批准。

正在使用的工具不需要事先登记。主动提案写 `name`、`problem`、`usage`、`schema`、`run`。名字可以保留 `plugin_check`。已经用 `ctx.friction.register` 登记的工具仍按自己的公式和字段修改，并继续使用原名。

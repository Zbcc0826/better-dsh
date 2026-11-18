# dsh-friction-drive

按会话记录正在使用的工具。已登记示例按公式改自身字段。其他工具过线后，批准的改法是 `defaults` 和 `overrides`：插件新增 `fix_工具名`，套用这些参数后再调用原工具。Harness 不允许改写原调用的参数。

某个工具过线后，下一次直接调用被拦住。`apply_tool_change` 走一次性审批。没有审批界面时立刻返回未批准。同意只影响当前会话。`restore_tool_definition` 可以撤回。

安装不需要 pnpm。在仓库根目录运行 `node install.mjs`。脚本把本机路径写入 `$DSH_HOME/cordis.patch.yml`，因此桌面应用和普通 profile 都会加载。`dsh plugin --profile desktop add` 会被命令行拒绝，不要用那条命令。

不要同时再执行 `dsh plugin add`。两套安装叠在一起会把工具登记两次。

状态写在 `$DSH_HOME/friction-drive/sessions/<会话 id>/`。同意一次只改这个会话的 `catalog.json`。没有审批界面时，`apply_tool_change` 立刻返回未批准。

正在使用的工具不需要事先登记。过线后的补丁只能包含 `defaults` 和 `overrides`。同意后调用 `fix_工具名`。已经用 `ctx.friction.register` 登记的工具仍按自己的公式和字段修改，并继续使用原名。

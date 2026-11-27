# dsh-friction-demo

这个包与 `dsh-friction-drive` 在同一个 bundle 里一起安装，提供 3 个用于演示摩擦记分和字段调整的示例工具：`ledger_lookup`、`fx_convert`、`window_overlap`。它们只是示例工具，不是账本产品。

- `ledger_lookup`：分页查询示例，其中 `tag` 会先过滤再分页。
- `fx_convert`：逐笔换算示例。
- `window_overlap`：中文时间窗判断示例。

工具的初始定义写在插件的 `register` 种子里。运行并同意修改后的定义保存在 `$DSH_HOME/friction-drive/sessions/<会话 id>/catalog.json`，只属于那个会话，不会影响其他会话，也不会修改这个包里的源码。

这些示例故意留了使用障碍。没有审批界面的命令行会话在摩擦过线后会停住，因为补丁不会被自动批准。

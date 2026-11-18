# dsh-friction-demo

给 `dsh-friction-drive` 用的示例：分页账本、逐笔换算、中文时间窗。`tag` 会先过滤再分页。

工具的初始定义写在插件的 `register` 种子里。运行后的定义在 `$DSH_HOME/friction-drive/sessions/<会话 id>/catalog.json`，只属于那个会话。批准不会改其他会话，也不会改这个包里的源码。

这是故意留了障碍的示例。没有审批界面的命令行会话会在过线后停住，因为补丁不会被自动批准。

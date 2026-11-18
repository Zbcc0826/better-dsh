# 摩擦驱动

本插件将提供给你的Agent主动改造工具的动机，这些额外的行为发生自Agent自身的工作体验和质量需求，但仍会征求用户的同意。可能会发生额外的token费用，请注意API余额消耗。

这是两个本地插件，不需要发布到 npm。克隆后在你自己的机器上运行安装脚本即可。桌面应用和命令行共用一份配置。

## 环境

- DeepSeek Harness `0.2.2-rc.3` 或更高，且低于 `0.3.0`
- 已能启动 `dsh` 或桌面应用
- 不需要 pnpm。命令行拒绝管理名为 `desktop` 的 profile，安装脚本改的是 `$DSH_HOME/cordis.patch.yml`

## 安装

```sh
git clone <这个仓库>
cd <仓库目录>
node install.mjs
```

默认写入 `~/.dsh`，也就是桌面应用平时使用的目录。如果你用单独的 `DSH_HOME`，先导出它再运行脚本。脚本会把**本机仓库路径**写进该目录，并去掉各个 profile 里重复的安装，避免工具登记两次。桌面应用从仓库外的文件加载插件时，不会沿用应用自己的依赖目录，所以脚本还会用 npm 把 `@deepseek-ai/dsh-tools` 装进仓库下的 `.dsh-deps`，并链接为 `node_modules`。这一步需要能访问 npm。`.dsh-deps` 和 `node_modules` 不要提交。

改完后重启正在运行的桌面应用。

卸掉时，删除 `$DSH_HOME/cordis.patch.yml` 里 `friction-drive` 和 `friction-demo` 两条。

## 会得到什么

装上之后，当前会话里正在使用的工具都会被记账。某个工具失败、同参数重试，或结果值带有截断标记，分数过线后，下一次直接调用会被拦住。你同意后，插件增加一个只在这个会话出现的工具。`friction_status` 的 `notes` 会写上原工具的问题、新工具的用法和 schema。原工具的定义不动。这个新工具之后还可以再改，改的是它自己的 schema、执行方式和说明。

示例工具 `ledger_lookup`、`fx_convert`、`window_overlap` 仍然按各自登记的字段修改，并继续使用原来的名字。没有审批界面的命令行会话不会自动改工具。

## 密钥

不要把 API 密钥写进仓库。命令行示例 `./run-dsh.sh` 只从环境变量 `DEEPSEEK_API_KEY` 或仓库内被忽略的 `.deepseek-key` 读取。

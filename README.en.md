# Experience Compiler

Behavior comes from the agent's own experience using tools. Replacement tools and compiled procedures ask for approval before they run. This can spend extra tokens.

These are two local plugins and are not published to npm. Clone the repo and run the install script on your machine. The desktop app and the CLI share one configuration. The package name stays `dsh-friction-drive`.

## Requirements

- DeepSeek Harness `0.2.2-rc.3` or newer, and below `0.3.0`
- A working `dsh` CLI or desktop app
- The desktop app already includes the pnpm used to install plugins

## Install

Open **Plugins**, click the arrow next to **Add plugin**, and choose **Install a third-party plugin**. For a local clone, enter this repo's absolute path. From GitHub, enter:

```text
github:Zbcc0826/dsh-friction-drive
```

Choose **Enable now** when installation finishes. The card appears under **Installed** in **Experimental**, titled Experience Compiler, with a switch on the right. Turning the switch off unloads the `dsh-friction-drive` bundle.

You can also run this in the repo:

```sh
node install.mjs
```

The script installs into every existing profile under `DSH_HOME` (default `~/.dsh`) and turns the switch on. The desktop profile cannot be managed with `dsh plugin --profile desktop`, so the script edits that directory directly. Restart a running desktop app afterward. A local-path install also vendors `@deepseek-ai/dsh-tools` into `.dsh-deps`, because a directory outside the repo will not fall back to the copy inside the app. Do not commit `.dsh-deps` or `node_modules`.

To remove it, turn the card off, then uninstall. Do not write an absolute path into `$DSH_HOME/cordis.patch.yml`. That insert does not show up on the plugin page and the switch cannot turn it off.

## What you get

After installation, tools used in the current session are recorded. When a tool fails, retries the same arguments, or returns a truncated result often enough, the next direct call is blocked. After you allow it, the plugin adds a tool that exists only in this session. `friction_status` `notes` describe the original problem, the new usage, and the schema. The original tool definition is unchanged. That new tool can be revised later; the revision changes its own schema, execution, and description.

When the same sequence succeeds repeatedly, the plugin puts the longest non-overlapping fragments in `friction_status.compilable`. The model may call `propose_compiled_procedure`. Nothing runs the original tool or a script before approval. After you allow it, this session gains an `ec_` tool. A later direct call is redirected only when the first step's tool name and constants match. Slots are checked only against the two validated bindings. A session with no approval UI does not install the tool.

The sample tools `ledger_lookup`, `fx_convert`, and `window_overlap` still change through their registered fields and keep their original names. A CLI session without an approval UI does not change tools on its own.

## Keys

Do not commit API keys. The sample `./run-dsh.sh` reads `DEEPSEEK_API_KEY` or the ignored `.deepseek-key` file.

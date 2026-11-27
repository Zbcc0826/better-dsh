# Better DSH

This is a local DeepSeek Harness (DSH) plugin whose package name is `dsh-friction-drive` and GitHub repository is `Zbcc0826/better-dsh`. It is not `pgmi-builds/better-dsh`: it does not provide an IPython REPL and does not replace DSH's coding capabilities.

The plugin is not published to npm; clone it and install locally. The desktop app and the CLI share one configuration. Behavior comes from the agent's own experience using tools and evolves with real feedback from DeepSeek models running in DSH. Replacement tools, compiled procedures, and the critique-then-implement loop for complex tasks all ask for user approval before running, which can spend extra tokens.

## Requirements

- DeepSeek Harness `0.2.2-rc.3` or newer, and below `0.3.0`
- A working `dsh` CLI or desktop app
- The desktop app already includes the pnpm used to install plugins

## Install and Uninstall

Pick one of the three methods below. Do not stack two installs together.

### 1. Desktop Plugins Page

Open **Plugins**, click the arrow next to **Add plugin**, and choose **Install a third-party plugin**. From GitHub, enter:

```text
github:Zbcc0826/better-dsh
```

For a local clone, you can enter this repository's absolute path. Choose **Enable now** when installation finishes. The card appears under **Installed** in **Experimental**, titled Better DSH, with a switch on the right.

### 2. CLI

```sh
dsh plugin --profile <profile> add github:Zbcc0826/better-dsh
```

Here `<profile>` is a CLI profile name, not `desktop`. `dsh plugin --profile desktop` is rejected; manage the desktop profile through the Plugins page or `node install.mjs` below.

### 3. Install Script at Repo Root

```sh
node install.mjs
```

The script installs the bundle into every existing profile under `$DSH_HOME` (default `~/.dsh`), turns the switch on, and removes old inserts from `$DSH_HOME/cordis.patch.yml`. A local-path install also vendors `@deepseek-ai/dsh-tools` into `.dsh-deps` and links `node_modules` (because a directory outside the repo will not fall back to the copy inside the app). Do not commit `.dsh-deps` or `node_modules`.

### Notes and Uninstall

- Restart any running desktop app after installing.
- Do not write an absolute path into `$DSH_HOME/cordis.patch.yml`. That insert does not show up on the Plugins page and cannot be turned off with the switch.
- Do not run another `dsh plugin add` alongside it; stacking two installs registers tools twice.
- To remove it, turn the switch off on the plugin card (unloading `dsh-friction-drive`), then uninstall.

## How It Works

### Friction Tracking and Gating

- The current session records tool failures, same-argument retries, and calls whose result value carries a truncation marker.
- Argument validation failures do not add to the score. Call count, truncation, and slow calls are only counted when the result value contains the corresponding marker.
- Once the threshold is crossed, the next direct call does not run and returns `GATED` along with `friction_status.card`.
- The card offers three choices: build a replacement tool, continue once, or pause this session. Continuing once allows one execution only, then re-evaluates. Do not click Allow on the user's behalf.
- `friction_pause` pauses the gate for the current session only after the user clicks Allow, and automatically resumes when the session ends.
- Hint lines add only one sentence after the result. Approval cards do not quote the model's summary. Do not ask the user to reply "已授权" (authorized).

### Replacement Tools and Approval Rules

- Original tool definitions stay unchanged. The current session switches to a new tool only after friction crosses the threshold and the user approves the replacement.
- Trying to create a replacement tool directly before crossing the threshold returns `BELOW_THRESHOLD`.
- Call `propose_tool_goal` only when the user explicitly asks for a new tool: it confirms first, and records nothing if declined. After confirmation, `apply_tool_change` triggers a second approval before installation, while the original tool stays callable. Already-gated tools do not need this extra confirmation.
- Approval affects only the current session by default. If `"persist": true` is set in the proposal and approved, the tool persists across later sessions and can be called without repeating the two approvals (the original tool stays callable in new sessions).
- If a replacement tool reports `inactive context` on its first call, the original tool immediately becomes usable again.
- When there is no approval UI, approval immediately returns unapproved—nothing is installed and nothing hangs (so a CLI session without an approval UI does not modify tools).
- Installed new tools can be revised later (changing their own schema, execution, and description). `friction_status` `notes` record the original tool's problem, the new usage and schema, and mark each as `voluntary` or `friction`.
- `restore_tool_definition` can undo changes; when no earlier version exists, the new tool is uninstalled and the original tool becomes callable again.

### Proposal Fields and Constraints

- `name`: semantic names such as `plugin_check` are kept; do not expect renaming to `fd_bash_<time>`.
- `problem` and `usage`: max 200 characters each.
- `schema`: supports both the shorthand object format (`{ "dir": { "type": "string", "required": true, "description": "..." } }`) and JSON Schema with `properties` and `required`. Do not write `required: false` on optional fields.
- Argument handling: omitted optional fields become an empty string; only missing required fields report missing arguments; unknown argument names not in the schema are rejected as unknown arguments instead of treated as omitted.
- `run`: can be a script (`{ "kind": "script", "command": "node --check ${dir}" }` or a command string) or a delegate (`{ "kind": "delegate", "tool": "<original-tool>", "overrides": {} }`). Max script length is 4000 characters.
- Templates and environment variables: `${dir}` and `{{dir}}` are replaced with shell single-quoted values, so do not add quotes around them in the template; `$dir` and the JSON file pointed to by `FD_ARGS` contain the raw unquoted values.
- Patch and metric rules: `metric` can only be `projected_calls`; patch keys must match `patchKeys`; patches that do not reduce projected calls are rejected; putting `confirmed` in the patch has no effect.

### Compiled Procedures (`ec_` Tools)

- When the same sequence of external tools succeeds repeatedly, `friction_status.compilable` keeps only the longest non-overlapping fragments.
- Check candidate `asset_id` values before calling `propose_compiled_procedure`. Nothing runs the original tool or script before approval.
- After approval, an `ec_` tool is installed in the current session. Future direct calls whose first-step tool name and constants match are routed to `ec_`. Slots are checked only against the two validated bindings. Nothing is installed when there is no approval UI.

### Critique-then-Implement for Complex Tasks

- Complex tasks can separately ask for approval to run a critique-then-implement loop; simple lookups do not enter it automatically.
- After approval, defects are recorded first, followed by secondary effects for each planned change. Implementation starts only after `friction_status.quality.ready` is true.
- This loop does not replace the tool or procedure approvals above.

## Included Packages and Tools

- **`dsh-friction-drive`**: registers only these 10 tools: `friction_status`, `friction_choose`, `friction_pause`, `propose_quality_loop`, `record_quality_critique`, `record_quality_plan`, `propose_tool_goal`, `apply_tool_change`, `restore_tool_definition`, `propose_compiled_procedure`.
- **`dsh-friction-demo`**: installed by the same bundle, registering 3 sample tools: `ledger_lookup`, `fx_convert`, `window_overlap`. These are sample tools only, not a ledger product; they change through their own registered fields and keep their original names.

## Session State and Keys

- Session state is stored under `$DSH_HOME/friction-drive/sessions/<session-id>/`.
- Do not commit API keys. The sample `./run-dsh.sh` reads `DEEPSEEK_API_KEY` or the gitignored `.deepseek-key` file.

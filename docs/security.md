# Security model

Sutra runs a language model that proposes actions on your machine. This page explains what Sutra enforces, what it does not, and why.

## Two layers: approvals and the OS sandbox

**Layer 1 — the approval gate.** Before any tool runs, the harness (not the model) decides whether to allow it, ask you, or refuse it. This decides *whether* something runs.

**Layer 2 — the OS sandbox.** Shell commands and test runs (`execute_command`, `run_tests`, and benchmark verification) run inside an operating-system sandbox. This limits *what an approved command can do*, which matters because a command that looks harmless, like `npm test`, runs whatever the project's scripts contain.

| | Approval gate | OS sandbox (on by default where available) |
| --- | --- | --- |
| Model writes outside the workspace via file tools | blocked or asks | — |
| An approved command writes outside the workspace | — | **blocked** (except temp dirs and package-manager caches) |
| An approved command reads `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.sutra`, `~/.docker`, `~/.kube`, `.npmrc`, `.netrc`, `.git-credentials`, keychains | — | **blocked** |
| An approved command opens an outbound connection | asks first for known network commands | **blocked** unless the command was approved as a network command; loopback is always allowed |
| An approved command reads the rest of your files | — | allowed (read-only access to the system is needed for toolchains to work) |

### How the sandbox works

- **macOS — Seatbelt.** Each command runs as `sandbox-exec -p <profile> /bin/sh -c <command>`. The profile starts from `(allow default)`, then denies all file writes except the workspace, temp directories (`$TMPDIR`, `/tmp`, `/private/var/folders`), package-manager caches (`~/.npm`, `~/.cache`, `~/.yarn`, `~/.bun`, `~/.pnpm-store`, `~/Library/Caches`, `~/Library/pnpm`, `~/.cargo/registry`, `~/go/pkg/mod`) and any `sandbox.allowWrite` paths. It denies reads and writes of the credential stores listed above, and denies outbound IP traffic except to `localhost`. `sandbox-exec` is deprecated by Apple but still ships with, and works on, current macOS.
- **Linux — bubblewrap.** When `bwrap` is installed, each command runs with a read-only bind of `/`, writable binds for the same allowed directories, the credential stores masked (`--tmpfs` for directories, `/dev/null` for files), and `--unshare-net` (a private network namespace with only loopback) unless network is allowed.
- **Network per command.** When you approve a command that the classifier marks as needing the network (for example `npm install` or `git fetch`), that one run gets network access. `sandbox.network: true` allows network for every command.
- **Modes.** `sandbox.mode` / `--sandbox`: `auto` (default) uses the sandbox when it works on this machine and says clearly when it doesn't; `required` refuses to run any command without it; `off` disables it. Sutra checks the backend works by running a trivial sandboxed command at startup.

### What was verified

On macOS (26, Apple Silicon), an automated test suite (`tests/integration/sandbox.test.ts`) runs real commands under the generated profile and checks that:

- commands work inside the workspace, and `npm test`, `node --test` and `git` run normally;
- writing a file outside the workspace fails with "Operation not permitted", and no file is created;
- `~/.ssh` cannot be listed;
- an outbound TCP connection fails with `EPERM`, while a loopback client/server still works.


It was also checked by hand that, with network allowed for an approved network command, the same outbound connection succeeds; that case isn't automated, because it needs internet access.

The bubblewrap backend has unit tests for the arguments it generates but **has not been run on Linux yet**. There is no Windows backend.

### What the sandbox does not do

- It runs under your user account. It is not a VM or container, and processes can still read most of your files and use local services (anything on `localhost`).
- It does not limit CPU, memory or process count. The command timeout still applies.
- File tools (`write_file`, `edit_file`, `apply_patch`) run inside Sutra itself and are governed by the approval gate and workspace checks, not by the sandbox.
- If the sandbox can't be applied (for example Sutra is already running inside another sandbox), `auto` mode falls back to approvals only and shows a notice. Use `required` if that's unacceptable.

## MCP servers

MCP tools are external code and remote services, so Sutra does not pretend to classify them.

- **User config only.** `mcpServers` can only be set in `~/.sutra/config.json`. A repository's `.sutra/config.json` cannot add a server or a tool. This prevents a cloned repository from launching a process or exfiltrating data through a server you did not choose.
- **Always ask.** A remote tool may read files, write data, run code or send information anywhere. Every MCP call is category `mcp`: `inspect` does not start servers and hides the tools, `confirm` and `flow` always ask, plan mode refuses them, and non-interactive runs neither start servers nor approve calls. There is deliberately no session-wide grant.
- **Approval shows the call.** The card names the server and remote tool and previews the arguments (redacted), because the effects are controlled by the server, not by Sutra.
- **stdio servers are not sandboxed.** They run as a normal child process under your account, outside the command sandbox. Configure only servers you trust. They receive `PATH`, `HOME`, `USER`, `SHELL`, `TERM` and `LOGNAME`, plus only the `env` entries and `inheritEnv` names you specify; your shell's API keys are not passed through.
- **Secrets are redacted.** Server `env`, inherited values and HTTP header values are added to the session redactor. Tool output, the UI, invocation logs and stored results pass through it.
- **Tool results are data.** An MCP server can return text that looks like instructions. The system prompt already tells the model to treat tool output as data; the permission engine remains outside the model's reach.
- **HTTP headers.** Bearer tokens and other auth belongs in `headers` in user config (mode 600). Sutra does not currently implement MCP OAuth flows.

The same limitations as ordinary tools apply: an MCP server can return wrong or hostile content, and the model may send it any arguments you approved. Review the preview before approving a call whose arguments contain source code or credentials.

## Threats and mitigations

**Path traversal and symlink escapes.** File-tool paths are resolved against the workspace and canonicalised with `realpath`. For paths that don't exist yet, the nearest existing ancestor is canonicalised. Containment is then checked with `path.relative`, not with string prefixes. A symlink inside the workspace that points outside it resolves outside, and is treated that way. The directory walker does not follow symlinked directories.

**Prompt injection through repository content.** File contents, tool output and `AGENTS.md` files are data. The system prompt tells the model to treat embedded instructions as data and to report them. More importantly, nothing the model reads can change the permission policy, which lives in harness code. Repository `.sutra/config.json` is restricted to non-security keys and can only add restrictions. It cannot set the profile, allowlists, API endpoint or keys. Sutra does not auto-load a workspace `.env`, because a hostile repository could otherwise set `DEEPSEEK_BASE_URL` and capture your key.

**Accidental destructive operations.** Commands are split on `;`, `&&`, `||`, `|` and `&` (quote-aware), and substitutions and redirections are detected. Each segment is classified as `routine`, `unknown`, `network`, `destructive` or `privileged`. Only `routine` commands are auto-approved, and only in `flow`. Destructive, network, privileged and out-of-workspace actions always ask, and "allow for this session" is never offered for them. File deletion through `apply_patch` always asks. Writes into `.git/` are refused. `git_status` and `git_diff` run without a shell, with argument validation (refs may not start with `-`). Sutra never pushes, publishes or deploys on its own. Those commands are classified as destructive or network and need your approval.

**Silent overwrites.** Sutra records a hash of each file when it reads or writes it. Writing to an existing file fails if the agent never read it, or if its content changed since then. Multi-file patches are checked in full before anything is written.

**Secret leakage.**
- API keys are read from the environment or `~/.sutra/credentials.json` (mode 600). They are never printed. `sutra init` reads the key with hidden input.
- Subprocesses get an environment with secret-looking variables removed (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, …). You can turn this off with `tools.scrubEnv: false`.
- Tool output is redacted before it reaches the model, the UI or the database: the configured API key, `sk-…` key shapes and PEM private keys.
- Reading `.env`, key files, `.npmrc`, `.aws/credentials` and similar files asks for approval in `confirm` and `flow`, and is refused in `inspect`.
- The debug log redacts key and reasoning fields. Reasoning content is never logged or displayed. It is stored only in the local database, because DeepSeek requires it to resume tool-using conversations.

**Unapproved external data transfer.** Network-capable commands (`curl`, `wget`, `ssh`, `git push/fetch/clone`, package installs, `gh`, …) are classified as network and always ask. Sutra has no built-in tool that sends data anywhere except to the configured model provider, and the OS sandbox blocks outbound connections from commands that weren't approved as network commands. Note that the model provider receives the content of files the agent reads.

**Unbounded subprocesses.** Each command runs in its own process group with a timeout (default 120 s, capped at 30 min). On timeout or cancellation, the whole group gets SIGTERM, then SIGKILL two seconds later. Captured output is bounded in memory (head and tail), bounded again before it reaches the model, and written in full to `~/.sutra/logs/tools/<session>/` when `tools.retainFullLogs` is on. Commands get no stdin.

**Runaway agents.** Per-turn limits on iterations and tool calls, a per-session spend budget, and repeated-call loop detection all stop a turn with an explicit status.

## Known gaps

- The sandbox is only tested on macOS, and does not exist on Windows (see above).
- Command classification is heuristic and conservative. Unknown programs always ask, but a routine-looking command such as `npm test` executes project code.
- Approvals are per action. The `flow` profile trusts routine workspace edits by design.
- MCP servers are not sandboxed, and their tools cannot be classified by the harness. Every call asks; non-interactive runs cannot use them.
- Sutra cannot prevent the provider from seeing what the agent reads. Use `inspect` and your own judgement for confidential code.

Report vulnerabilities privately to the maintainers (see CONTRIBUTING.md), not in public issues.

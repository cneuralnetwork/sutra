<p align="center">
  <img src="assets/github-banner.svg" alt="Sutra — the thread that connects intelligence to action" width="100%">
</p>

<p align="center">
  <strong>An open-source AI coding agent for your terminal.</strong><br>
  It reads your code, makes the change, runs your tests, and tells you exactly what it did.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-F5B84B?style=flat-square&labelColor=101923"></a>
  <img alt="Node.js 22.13+" src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-52B788?style=flat-square&labelColor=101923">
  <img alt="Status: early preview" src="https://img.shields.io/badge/status-early%20preview-6CA8E8?style=flat-square&labelColor=101923">
  <img alt="Models: DeepSeek, OpenRouter, 20+ providers, local" src="https://img.shields.io/badge/models-DeepSeek%20%C2%B7%20OpenRouter%20%C2%B7%2020%2B%20providers%20%C2%B7%20local-9CAABA?style=flat-square&labelColor=101923">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#using-sutra">Using Sutra</a> ·
  <a href="#staying-in-control">Permissions & sandbox</a> ·
  <a href="#cost-and-budgets">Cost</a> ·
  <a href="#verified-not-just-finished">Verification</a> ·
  <a href="#audit-and-replay">Audit</a> ·
  <a href="#benchmarks">Benchmarks</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/">Docs</a>
</p>

```bash
git clone https://github.com/cneuralnetwork/sutra.git && cd sutra && npm install && npm link
sutra init     # pick a provider, paste a key, choose a model
sutra          # start in any project
```

<p align="center"><sub>Node.js 22.13+ on macOS or Linux · works with DeepSeek, OpenRouter, OpenAI, Anthropic, Gemini, Groq and 15 more, or local models through Ollama and LM Studio</sub></p>

---

**Sutra** (सूत्र, Sanskrit for *thread* or *guiding principle*) is a coding agent that works in your terminal. You describe a task. Sutra explores the repository, plans, edits files, runs your tests, and keeps going until the task is done, or until it needs you.

Three ideas shape it:

- **You can see everything.** Every file read, edit, command and test run appears on screen as it happens, is saved locally, and can be replayed or exported as an audit report afterwards.
- **You stay in charge.** Sutra itself decides what may run without asking, and on macOS and Linux every command also runs inside an OS sandbox. A clever prompt or a malicious file can't talk its way past either.
- **You know what it costs.** Token usage and estimated spend are tracked per request, a budget can pause the agent before it overspends, and a built-in benchmark measures cost per solved task.

Sutra works with [DeepSeek](https://api-docs.deepseek.com/), **[OpenRouter](https://openrouter.ai)** (hundreds of models behind one key), OpenAI, Anthropic, Google Gemini, xAI, Mistral, Groq, Cerebras, Together, Fireworks, DeepInfra, Moonshot, Z.ai, Qwen, SambaNova, Hugging Face and Vercel AI Gateway, with **local models** through Ollama, LM Studio, llama.cpp, vLLM or Jan (free and private), and with any other OpenAI-compatible server.

## See it work

A real bug in the bundled example (`examples/session-expiry`): a timestamp in seconds is compared with one in milliseconds, so every session looks expired.

```
› The session tests fail. Find and fix the bug.

Sutra  /  turn 1
│ Inspecting repository.
│
├─ ✓ read_file       src/session.js                              16 lines
├─ ✓ grep_search     expiresAt                                   8 matches
├─ ✓ run_tests       npm test                                exit 1 · 0.3s
│                    2 of 4 failed
│
│ Found an issue in token expiration handling: expiresAt is in seconds
│ but now is milliseconds.
│
╰─ ● edit_file       src/session.js                         waiting on you
╭────────────────────────────────────────────────────────────────────────╮
│  APPROVE   edit_file  src/session.js                             +1 −1 │
│ Reason   modify files                                                  │
│ ╭────────────────────────────────────────────────────────────────────╮ │
│ │ @@ -3,7 +3,7 @@                                                    │ │
│ │   6      −    return session.expiresAt < now;                      │ │
│ │       6  +    return session.expiresAt * 1000 <= now;              │ │
│ ╰────────────────────────────────────────────────────────────────────╯ │
│ Apply this action?   y  yes    a  allow edits this session    N  no    │
╰────────────────────────────────────────────────────────────────────────╯

├─ ✓ edit_file       src/session.js                     +1 −1 · approved
├─ ✓ run_tests       npm test                                exit 0 · 0.3s
│                    4 of 4 passed
│
│ Fixed isExpired in src/session.js. All 4 tests pass.
│
●
──────────────────────────────────────────────────────────────────────────
Sutra  /  Complete  ·  5 iterations · 5 tool calls · 9s

╭────────────────╮ ╭────────────────╮ ╭────────────────╮ ╭────────────────╮
│ FILES CHANGED  │ │ TESTS          │ │ TOKENS         │ │ ESTIMATED COST │
│ 1              │ │ ✓ passed       │ │ 7,500 in       │ │ $0.0016        │
│ src/session.js │ │ 4 of 4 passed  │ │ 600 out · 67%… │ │ session $0.00… │
╰────────────────╯ ╰────────────────╯ ╰────────────────╯ ╰────────────────╯
```

<sub>The layout is exactly what Sutra draws; the numbers are illustrative. In a real run, every line comes from an actual event: test counts are read from your test runner's output, and tokens and cost come from the provider's reported usage.</sub>

How to read it: each turn is one **thread**. Sutra's explanations sit on the `│` line, and every tool call hangs off it as a row showing the outcome (`✓` ok, `✗` error, `⊘` denied, `–` cancelled), the tool, its target, and a short result on the right. The thread ends in `●`, followed by a summary of what changed.

## Quick start

**1. Install.** You need Node.js 22.13 or newer (`node -v`), on macOS or Linux. `ripgrep` is optional and makes search faster.

```bash
git clone https://github.com/cneuralnetwork/sutra.git
cd sutra
npm install     # installs dependencies and builds Sutra
npm link        # puts the `sutra` command on your PATH
```

To update later, run `git pull && npm install` in the same folder.

**2. Connect a model.** Run the guided setup:

```bash
sutra init
```

```
  ? Model provider  type to filter
    RECOMMENDED
  ❯ DeepSeek              Fast, cheap and strong at code; Sutra's tuned default
    OpenRouter            Hundreds of models from every lab behind one key       key in $OPENROUTER_API_KEY
    CLOUD PROVIDERS
    OpenAI                GPT models on the OpenAI platform
    Anthropic             Claude models, through Anthropic's OpenAI-compatible endpoint
    …
    ON THIS MACHINE (NO KEY, PRIVATE)
    Ollama                Local models, private and free                         ● running · 4 models
```

Pick a provider (type to filter, arrow keys to move). Setup spots keys already in your environment and local model servers that are running. It checks a pasted key straight away and asks again if the provider rejects it. Then it lists the models the provider actually offers, with context size and price where published, and checks that the model you pick can really call a tool. The whole thing takes about a minute.

<details>
<summary>Skip the wizard: flags and environment variables</summary>


| Provider | How |
| --- | --- |
| **DeepSeek** (cloud) | `export DEEPSEEK_API_KEY=sk-...` — get a key from the [DeepSeek platform](https://platform.deepseek.com/api_keys) |
| **Ollama** (local, free) | `ollama pull qwen3-coder`, then `sutra --provider ollama` |
| **OpenRouter** and other clouds | `export OPENROUTER_API_KEY=...`, then `sutra --provider openrouter --model deepseek/deepseek-chat`. Likewise `anthropic` (`ANTHROPIC_API_KEY`), `gemini` (`GEMINI_API_KEY`), `groq`, `mistral`, `xai`, … ([all providers](docs/configuration.md#providers)) |
| **LM Studio, llama.cpp, vLLM, Jan** (local) | start the server, then `sutra --provider lmstudio` (or `llamacpp`, `vllm`, `jan`) |
| **Any other OpenAI-compatible server** | `export OPENAI_BASE_URL=http://localhost:8000/v1` (plus `OPENAI_API_KEY` if it needs one), then `sutra --provider openai-compatible --model <id>` |

</details>

> [!TIP]
> Ollama's default context window is small and it **silently cuts off** longer prompts. For coding work, start the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` (or more), and set `providers.ollama.contextWindow` to the same number. Smaller local models also handle multi-step tool use less reliably than large cloud models, and `sutra bench` will tell you how yours does.

**3. Give it a task.** In any project:

```bash
cd your-project
sutra "explain how this repository is organised"
```

Sutra asks before it changes a file or runs a command, so a first run is safe. To watch it fix a real bug, try the bundled example:

```bash
cd examples/session-expiry                 # inside the folder you cloned
npm test                                   # 2 of 4 tests fail
sutra "The session tests fail. Find and fix the bug."
```

Approve the edit when Sutra asks, watch it re-run the tests, and type `/cost` to see what the session cost. Exit with `/exit`, then come back to the same conversation:

```bash
sutra --resume "What did you change?"
```

> [!NOTE]
> Your API key is stored in `~/.sutra/credentials.json` with owner-only permissions (mode 600). It is never printed, never written inside a repository, and stripped from the environment of every command Sutra runs.

## Using Sutra

### Starting a session

| Command | What it does |
| --- | --- |
| `sutra` | Start an interactive session in the current directory |
| `sutra "explain this repository"` | Start a session with a first task |
| `sutra --resume` | Continue the most recent session in this directory |
| `sutra --session 3f2a9c1e` | Resume a specific session (an ID prefix is enough) |
| `sutra -p "summarise src/auth"` | Run once without the UI: the answer goes to stdout, activity to stderr |
| `sutra -p --json "…"` | Same, but print every runtime event as a JSON line |
| `sutra --readonly` | Look, don't touch: no edits, no commands |
| `sutra --provider openrouter` | Use another provider (`sutra init` lists them all) |
| `sutra replay` | Show the latest session here as a timeline |
| `sutra export --format md` | Write an audit report of a session |
| `sutra bench` | Run the benchmark tasks and report pass rate and cost |
| `sutra --model deepseek-v4-pro` | Pick a model for this session |
| `sutra --no-color` | Plain output (`NO_COLOR` also works) |
| `sutra --lang hi` | Hindi interface text |

### Inside a session

Type `/` to open the command palette. ↑↓ selects a command and Enter runs it. Commands marked **▾** (`/model`, `/permissions`, `/budget`, `/sessions`, `/resume`, `/plan`, `/export`) open a dropdown of real choices instead: the current value is pre-selected, typing narrows the list, and Enter applies the one you pick. You can also type a value directly, like `/budget 3.5` or `/model my-model-id`. Esc closes any list.

| Command | |
| --- | --- |
| `/help` | Commands and keyboard shortcuts |
| `/status` | Model, workspace, permission profile, context size, instruction files |
| `/cost` | Tokens, requests, tool calls, latency and estimated spend |
| `/budget 0.50` | Set a spend limit for this session (`/budget off` removes it) |
| `/plan <task>` | **Plan mode:** Sutra investigates read-only and proposes a plan; nothing is changed until you approve |
| `/plan go` | Approve the current plan and carry it out |
| `/plan` | Show the current plan and its progress |
| `/model [id]` | Show or switch the model |
| `/permissions [profile]` | Show or switch the permission profile |
| `/compact` | Summarise older context now, to save tokens |
| `/sessions` | Browse recent sessions in this directory and switch to one |
| `/resume <id>` | Switch to a saved session without restarting |
| `/export` | Save an audit report of this session (Markdown or JSON) |
| `/clear` | Start fresh (the old session stays saved) |
| `/exit` | Quit |

**Keys.** `Enter` sends. `⇧ Enter` adds a new line. `Esc` stops the current turn: running commands are killed and nothing is left half-recorded. `Ctrl+C` twice exits. `↑` `↓` browse your previous prompts. You can type while Sutra is working; your message is queued and sent when the turn finishes.

**Plan first, then act.** For bigger changes, start with `/plan add rate limiting to the API`. Sutra explores the code and records a step-by-step plan, and it can't modify anything while doing so: every write and command is refused by Sutra itself, not just discouraged. Review the plan, reply with changes if you want them, then `/plan go` to carry it out. Progress shows as ✓ / ◐ / ○ in the thread and in `/plan`.

## Staying in control

Sutra has three permission profiles. The default, **Confirm**, shows you every change before it happens.

| Profile | Reading files | Editing files | Running commands | MCP tools |
| --- | --- | --- | --- | --- |
| **Inspect** (`--readonly`) | Inside the workspace | Never | Never | Never (hidden) |
| **Confirm** (default) | Automatic | You approve each change, with a diff | You approve each command | You approve each call |
| **Flow** (`--profile flow`) | Automatic | Automatic inside the workspace | Automatic for routine checks like `npm test` or `git status`; anything else asks | You approve each call |

**Every profile still asks before:**

- deleting files
- touching anything outside the workspace, or sensitive files (`.env`, keys, credentials)
- destructive commands: `rm`, `git reset --hard`, `git push`, …
- network access: `curl`, package installs, `git fetch`, …
- `sudo`
- calling any MCP tool (never auto-approved)

Writes into `.git/`, and into any paths you mark as protected, are refused outright.

At an approval prompt, `y` allows the action once. `a` allows that kind of action for the rest of the session; it's only offered for routine actions, never for destructive ones. `n` or `Enter` declines. A declined action is reported back to the model, which has to find another way or ask you.

Because these rules live in Sutra's own code, nothing the model reads can change them: not a README, not a code comment, not a crafted test output. Repository instruction files can describe conventions, but they can't loosen permissions.

### The OS sandbox

Approvals decide *whether* a command runs. The sandbox limits *what it can do* once it does, because an approved "test" script can still run anything. On by default (`--sandbox auto`):

| | Inside the sandbox |
| --- | --- |
| **Writes** | Only the workspace, temp directories and package-manager caches (`~/.npm`, `~/.cache`, …) |
| **Credentials** | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.sutra`, `.npmrc`, `.netrc` and keychains can't be read |
| **Network** | Outbound traffic is blocked; localhost still works for test servers. A command you approve as a network command (like `npm install`) gets network for that run only |

- **macOS** uses the built-in Seatbelt sandbox (`sandbox-exec`). **Linux** uses [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) when it's installed.
- The welcome screen and `/status` show whether the sandbox is active. If none is available, Sutra says so and relies on approvals alone.
- Use `--sandbox required` to refuse to run commands without a sandbox, or `--sandbox off` to disable it.

> [!IMPORTANT]
> The sandbox is a strong second layer, not a guarantee. It runs commands under your user account with rules for writes, credential reads and the network; it is not a separate machine or container. Read commands before approving them. [docs/security.md](docs/security.md) explains exactly what is enforced, how it was tested, and its limits (the Linux backend is implemented but hasn't been tested on Linux yet).

## Verified, not just finished

Most agents treat "the model stopped calling tools" as "done". Sutra doesn't. When the model stops, a **finish gate** checks each acceptance criterion of your request against evidence recorded *after the last edit*, and labels anything without such evidence **unverified** instead of letting it pass as done:

```
Evidence  ● verified  ·  balanced mode · version 3f9a2c1 · sent back 1× · checks cost $0.0021
          ✓ The session tests pass                npm test → exit 0 (4/4 passed)
          ✓ No test files are modified             harness record: changed src/session.js; no test files changed
          ✓ Expired once the expiry time is reached  provisional test "expiry boundary" passes (provisional)
Review    aligned  "Makes isExpired compare expiresAt in seconds against now in milliseconds."
Probes    1 provisional test · 0 still failing
```

<sub>Layout of the evidence table; the rows are illustrative.</sub>

What happens around a turn (details in [docs/quality-engine.md](docs/quality-engine.md)):

1. **Evidence packet.** Before the model starts, Sutra points it at the likely code using paths and stack frames from your request, symbol definitions and references, failing test names, ranked search and dependency edges. For a bug, it also runs a **baseline** test, but only when that wouldn't bypass your approvals.
2. **Hypotheses, not guesses.** For hard bugs the model keeps up to three competing explanations and runs the cheapest check that tells them apart. If the same tests keep failing after edits, Sutra says so and asks for exactly that.
3. **Counterexamples.** An isolated verifier writes tests aimed at boundaries and edge cases. Sutra re-runs each one itself and only accepts real failures, and they're always marked **provisional**, never treated as the truth.
4. **Competing patches** (deep mode). If the fix still fails, independent attempts start from the original state of the code, each pursuing a different explanation and reusing what the failed attempt learned. The winner is chosen by deterministic rules: tests pass, no test was modified, smallest diff. It's applied through the normal approval-gated tools.
5. **Independent review.** A separate check infers what the patch does *without* seeing your request, then compares that with what you asked for. It can raise a gap, but never pass a criterion on its own.
6. **Finish gate.** Sutra enforces the evidence rules itself. Gaps go back to the model with specifics. What can't be verified is reported as unverified.

| `/quality` | What it adds | Typical extra cost |
| --- | --- | --- |
| `fast` | Evidence labels only; no extra model calls | none |
| `balanced` (default) | Packet, baseline, contract, gate, review; counterexamples only when a criterion lacks evidence | small (+32% on the bundled tasks) |
| `deep` | Plus a second probe round and competing patches when a fix fails | several times more |

On the bundled tasks with live DeepSeek, `balanced` solved 4/4 and its gate said "verified" on exactly those 4, for $0.0074 in total. In `deep` mode the verifier found a real boundary bug the project's tests didn't cover, and the agent fixed it. These tasks are too easy to show pass-rate gains: that needs a harder benchmark, which is the next step.

An opt-in `--economy` experiment skips the contract, review and judge calls when a fresh full test run settles every criterion of a bug fix. On the same tasks it kept 4/4 verified, at $0.0055 instead of $0.0065 and 31 s instead of 46 s (one run each). Test-run deltas, re-read dedupe and the conditional map are described, with their measurements, in [docs/token-economy.md](docs/token-economy.md).

## Cost and budgets

Sutra records every request's input, cached, output and reasoning tokens, plus latency and tool time. `/cost` shows the totals:

```
Session usage

Input tokens      48,210
  cached (hit)    30,114
Output tokens     12,840
  reasoning        4,002
API requests      19
Tool calls        43

Estimated cost    $0.0213
```

<sub>Example output.</sub>

- **Real prices, clearly dated.** Costs are estimated from DeepSeek's published per-token prices, including cache-hit pricing and off-peak rates. Every report says the date its prices are from, and you can override them in your config.
- **Budgets.** Set a limit with `/budget 1.00` or in your config. Sutra warns you at 80% of the limit, and pauses before the next request once it's reached.
- **Built to be cheap.** The system prompt stays the same for a whole session, so DeepSeek's prompt cache keeps working. Context is capped at 200K tokens by default and compacted when it gets large.
- **Local is free.** With Ollama, or a local OpenAI-compatible server, spend is reported as $0 instead of "unknown". Token counts are still tracked.

## Audit and replay

Every session is a complete local record. Two commands turn it into something you can read or share:

```bash
sutra replay                   # timeline of the latest session in this directory
sutra replay 3f2a9c1e          # …or any session by ID
sutra export --format md       # audit report: summary, every command with exit code and sandbox, full timeline
sutra export --format json     # the same as structured data (schema sutra.session-audit/v1)
```

Inside a session, `/export` does the same. A replay looks like this:

```
08:53:27  › The test suite fails. Find the bug in src/ and fix it.
08:53:27  │ Reading the code.
08:53:27  ├─ ✓ read_file       src/session.js  16 lines · 1ms
          │ deepseek-flash · 1,500 in (1,000 cached) · 120 out · $0.0003 · 29ms
08:53:27  ├─ ✓ run_tests       node --test test/  exit 1 · 185ms
08:53:27  ├─ ✓ edit_file       src/session.js  +1 −1 · 13ms
08:53:27  ├─ ✓ run_tests       node --test test/  exit 0 · 182ms
08:53:28  │ Fixed; all tests pass.

● 1 turn(s) · 5 requests · 5 tool calls · 7,500 in / 600 out · $0.0015
```

<sub>Example from a test run against a mock server.</sub>

Reports are written to `~/.sutra/exports/` (outside your repository) with owner-only permissions. The model's private reasoning is never included, and tool output was already redacted for secrets when it was recorded.

## Benchmarks

`sutra bench` measures how well your setup actually solves coding tasks, and what each solved task costs:

```bash
sutra bench                                        # all bundled tasks, current provider and model
sutra --provider ollama --model qwen3-coder bench  # compare a local model
sutra bench --only slugify,pagination --max-cost 0.25
```

Each task runs in a fresh copy of a small repository, with the Flow profile, in the sandbox, and nobody there to approve anything. The result is judged by the task's own test command, run *after* the agent finishes with the original tests restored. An agent that edits the tests to make them pass still fails. Every run is a normal saved session, so `sutra replay <id>` shows exactly what happened.

The bundled suite has four tasks (a unit-conversion bug, off-by-one pagination, a CSV quoting bug, and implementing a function from its tests). You can add your own; see [docs/benchmarks.md](docs/benchmarks.md). Results are saved as JSON and as a Markdown table in `~/.sutra/bench/`.

### Against other coding agents

[`benchmarks/harnesses`](benchmarks/harnesses/README.md) runs the same tasks through Sutra, Claude Code, Codex CLI, Aider, OpenCode, Goose and Qwen Code on one model and key. A local proxy meters every request, so tokens and cost are measured the same way for all of them.

First run, 5 November 2026, `deepseek-flash`, the 4 bundled tasks × 3 trials each:

| Harness | Passed | Median time | Cost per solved task | Input tokens per run |
| --- | --- | --- | --- | --- |
| **Sutra (fast)** | 12/12 | **9.4 s** | **$0.0015** | **29,181** |
| OpenCode | 12/12 | 10.6 s | $0.0018 | 47,430 |
| Goose | 12/12 | 10.9 s | $0.0019 | 33,408 |
| Claude Code | 12/12 | 10.8 s | $0.0030 | 76,353 |
| Sutra (balanced) | 12/12 | 12.8 s | $0.0030 | 41,024 |
| Qwen Code | 12/12 | 17.4 s | $0.0044 | 95,495 |

Every harness that reached the model solved every task, so these small tasks only separate them on cost, speed and tokens; a harder suite is needed to compare accuracy. Codex CLI couldn't take part, because its current version needs OpenAI's Responses API and DeepSeek offers only Chat Completions. Aider wasn't installed for this run. Run it yourself with `benchmarks/harnesses/run.sh`.

> [!NOTE]
> The example session at the top of this README has illustrative numbers. The table above is a real run.

## Codebase understanding

When a session starts, Sutra indexes the repository's source code, in about 100 ms for a hundred files and a couple of seconds for a few thousand. The index feeds three things:

- **A repository map, only when it helps.** Every definition is extracted (functions, classes, methods, types). Files are linked by which names they use from each other and ranked with PageRank. When a request is ambiguous or spans files, Sutra appends a map centred on the likely files (about 1,200 tokens). When the request already names the file, a test that resolves to one file, or a function with a single definition, it sends no map. `--map always` restores the old static map in the system prompt.
- **`inspect_symbol`** returns a function's exact, line-numbered body, its callers (with the function each call sits in) and the tests that mention it, in one call. The file then counts as read, so the model can edit it straight away.
- **`find_symbol`** gives a name's definitions (`file:line` and signature) and every place it's used.
- **`code_search`** handles questions in words ("where are expired sessions refreshed"). It ranks functions and classes with BM25 over identifiers split into words (`refreshAuthToken` → refresh, auth, token). Optionally it combines this with embeddings from any OpenAI-compatible `/embeddings` endpoint, such as a local Ollama model.

`repo_map` re-centres the map on the files you're working on. Edits are picked up automatically.

| | |
| --- | --- |
| **Languages** | TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, C, C++, Swift, Scala |
| **How** | Pattern-based extraction: no native code or grammar downloads. Compared with a full parser it misses some unusual syntax (multi-line signatures, macros) |
| **Limits** | Up to 5,000 files (configurable). Generated and ignored directories (`node_modules`, `dist`, `build`, `.gitignore` entries) are skipped |
| **Off switch** | `--no-index`, or `"index": { "enabled": false }` |

> [!NOTE]
> **What the index does and doesn't do yet.** In a live A/B test on Sutra's own repository (about 100 files, 3 navigation questions, DeepSeek), answers were equally correct with and without the index. The index saved tool calls on one question, made no difference on another, and the model read more files on the third. The map adds about 2,000 input tokens per request, mostly cached. On a codebase this small, grep already finds things in one step; the index is meant for large repositories, where that stops working. It hasn't been measured there yet.

## Sessions and memory

Everything is saved locally in SQLite (`~/.sutra/sutra.db`): messages, tool calls and their results, plans, token usage and checkpoints.

- `sutra --resume` picks up exactly where you left off. If the last session was interrupted in the middle of a tool call, Sutra records what happened, so the conversation stays consistent.
- In long sessions, older context is **compacted** into a structured summary: your requirements, decisions, files changed, open errors and next steps. Sutra tells you when this happens, and you can trigger it yourself with `/compact`. The full history stays on disk.

### Project instructions

Put an `AGENTS.md` in your repository, or `.sutra/AGENTS.md`, to tell Sutra how your project works: test commands, conventions, directories to leave alone. Run `sutra init` to create a template. Sutra also reads `~/.sutra/AGENTS.md` for your personal preferences across all projects. These files are treated as guidance; they can never override the permission rules.

## How it works

```
 you ─► context ─► model ─► tool calls ─► permission check ─► run ─► results ─┐
            ▲                                                                  │
            └──────────────────────── next step ◄──────────────────────────────┘
                                         │
                             done, stopped, or over budget
```

- **One loop, many steps.** Each turn repeats *think → act → observe* until the model is done, you cancel it, or a limit is reached. Every turn ends in an explicit state: completed, failed, cancelled, or over budget.
- **Fast where it's safe.** Several read-only tools (reads, searches) can run at once. Edits and commands run one at a time, in order.
- **Nothing gets lost.** Every tool call gets exactly one recorded result, including failures, denials and cancellations. Repeated identical calls are detected and stopped.
- **Careful edits.** Writes are atomic and checked after writing. Sutra won't overwrite a file it hasn't read, or one that changed since it last looked.

**Built-in tools:** `read_file`, `list_directory`, `glob_files`, `search_files`, `grep_search`, `repo_map`, `find_symbol`, `code_search`, `inspect_symbol`, `write_file`, `edit_file`, `apply_patch`, `execute_command`, `run_tests`, `diagnose_failure`, `git_status`, `git_diff`, `update_plan`, `hypotheses`, `get_output`.

**MCP tools:** servers configured under `mcpServers` in your user config add their tools to the same loop as `mcp_<server>_<tool>`. See [MCP servers](docs/configuration.md#mcp-servers).

More detail is in [docs/architecture.md](docs/architecture.md).

## Configuration

Settings live in `~/.sutra/config.json`. Each repository can add a limited `.sutra/config.json` (model, test command, extra protected paths). A small example:

```json
{
  "model": "deepseek-flash",
  "permissions": { "profile": "confirm", "protectedPaths": ["vendor/"] },
  "budget": { "maxSessionCostUsd": 1.0 },
  "tools": { "testCommand": "npm test" }
}
```

Every option, and the order in which settings override each other, is listed in [docs/configuration.md](docs/configuration.md).

## Status

Sutra is an **early preview (v0.1)**. The core is complete and well tested: the agent loop, all tools, permissions, the sandbox, sessions, compaction, cost tracking, audit export, benchmarks and the terminal UI. About 200 automated tests cover it, including an end-to-end run that fixes the example bug through the real CLI and the real test suite. On macOS they include live sandbox tests that check writes, credential reads and the network are really blocked.

What to know before relying on it:

- **Real-model checks are opt-in.** The automated tests talk to a local server that speaks the providers' exact streaming protocol. To check against the real API, run `DEEPSEEK_API_KEY=… npm run test:smoke` (it costs a fraction of a cent), or run `sutra bench`.
- **Providers other than DeepSeek are new.** They are tested against the protocol, but not yet against every provider's live API. Tool-calling quality depends heavily on the model; `sutra init` checks it before you start.
- **The sandbox is tested on macOS.** The Linux (bubblewrap) backend is implemented but hasn't been run on Linux yet. There is no Windows backend.
- **macOS first.** Developed on macOS. Linux should work but isn't covered by CI yet. Windows isn't supported yet.
- **Costs are estimates.** They use published prices; DeepSeek's holiday discounts aren't modelled.

## Roadmap

- [x] Multi-step agent loop with parallel reads, loop detection and budgets
- [x] DeepSeek provider: streaming, thinking mode, tool calls, retries, cancellation
- [x] Safe editing with diff approval
- [x] Permission profiles and command risk checks
- [x] Saved sessions, resume and context compaction
- [x] Cost tracking and spend limits
- [x] Terminal UI: thread view, command palette, light and dark themes
- [x] 20+ providers: OpenRouter, OpenAI, Anthropic, Gemini, Groq and more; local Ollama, LM Studio, llama.cpp, vLLM and Jan
- [x] OS sandbox for commands (macOS Seatbelt; Linux bubblewrap)
- [x] Session replay and audit export
- [x] Benchmark harness with independently verified tasks
- [x] Repository map, symbol lookup and ranked code search (optional embeddings)
- [x] Quality engine: evidence packet, finish gate, counterexamples, competing patches, alignment review
- [x] Context compiler: test-run deltas, unchanged re-reads as pointers, skipped identical re-runs, full output on demand
- [ ] A harder held-out benchmark with ablations of each quality layer
- [ ] Measured gains from the index on large repositories
- [ ] Published benchmark results across models
- [ ] Linux CI and Windows support
- [ ] Sub-agents for exploring, reviewing and testing
- [x] MCP tool integration (stdio and Streamable HTTP, user-configured)

## Contributing

Contributions are welcome. To get set up:

```bash
npm install
npm run typecheck
npm test             # no network or API key needed
npm run dev -- "…"   # run Sutra from source
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. The one rule that matters most: Sutra never fakes anything. What the UI shows must come from something that really happened, and what a tool reports must be what it really did.

Found a security problem? Please report it privately rather than in a public issue (see [docs/security.md](docs/security.md)).

## License

Sutra is released under the [Apache License 2.0](LICENSE). Like MIT it's permissive, and it also includes an explicit patent grant from contributors. See [NOTICE](NOTICE) for third-party attributions.

<p align="center"><sub>सूत्र · the thread that connects intelligence to action</sub></p>

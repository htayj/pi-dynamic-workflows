# pi-dynamic-workflows

[![npm](https://img.shields.io/npm/v/@quintinshaw/pi-dynamic-workflows?color=cb3837&logo=npm)](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![for Pi](https://img.shields.io/badge/for-Pi-7c3aed)](https://pi.dev)
[![tests](https://img.shields.io/badge/tests-667%20passing-success)](#development)

> **Claude Code–style dynamic workflows for [Pi](https://pi.dev).**
> Turn one prompt into a fleet of subagents that fan out in parallel, cross-check each other, and hand back a single synthesized answer.

**[Website](https://quintinshaw.github.io/pi-dynamic-workflows/) · [npm](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows) · [Pi package](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows) · [GitHub](https://github.com/QuintinShaw/pi-dynamic-workflows)**

![pi-dynamic-workflows demo](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/demo.gif)

Instead of one model grinding a task step by step, Pi writes a small JavaScript **orchestration script** that spawns many subagents at once, keeps the intermediate work in script variables (not your chat context), and returns only the result. It's the "code mode for subagents" from Claude Code — on any model Pi can reach.

Built for **codebase-wide audits, multi-perspective review, large refactors, and cross-checked research** — anything one context window can't hold.

## Install

```bash
pi install npm:@quintinshaw/pi-dynamic-workflows
```

Then `/reload` in Pi. You get the `workflow` tool plus the `/workflows`, `/deep-research`, and `/adversarial-review` commands.

## Try it

Ask in plain language:

```text
Run a workflow to audit every route under src/routes/ for missing auth checks.
```

Pi writes the script and runs it in the background — your turn ends immediately and a live panel tracks progress while you keep working. Substantive interactive requests auto-arm workflows by default, even if you never type `workflow` or run `/effort`. Add the word `noflow` anywhere in a message for a one-shot opt-out; slash commands and terse/trivial messages are left alone. `/effort off` disables automatic substantive-message forcing for the session, while `/effort high` and `/effort ultra` restore/raise it. You can still type **workflow** or **workflows** to force keyword mode for short prompts; `/workflows-trigger off|on|status` controls only that keyword trigger.

![Workflows mode in the input box](https://raw.githubusercontent.com/QuintinShaw/pi-dynamic-workflows/main/docs/media/workflows-mode.jpg)

If another Pi extension has already installed a custom editor component, pi-dynamic-workflows leaves it in place and keeps the submit-time workflow trigger active. In that compatibility mode, the animated keyword highlight and Backspace keyword-disarm affordance are skipped because the existing editor remains responsible for rendering and input handling; add `noflow` to a message or use `/effort off` when you need to discuss a substantive task without auto-triggering. Editor composition is load-order dependent: whichever extension installs a visual editor last owns the editor surface, while pi-dynamic-workflows still keeps its submit-time hook registered.

## What a workflow looks like

Plain JavaScript. The first statement exports literal metadata; then you orchestrate:

```js
export const meta = {
  name: 'auth_audit',
  description: 'Find routes missing auth checks and verify them by using the app',
  phases: [{ title: 'Scan' }, { title: 'Review' }, { title: 'Use Verification' }, { title: 'Synthesize' }],
}

phase('Scan')
const files = await agent('List every route file under src/routes/.', { tier: 'small', label: 'route inventory' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, { tier: 'medium', isolation: 'worktree', label: `audit ${file}` }),
  ),
)

phase('Use Verification')
const verification = await agent(
  'Use the actual application non-destructively to verify representative auth findings. Start the app if needed, exercise protected routes with unauthenticated/test requests (for web UI/API use Playwright and capture screenshots), and report concrete evidence. Do not rely only on code review, unit tests, or verify().\n\nFindings:\n' + findings.join('\n\n'),
  { tier: 'medium', label: 'app verification' },
)

phase('Synthesize')
return await agent('Synthesize the findings and real app-use verification evidence:\n' + findings.join('\n\n') + '\n\nVerification:\n' + verification, { tier: 'big', label: 'final synthesis' })
```

`agent()` spawns an isolated subagent, `parallel()` runs many at once, `phase()` groups them in the live view, and `tier` routes each one to the right model. That's the whole idea.

## Highlights

- **Fan-out orchestration** — `agent()`, `parallel()`, `pipeline()`, `phase()` in a sandboxed script. Up to 16 concurrent / 1000 total subagents; intermediate results stay in variables, not the chat.
- **Real model routing** — `small` / `medium` / `big` tiers (or an exact `model`) per agent. It actually switches the subagent's model — cheap work on a light one, hard synthesis on a big one.
- **Automatic self-recovery** — if a foreground or background workflow fails, a guarded diagnosis workflow inspects the failed script, args, logs, error, and agent failures once; recoverable runs are rewritten and rerun automatically, while unrecoverable runs surface a clear explanation.
- **Journaled resume** — an interrupted run replays finished agents from a journal (no re-run, no tokens) and runs only what's left or what you changed.
- **Git worktree isolation** — `isolation: "worktree"` gives an agent its own branch, so parallel agents can edit the same files without clobbering each other.
- **Real token & cost accounting** — read from each subagent's session, not estimated. `budget` gates on the real total and `/workflows` shows the dollar cost.
- **Background by default** — the turn ends right away, a live "Workflows running" panel tracks runs, and each result is delivered back so the conversation auto-continues when it finishes.
- **Interactive `/workflows` TUI** — drill runs → phases → agents → detail; inspect per-agent failures and compact subagent history; pause, stop, restart, and save runs from the keyboard.
- **Quality patterns built in** — `verify()`, `judgePanel()`, `loopUntilDry()`, and `completenessCheck()` for adversarial review, best-of-N, and exhaustive discovery.
- **Default auto-workflows** — substantive interactive messages auto-arm a thorough multi-agent workflow by default. Add `noflow` for one message, `/effort off` for the session, or `/ultracode`/`/effort ultra` for exhaustive fan-out.
- **Bundled `/deep-research` + `/adversarial-review`** — real web search, source cross-checking, and cited reports.
- **Saved & nested workflows** — turn any run into a `/<name>` command, and compose saved workflows from inside other scripts.

## How it maps to Claude Code dynamic workflows

The same model — on Pi, plus the production pieces a real run needs:

| Claude Code dynamic workflows | pi-dynamic-workflows (on Pi) |
| --- | --- |
| Code-mode orchestration — the model writes a script that drives subagents | A JS `workflow` tool running `agent()` / `parallel()` / `pipeline()` / `phase()` in a vm sandbox |
| Subagents with isolated context | Fresh in-memory Pi sessions; results held in script variables, not the chat |
| Structured outputs | JSON-Schema `schema` → a validated object, with bounded repair if the model misses |
| Background runs | Non-blocking by default, a live task panel, and auto-continue delivery |
| Resume | **Journaled + replayable** — survives restarts and replays the unchanged prefix |
| Model selection | **Per-agent / per-phase routing** across any provider Pi is authenticated for |
| Ultracode / automatic orchestration | Substantive prompts auto-arm workflows by default; **`/ultracode`** (or `/effort ultra`) raises that to exhaustive fan-out, while `noflow` or `/effort off` opt out |
| — | **Git worktree isolation**, **real cost accounting**, **`/deep-research`**, and a **quality-pattern stdlib** |

## Commands

```text
/workflows                  open the interactive navigator (plain list in print mode)
/workflows status <id>      watch a run live; print its result when it finishes
/workflows save <name>      save the latest run's script as a reusable /<name> command
/workflows pause|resume|stop|rm <id>
/workflows-trigger off|on|status
                            disable, restore, or inspect only the workflow/workflows keyword trigger
/workflows-models           map the small / medium / big tiers to real models
/ultracode [off]            raise automatic workflows to exhaustive fan-out; off disables them
/effort off|high|ultra      control substantive-message auto-workflows (default high; off disables)

/deep-research <question>   web-researched, source-cross-checked report
/adversarial-review <task>  findings vetted by skeptical reviewers
```

In the navigator: `↑/↓` select · `enter`/`→` open · `esc`/`←` back · `p` pause · `x` stop · `r` restart · `s` save · `q` quit. Each agent shows the model it ran on; the detail view shows its prompt, result, error diagnostics, and compact message/tool history.

## Reference

The full guide — every global, agent option, `agentType` definitions, structured output, and determinism — lives on the **[website](https://quintinshaw.github.io/pi-dynamic-workflows/)**. The essentials:

Non-trivial workflows that implement, change, or verify application behavior must include a `Use Verification` phase/stage in `meta.phases` and run an `agent()` there that uses the actual application or system non-destructively. Code review, tests, or `verify()` alone are not enough. Use the right modality: TUI apps via `tmux`, web pages via Playwright with captured screenshots and image analysis, GUI apps via computer-use under `xvfb` with screenshots/images and an image gate, and other apps via equivalent real use. If verification would be destructive and no non-destructive or sandbox option exists, the workflow must include an explicit skipped-verification agent explaining why.

| Global | What it does |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object with `opts.schema`; recoverable failures return `null` with diagnostics in `/workflows`. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently; results in input order. |
| `pipeline(items, ...stages)` | Fan items through sequential stages `(prev, original, index)`. |
| `phase(title, { budget? })` | Group agents in the live view; optional per-phase token sub-budget. |
| `verify` / `judgePanel` / `loopUntilDry` / `completenessCheck` | Built-in quality patterns. |
| `workflow(name, args)` | Run a saved workflow inline (shares the global caps). |
| `checkpoint(prompt, opts)` | A journaled, replayable human approval gate. |
| `budget` | `{ total, spent(), remaining() }` real-token tracker. |

| Agent option | Description |
| --- | --- |
| `tier` | `"small"` \| `"medium"` \| `"big"` — coarse model routing (configure via `/workflows-models`). |
| `model` | Exact `provider/modelId` (always wins over `tier`). |
| `agentType` | A named definition (`.pi/agents/<name>.md`) binding tools + model + role prompt. |
| `isolation: "worktree"` | Run in a throwaway git worktree for conflict-free parallel edits. |
| `schema` | JSON Schema → the subagent returns a validated object. |
| `label` / `phase` / `timeoutMs` | Display label / phase override / per-agent timeout. |

Workflows run in a Node `vm` sandbox; `Date.now()`, `Math.random()`, `new Date()`, and `require`/`import`/`fs`/network are unavailable, so runs stay reproducible — which is what makes resume reliable.

When a run fails for a non-abort reason, the manager makes one conservative automatic recovery attempt by default. Recovery itself is a small workflow-runtime run that asks a diagnosis agent for a structured decision and, only when recoverable, executes the corrected workflow. Stop, pause, Esc/user aborts, and corrected-workflow failures do not recurse into additional recovery attempts; `/workflows` shows the recovery status and reason alongside the run.

## Development

```bash
npm install
npm test     # biome + tsc + 667 unit tests
```

Every feature is also verified end-to-end against a real Pi subagent session before release.

## Credits

The "code mode for subagents" idea comes from Michael Livs' original [pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) and Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code). This project builds on it with real model routing, journaled resume, git-worktree isolation, cost accounting, an interactive TUI, and deep research.

## License

MIT — see [LICENSE](LICENSE).

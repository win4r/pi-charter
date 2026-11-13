# Architecture

## Layers

```text
extensions/charter.ts        entry named in package.json; re-exports the startup module
src/pi/extension.ts          startup module: declares command, tools, hooks. Nothing else.
src/pi/schemas.ts            tool declarations and subcommand list (no engine imports)
────────────────────────────  loaded on first use  ─────────────────────────────────────
src/pi/runtime.ts            barrel for everything below
src/pi/session.ts            per-session state, config loading, engine cache
src/pi/tools.ts              tool implementations (approval dialog, pipeline driver)
src/pi/commands.ts           /charter subcommands, setup, doctor
src/pi/guard.ts              write guard for documents and workflow files
src/pi/progress.ts           throttled live view of a running pipeline
src/pi/child.ts              PiRoleRunner: one agent as an in-process SDK session
────────────────────────────  no Pi imports below this line  ────────────────────────────
src/engine/pipeline.ts       Engine: every state change, every step
src/core/machine.ts          pure transition function
src/core/state.ts            charter.json shape and validation
src/core/store.ts            on-disk layout, hashing, archive, journal, lock
src/core/reports.ts          report shapes and submission validation
src/core/decisions.ts        recording developer decisions
src/core/spec/parse.ts       single-pass spec parser
src/core/spec/lint.ts        lint rules
src/core/briefs.ts           task briefs, criteria partitioning
src/core/git.ts              snapshots, checkpoints, diff, restore
src/core/gate.ts             check runner
src/core/summary.ts          status texts and the final report
src/core/config.ts           defaults, validation, layered loading
src/core/detect.ts           check detection for setup
```

The split has two purposes. The engine and everything under `src/core` can be tested without a host, with agents replaced by plain functions. And Pi pays only for the startup module (a few milliseconds) in sessions that never use Charter.

## Decisions and their reasons

### The saved stage is "what is needed next", not "what is running"

A design with `implementing`, `auditing`, ... stages has to answer what a stale `implementing` means after a crash. Here the stage names the next step, and a live run is recorded in a separate `active` field that is cleared on the next advance. Every step is written so that running it again is safe, which makes recovery the normal path instead of a special one.

### The engine does not know Pi

`Engine` talks to agents through a three-member interface (`RoleRunner.run(request) -> result`). The request carries a `submit` callback that validates a report and throws with the list of problems. That one seam is what lets the engine tests cover blocked runs, repair loops, shard failures, drift, rollbacks and budgets in a few seconds, with real git and real check processes but no model.

### Agents are in-process SDK sessions

Each agent is a `createAgentSessionFromServices` session with the project's normal resources (context files, skills, extensions, MCP) plus one inline extension that registers `charter_report` and the write guard. This package's own extension is filtered out of agent sessions by package name, so an agent never sees the coordinator's tools.

In-process sessions make three things cheap: the report tool is a closure over the engine's validator, so a rejected report is corrected in the same cached session; parallel auditor shards are a `Promise.all`; and one `ModelRuntime` is shared by all agents of a session.

A stopped agent gets a grace period to wind down and is then abandoned, so a provider that ignores cancellation cannot hold the pipeline.

### The report ends the run

`charter_report` returns `terminate: true`. An agent's last model call is the report itself; there is no closing prose turn to pay for, and nothing an agent says in prose is ever used.

### One call, many phases

`Engine.advance` loops over runnable stages until it reaches a waiting stage or `done`. The tools that can leave a waiting stage (`charter_approve`, `charter_resolve`) call it directly. Between approval and the next decision the coordinating model is asleep.

### Snapshots through a private index

`git add --all` into a temporary index seeded from the real one, then `write-tree`: a tree of the work tree, including untracked files, without touching anything the developer can see. Seeding from the real index reuses its stat cache, so unchanged files are not hashed again. The copy is backdated by two seconds: git re-reads any file that is not clearly older than the index file ("racy" entries), and a fresh copy would silently switch that protection off, letting a same-size edit made in the same instant as a `git add` go unnoticed. A regression test reproduces exactly that. A checkpoint is a commit of such a tree under `refs/charter/`, which keeps the objects alive.

Trees are what make enforcement possible without trusting an agent: "what changed since approval" is a tree diff, "did the auditor change anything" is a tree comparison, and "undo the refinement" is a restore of only the paths that differ.

### Documents are frozen three ways

A write guard on the file tools stops the common case and tells the model what to do instead. Hashes taken at approval catch every other route before a run starts. Archived copies let the engine undo an agent's edit instead of merely reporting it. Each mechanism covers a gap of the others.

### Facts are separated from claims

Check results, changed-file lists, drift, timing and usage are measured by the pipeline. Agent statements are confined to structured reports with enforced coverage. The final report is rendered from both, labeled by source, by code.

### Prompt sections are split by rate of change

The coordinator's instructions are a static system-prompt section; the charter's id, stage and next step are a second, three-line section. Pi sends only changed sections as patches, so the long text is sent once and stays cached.

## State and concurrency

- `charter.json` is written atomically (temporary file, then rename) after every step.
- `journal.jsonl` is append-only; a torn last line after a crash is ignored when reading.
- A lock file with the holder's pid gives one Pi process at a time the right to drive a charter; a lock left by a dead process is reclaimed. Within a process a registry on `globalThis` does the same across module instances.
- Charter numbers are claimed with a non-recursive `mkdir`, so two sessions creating charters at once cannot collide.

## Tests

| Layer | What runs |
| --- | --- |
| `test/unit/*` except `pipeline` | Pure functions, plus real git repositories and real child processes for `git.ts` and `gate.ts`. |
| `test/unit/pipeline.test.ts` | The engine with scripted agents, real git, real checks. |
| `test/e2e/*` | Real Pi `AgentSession`s for the coordinator and every agent, with Pi's faux provider as the model; includes the commands and a resumed session. |
| `test/cli/cli.test.ts` | The real `pi` executable in RPC mode with this package installed through Pi's settings, and a local HTTP server speaking the OpenAI chat-completions protocol as the model. Nothing is injected: it proves that the package loads the way users load it, that the approval dialog works over RPC, and, from the requests on the wire, that agents receive their report tool and none of the coordinator's. |

The end-to-end harness gives each model id its own script, so parallel agents cannot consume each other's replies, and records every request each model received, which is how the tests assert what an agent was and was not shown.

What the tests cannot tell you is how a real model behaves under these prompts. That needs use.

## Extending

- **A new lint rule**: add it in `src/core/spec/lint.ts` with a stable rule name, document it in `docs/workflow.md`, and add a case to `test/unit/spec.test.ts`.
- **A new check detector**: `src/core/detect.ts`.
- **A new stage**: extend `STAGES`, add the event and its origins in `machine.ts`, add the step to `Engine.advance`, and extend `nextAction` and the stage label in `summary.ts`. The exhaustive `switch` statements make the compiler list every place.
- **A different way to run agents** (subprocesses, remote workers): implement `RoleRunner` and pass it to `createCharterExtension({ runner })`.

# dsh-git

Read-only git tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Sessions.

A DSH bundle that registers five git tools on `ctx.tools`, so the agent can inspect a
repository without going through a shell. It never writes: no add, commit, checkout, reset, push.

## Tools

| Tool | What it returns |
| --- | --- |
| `git_status` | Branch, upstream divergence, and every changed path with its index/worktree status |
| `git_diff` | Unified diff plus stat; unstaged by default, `staged` for the index, `ref` to diff against a branch/tag/commit, `path` to narrow |
| `git_log` | Recent commits as `{hash, author, date, subject}`, newest first, optional `path` |
| `git_show` | One commit or ref: metadata, stat and patch (truncated when huge) |
| `git_branch` | Local branches, current one marked, upstream named |

Every tool takes an optional `cwd`. With no argument it uses the Session working
directory, the same one the built-in `bash` and file tools use, so a tool call and a shell
command see the same checkout.

## Install

The package is a DSH bundle: it ships `cordis.patch.yml` and declares it in `dsh.bundle` in
`package.json`. It has no runtime dependencies and no build step.

From a local checkout, into a profile of its own (recommended while trying it):

```sh
dsh gitdev --from-default-profile web --dump-config > /dev/null   # a separate profile
dsh plugin --profile gitdev add "link:/path/to/dsh-git"
dsh gitdev --dump-config | grep dsh-git                            # the entry is mounted
dsh gitdev                                                         # boot it
```

From this repository:

```sh
dsh plugin --profile gitdev add "github:aaazha2016/dsh-git"
```

Installing into the profile you are currently using requires a restart of that profile, which
ends its running Sessions. Use a second profile unless you mean it.

## Use

Ask the agent in plain language; it picks the tools:

- "What is the working tree state of this repository?"
- "Show me the diff of the last commit."
- "Which branches exist and which one am I on?"
- "What changed in `src/app` since `main`?"

Or point it at another checkout by passing an absolute path:

```
git_status({ cwd: "/data/zha/other-repo" })
```

## Design notes

- **Zero runtime dependencies.** Tools are registered with raw JSON Schema through
  `ctx.tools.register()` instead of `defineTool` from `@deepseek-ai/dsh-tools`. That keeps a
  `link:` install working without installing the harness packages inside this repository,
  and removes the build step.
- **Argument vectors, never a shell.** Every command is an `execFile('git', [...])` call with a
  15 s timeout, a 16 MiB buffer, `GIT_TERMINAL_PROMPT=0`, and the caller's abort signal. No
  string interpolation reaches a shell.
- **Read-only by construction.** The argument lists are built here; no tool forwards
  free-form git subcommands or flags from the model.
- **Failures are explicit.** A non-zero exit is reported as data; a directory that is not a
  repository throws `Not a git repository: ...` so the call is marked failed.

## Development

```sh
node --test 'test/*.test.js'
```

The tests build throwaway repositories under `$TMPDIR` and exercise every tool plus the
porcelain parser. No harness install is needed to run them.

## Limits

- Read-only. Writing (stage, commit, branch switch) is deliberately out of scope for 0.1.0.
- Local branches only; no remote refs beyond each branch's configured upstream.
- Patches are capped at 40,000 characters per result and say when they were cut.

## License

MIT

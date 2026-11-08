/**
 * Model-facing tool definitions. Registered with raw JSON Schema so the
 * package needs no runtime dependency on the harness packages.
 */
import path from 'node:path'
import {
  branches,
  clip,
  diff,
  log,
  repoRoot,
  show,
  status,
} from './git.js'

const CWD_PARAM = {
  type: 'string',
  description:
    'Absolute path of a directory inside the repository. Defaults to the Session working directory.',
}

const textBlock = (text) => [{ type: 'text', text }]

const OUTPUT_TEXT = {
  type: 'object',
  properties: {
    cwd: { type: 'string' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['cwd', 'text', 'truncated'],
}

/**
 * Resolve the directory a tool should run in: the explicit argument, else the
 * Session working directory.
 */
export async function resolveCwd(ctx, args, exec) {
  const base = exec.agent === undefined
    ? process.cwd()
    : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  if (typeof args.cwd === 'string' && args.cwd.length > 0) {
    return path.isAbsolute(args.cwd) ? args.cwd : path.resolve(base, args.cwd)
  }
  return base
}

export function statusTool(ctx) {
  return {
    name: 'git_status',
    description:
      'Show the working tree state of a git repository: current branch, upstream divergence, and every changed path with its index/worktree status. Use this before editing or committing.',
    parameters: {
      type: 'object',
      properties: { cwd: CWD_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          branch: { type: 'string' },
          upstream: { type: 'string' },
          ahead: { type: 'integer' },
          behind: { type: 'integer' },
          clean: { type: 'boolean' },
          staged: { type: 'integer' },
          unstaged: { type: 'integer' },
          untracked: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                index: { type: 'string' },
                worktree: { type: 'string' },
                originalPath: { type: 'string' },
              },
              required: ['path', 'index', 'worktree'],
            },
          },
          text: { type: 'string' },
        },
        required: ['cwd', 'branch', 'clean', 'entries', 'text'],
      },
      render: (_args, value) => textBlock(value.text),
    },
    async execute(args, exec) {
      const cwd = await repoRoot(await resolveCwd(ctx, args, exec), exec.signal)
      const result = await status(cwd, exec.signal)
      const counts = result.counts
      const clean = result.entries.length === 0
      const lines = [
        "branch: " + (result.branch ?? "(detached)"),
        result.upstream
          ? "upstream: " + result.upstream + " (ahead " + result.ahead + ", behind " + result.behind + ")"
          : "upstream: none",
        "changes: " + counts.staged + " staged, " + counts.unstaged + " unstaged, " + counts.untracked + " untracked",
      ]
      if (clean) {
        lines.push("working tree clean")
      } else {
        for (const entry of result.entries) {
          const marker = entry.index + entry.worktree
          const renamed = entry.originalPath ? " (from " + entry.originalPath + ")" : ""
          lines.push(marker + " " + entry.path + renamed)
        }
      }
      return {
        cwd,
        branch: result.branch ?? "",
        upstream: result.upstream ?? "",
        ahead: result.ahead ?? 0,
        behind: result.behind ?? 0,
        clean,
        staged: counts.staged,
        unstaged: counts.unstaged,
        untracked: counts.untracked,
        entries: result.entries,
        text: lines.join("\n"),
      }
    },
  }
}

export function diffTool(ctx) {
  return {
    name: 'git_diff',
    description:
      'Show a unified diff with a stat summary. Defaults to unstaged changes; set staged=true for the index, or pass ref (a branch, tag or commit) to diff against it. Narrow with path. Prefer this over running git diff through a shell.',
    parameters: {
      type: 'object',
      properties: {
        cwd: CWD_PARAM,
        staged: { type: 'boolean', description: 'Diff the index against HEAD instead of the worktree.' },
        ref: { type: 'string', description: 'Diff against this ref, for example main or HEAD~3.' },
        path: { type: 'string', description: 'Limit the diff to this path, relative to the repository root.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          staged: { type: 'boolean' },
          empty: { type: 'boolean' },
          stat: { type: 'string' },
          patch: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['cwd', 'empty', 'stat', 'patch', 'truncated'],
      },
      render: (_args, value) => textBlock(
        value.empty
          ? "no changes" + (value.stat ? "\n" + value.stat : "")
          : (value.stat ? value.stat + "\n\n" : "") + value.patch,
      ),
    },
    async execute(args, exec) {
      const cwd = await repoRoot(await resolveCwd(ctx, args, exec), exec.signal)
      const result = await diff(cwd, exec.signal, {
        staged: args.staged === true,
        ref: typeof args.ref === 'string' && args.ref.length > 0 ? args.ref : undefined,
        path: typeof args.path === 'string' && args.path.length > 0 ? args.path : undefined,
      })
      const clipped = clip(result.patch)
      return {
        cwd,
        staged: args.staged === true,
        empty: result.empty,
        stat: result.stat,
        patch: clipped.text,
        truncated: clipped.truncated,
      }
    },
  }
}

export function logTool(ctx) {
  return {
    name: 'git_log',
    description:
      'List recent commits with short hash, author, date and subject, newest first. Optionally limit to a path. Use git_show for one commit body.',
    parameters: {
      type: 'object',
      properties: {
        cwd: CWD_PARAM,
        limit: { type: 'integer', description: 'How many commits, 1-100. Defaults to 20.' },
        path: { type: 'string', description: 'Only commits touching this path.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          commits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                hash: { type: 'string' },
                author: { type: 'string' },
                date: { type: 'string' },
                subject: { type: 'string' },
              },
              required: ['hash', 'author', 'date', 'subject'],
            },
          },
          text: { type: 'string' },
        },
        required: ['cwd', 'commits', 'text'],
      },
      render: (_args, value) => textBlock(value.text),
    },
    async execute(args, exec) {
      const cwd = await repoRoot(await resolveCwd(ctx, args, exec), exec.signal)
      const commits = await log(cwd, exec.signal, {
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        path: typeof args.path === 'string' && args.path.length > 0 ? args.path : undefined,
      })
      const text = commits.length === 0
        ? "no commits"
        : commits.map((c) => c.hash + " " + c.date + " " + c.author + "  " + c.subject).join("\n")
      return { cwd, commits, text }
    },
  }
}

export function branchTool(ctx) {
  return {
    name: 'git_branch',
    description:
      'List local branches with the current one marked and each upstream named. Read-only: this tool never creates, switches or deletes branches.',
    parameters: {
      type: 'object',
      properties: { cwd: CWD_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          current: { type: 'string' },
          branches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                current: { type: 'boolean' },
                upstream: { type: 'string' },
              },
              required: ['name', 'current'],
            },
          },
          text: { type: 'string' },
        },
        required: ['cwd', 'current', 'branches', 'text'],
      },
      render: (_args, value) => textBlock(value.text),
    },
    async execute(args, exec) {
      const cwd = await repoRoot(await resolveCwd(ctx, args, exec), exec.signal)
      const result = await branches(cwd, exec.signal)
      const text = result.branches.length === 0
        ? "no branches"
        : result.branches
            .map((b) => (b.current ? "* " : "  ") + b.name + (b.upstream ? " -> " + b.upstream : ""))
            .join("\n")
      return { cwd, current: result.current ?? "", branches: result.branches, text }
    },
  }
}

export function showTool(ctx) {
  return {
    name: 'git_show',
    description:
      'Show one commit or ref: metadata, stat and patch. Accepts a hash, HEAD~2, a tag or a branch. Output is truncated for very large commits.',
    parameters: {
      type: 'object',
      properties: {
        cwd: CWD_PARAM,
        ref: { type: 'string', description: 'Commit hash, tag, branch or revision expression. Defaults to HEAD.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_TEXT,
      render: (_args, value) => textBlock(value.text),
    },
    async execute(args, exec) {
      const cwd = await repoRoot(await resolveCwd(ctx, args, exec), exec.signal)
      const ref = typeof args.ref === 'string' && args.ref.length > 0 ? args.ref : 'HEAD'
      const raw = await show(cwd, exec.signal, ref)
      const clipped = clip(raw)
      return { cwd, text: clipped.text, truncated: clipped.truncated }
    },
  }
}

/** Every tool this package registers. */
export function definitions(ctx) {
  return [statusTool(ctx), diffTool(ctx), logTool(ctx), branchTool(ctx), showTool(ctx)]
}

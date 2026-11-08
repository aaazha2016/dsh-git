/**
 * Git plumbing for dsh-git.
 *
 * Every command is an argument vector (never a shell string), runs with a
 * timeout, and resolves instead of rejecting: a non-zero exit is data the tool
 * reports, not an exception. Only a missing repository is a hard error.
 */
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'

/** Model-facing text cap per tool result, in characters. */
export const MAX_TEXT = 40000

const TIMEOUT_MS = 15000
const MAX_BUFFER = 16 * 1024 * 1024

/**
 * Run one git command.
 * @param {string} cwd working directory
 * @param {string[]} args git arguments, already split
 * @param {AbortSignal | undefined} signal caller cancellation
 */
export function runGit(cwd, args, signal) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-pager', '-c', 'core.quotepath=false', ...args],
      {
        cwd,
        signal,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: Boolean(error && error.killed),
          aborted: Boolean(error && error.name === 'AbortError'),
        })
      },
    )
  })
}

/**
 * Resolve the repository root of cwd, or throw a tool failure.
 * @param {string} cwd
 * @param {AbortSignal | undefined} signal
 */
export async function repoRoot(cwd, signal) {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], signal)
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'git rev-parse failed'
    throw new Error('Not a git repository: ' + cwd + ' (' + detail.split('\n')[0] + ')')
  }
  return result.stdout.trim()
}

/** Truncate model-facing text and say so. */
export function clip(text, limit = MAX_TEXT) {
  if (text.length <= limit) return { text, truncated: false }
  return {
    text: text.slice(0, limit) + '\n\n[truncated: ' + (text.length - limit) + ' more characters]',
    truncated: true,
  }
}

/**
 * Parse git status --porcelain=v1 -z.
 * @param {string} raw NUL-separated porcelain output
 */
export function parsePorcelain(raw) {
  const records = raw.split('\0')
  const entries = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 3) continue
    const indexStatus = record[0]
    const worktreeStatus = record[1]
    const path = record.slice(3)
    const entry = { path, index: indexStatus, worktree: worktreeStatus }
    if (indexStatus === 'R' || indexStatus === 'C') {
      const original = records[index + 1]
      if (original !== undefined) {
        entry.originalPath = original
        index += 1
      }
    }
    entries.push(entry)
  }
  return entries
}

/** Count porcelain entries by where the change lives. */
export function summarizeEntries(entries) {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const entry of entries) {
    if (entry.index === '?' && entry.worktree === '?') {
      untracked += 1
      continue
    }
    if (entry.index !== ' ' && entry.index !== '?') staged += 1
    if (entry.worktree !== ' ' && entry.worktree !== '?') unstaged += 1
  }
  return { staged, unstaged, untracked }
}

/**
 * Branch, upstream divergence and changed paths.
 * @param {string} cwd repository root
 * @param {AbortSignal | undefined} signal
 */
export async function status(cwd, signal) {
  const [branchResult, statusResult] = await Promise.all([
    runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal),
    runGit(cwd, ['status', '--porcelain=v1', '-z'], signal),
  ])
  if (!statusResult.ok) throw new Error('git status failed: ' + statusResult.stderr.trim())
  const entries = parsePorcelain(statusResult.stdout)
  const branch = branchResult.ok ? branchResult.stdout.trim() : null
  let ahead = null
  let behind = null
  let upstream = null
  if (branch && branch !== 'HEAD') {
    const upstreamResult = await runGit(
      cwd,
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      signal,
    )
    if (upstreamResult.ok) {
      const [left, right] = upstreamResult.stdout.trim().split(/\s+/)
      behind = Number.parseInt(left, 10)
      ahead = Number.parseInt(right, 10)
      const name = await runGit(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'], signal)
      if (name.ok) upstream = name.stdout.trim()
    }
  }
  return { branch, upstream, ahead, behind, entries, counts: summarizeEntries(entries) }
}

/**
 * Structured commit list.
 * @param {string} cwd
 * @param {AbortSignal | undefined} signal
 * @param {{ limit?: number, path?: string }} options
 */
export async function log(cwd, signal, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
  const args = [
    'log',
    '--max-count=' + limit,
    '--date=short',
    '--pretty=format:%h%x1f%an%x1f%ad%x1f%s',
  ]
  if (options.path) args.push('--', options.path)
  const result = await runGit(cwd, args, signal)
  if (!result.ok) {
    if (/does not have any commits yet|unknown revision/i.test(result.stderr)) return []
    throw new Error('git log failed: ' + result.stderr.trim())
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash, author, date, subject] = line.split('\x1f')
      return { hash, author, date, subject }
    })
}

/**
 * Branches with the current marker and upstream.
 * @param {string} cwd
 * @param {AbortSignal | undefined} signal
 */
export async function branches(cwd, signal) {
  const format = '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)'
  const result = await runGit(cwd, ['branch', '--list', format], signal)
  if (!result.ok) throw new Error('git branch failed: ' + result.stderr.trim())
  const rows = result.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, head, upstream] = line.split('\x1f')
      return { name, current: head === '*', upstream: upstream || null }
    })
  return { current: rows.find((row) => row.current)?.name ?? null, branches: rows }
}

/**
 * Diff against the index, the worktree, or a ref.
 * @param {string} cwd
 * @param {AbortSignal | undefined} signal
 * @param {{ staged?: boolean, ref?: string, path?: string }} options
 */
export async function diff(cwd, signal, options = {}) {
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (options.staged) args.push('--staged')
  if (options.ref) args.push(options.ref)
  if (options.path) args.push('--', options.path)
  const [patchResult, statResult] = await Promise.all([
    runGit(cwd, args, signal),
    runGit(cwd, [...args, '--stat'], signal),
  ])
  if (!patchResult.ok) throw new Error('git diff failed: ' + patchResult.stderr.trim())
  return {
    stat: statResult.ok ? statResult.stdout.trim() : '',
    patch: patchResult.stdout,
    empty: patchResult.stdout.trim().length === 0,
  }
}

/**
 * One commit or ref, stat plus patch.
 * @param {string} cwd
 * @param {AbortSignal | undefined} signal
 * @param {string} ref
 */
export async function show(cwd, signal, ref) {
  const result = await runGit(
    cwd,
    ['show', '--no-color', '--no-ext-diff', '--stat', '--patch', '--decorate', ref],
    signal,
  )
  if (!result.ok) throw new Error('git show ' + ref + ' failed: ' + result.stderr.trim())
  return result.stdout
}

/** Stage explicit paths. */
export async function stage(cwd, signal, paths) {
  if (paths.length === 0) throw new Error('At least one path is required.')
  const result = await runGit(cwd, ['add', '--', ...paths], signal)
  if (!result.ok) throw new Error('git add failed: ' + result.stderr.trim())
  return result.stdout
}

/** Stage every change in the worktree, including deletions and untracked files. */
export async function stageAll(cwd, signal) {
  const result = await runGit(cwd, ['add', '--all'], signal)
  if (!result.ok) throw new Error('git add --all failed: ' + result.stderr.trim())
  return result.stdout
}

/** What is staged right now, as paths with status and a stat summary. */
export async function staged(cwd, signal) {
  const [names, stat] = await Promise.all([
    runGit(cwd, ['diff', '--cached', '--name-status'], signal),
    runGit(cwd, ['diff', '--cached', '--stat'], signal),
  ])
  if (!names.ok) throw new Error('git diff --cached failed: ' + names.stderr.trim())
  const files = names.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('\t')
      return { status: parts[0], path: parts.slice(1).join('\t') }
    })
  return { files, stat: stat.ok ? stat.stdout.trim() : '' }
}

/** Refuse to commit while an operation a human must finish is in progress. */
async function assertNotMidOperation(cwd, signal) {
  const merge = await runGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], signal)
  if (merge.ok) throw new Error('A merge is in progress; finish or abort it before committing.')
  const dir = await runGit(cwd, ['rev-parse', '--absolute-git-dir'], signal)
  if (!dir.ok) return
  for (const name of ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    try {
      await access(path.join(dir.stdout.trim(), name))
    } catch {
      continue
    }
    throw new Error(name + ' is present: finish or abort that operation before committing.')
  }
}

/**
 * Commit the index with one message. No amend, no hook bypass, no push.
 * @returns the new commit hash and the summary git printed
 */
export async function commit(cwd, signal, message) {
  const text = message.trim()
  if (text.length === 0) throw new Error('A commit message is required.')
  await assertNotMidOperation(cwd, signal)
  const index = await staged(cwd, signal)
  if (index.files.length === 0) {
    throw new Error('Nothing is staged. Stage paths with git_stage first, then commit.')
  }
  const result = await runGit(cwd, ['commit', '-m', text], signal)
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim()
    const hint = /Please tell me who you are|user\.email|user\.name/i.test(detail)
      ? ' Set user.name and user.email in this repository first.'
      : ''
    throw new Error('git commit failed: ' + detail + hint)
  }
  const head = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], signal)
  return { hash: head.ok ? head.stdout.trim() : '', summary: result.stdout.trim() }
}

/**
 * Blame one file, optionally a line range.
 * @param {{ path: string, start?: number, end?: number }} options
 */
export async function blame(cwd, signal, options) {
  const args = ['blame', '--date=short']
  if (options.start !== undefined && options.end !== undefined) {
    args.push('-L', options.start + ',' + options.end)
  }
  args.push('--', options.path)
  const result = await runGit(cwd, args, signal)
  if (!result.ok) throw new Error('git blame failed: ' + result.stderr.trim())
  return result.stdout
}

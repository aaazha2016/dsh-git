import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'
import { runGit, parsePorcelain, summarizeEntries } from '../lib/git.js'

const signal = () => new AbortController().signal

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-git-'))
  const git = (...args) => runGit(dir, args, signal())
  await git('init', '-q', '-b', 'main')
  await writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git('add', 'a.txt')
  await git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init')
  return { dir, git }
}

function fakeContext(cwd) {
  const registered = []
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    workingDirectory: { ensure: async () => cwd },
  }
  apply(ctx)
  return registered
}

test('plugin registers five tools with valid schemas', async () => {
  const { dir } = await makeRepo()
  const tools = fakeContext(dir)
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['git_branch', 'git_diff', 'git_log', 'git_show', 'git_status'],
  )
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('git_status reports branch, counts and paths', async () => {
  const { dir } = await makeRepo()
  const [status] = fakeContext(dir)
  const exec = { signal: signal(), agent: undefined }

  const clean = await status.execute({ cwd: dir }, exec)
  assert.equal(clean.clean, true)
  assert.equal(clean.branch, 'main')

  await appendFile(path.join(dir, 'a.txt'), 'two\n')
  await writeFile(path.join(dir, 'b.txt'), 'new\n')
  const dirty = await status.execute({ cwd: dir }, exec)
  assert.equal(dirty.clean, false)
  assert.equal(dirty.unstaged, 1)
  assert.equal(dirty.untracked, 1)
  assert.ok(dirty.entries.some((entry) => entry.path === 'b.txt' && entry.index === '?'))
  assert.match(dirty.text, /branch: main/)
})

test('git_diff shows the worktree change', async () => {
  const { dir } = await makeRepo()
  const [, diff] = fakeContext(dir)
  const exec = { signal: signal(), agent: undefined }

  const empty = await diff.execute({ cwd: dir }, exec)
  assert.equal(empty.empty, true)

  await appendFile(path.join(dir, 'a.txt'), 'two\n')
  const changed = await diff.execute({ cwd: dir }, exec)
  assert.equal(changed.empty, false)
  assert.match(changed.patch, /\+two/)
  assert.match(changed.stat, /a\.txt/)
})

test('git_log and git_show see the commit', async () => {
  const { dir, git } = await makeRepo()
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n')
  await git('add', 'a.txt')
  await git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'second')

  const [, , log, , show] = fakeContext(dir)
  const exec = { signal: signal(), agent: undefined }

  const logged = await log.execute({ cwd: dir, limit: 5 }, exec)
  assert.equal(logged.commits.length, 2)
  assert.equal(logged.commits[0].subject, 'second')
  assert.match(logged.text, /second/)

  const shown = await show.execute({ cwd: dir, ref: 'HEAD~1' }, exec)
  assert.match(shown.text, /init/)
})

test('git_branch marks the current branch', async () => {
  const { dir, git } = await makeRepo()
  await git('branch', 'feature')
  const [, , , branch] = fakeContext(dir)
  const result = await branch.execute({ cwd: dir }, { signal: signal(), agent: undefined })
  assert.equal(result.current, 'main')
  assert.deepEqual(result.branches.map((b) => b.name).sort(), ['feature', 'main'])
  assert.equal(result.branches.find((b) => b.name === 'main').current, true)
})

test('a non-repository fails loudly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-git-plain-'))
  const [status] = fakeContext(dir)
  await assert.rejects(
    () => status.execute({ cwd: dir }, { signal: signal(), agent: undefined }),
    /Not a git repository/,
  )
  await rm(dir, { recursive: true, force: true })
})

test('porcelain parser handles renames and counts', () => {
  const entries = parsePorcelain('R  new.txt\0old.txt\0 M a.txt\0?? b.txt\0')
  assert.equal(entries.length, 3)
  assert.equal(entries[0].originalPath, 'old.txt')
  assert.deepEqual(summarizeEntries(entries), { staged: 1, unstaged: 1, untracked: 1 })
})

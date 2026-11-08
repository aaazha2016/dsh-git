import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'
import { runGit, parsePorcelain, summarizeEntries } from '../lib/git.js'
import { isInside, normalizeRoots } from '../lib/policy.js'

const signal = () => new AbortController().signal

async function makeRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-git-'))
  const git = (...args) => runGit(dir, args, signal())
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 't@example.com')
  await git('config', 'user.name', 'T')
  await writeFile(path.join(dir, 'a.txt'), 'one\n')
  await git('add', 'a.txt')
  await git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init')
  return { dir, git }
}

function fakeContext(cwd, config = {}) {
  const registered = []
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    workingDirectory: { ensure: async () => cwd },
  }
  apply(ctx, config)
  return registered
}

test('plugin registers eight tools with valid schemas', async () => {
  const { dir } = await makeRepo()
  const tools = fakeContext(dir)
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['git_blame', 'git_branch', 'git_commit', 'git_diff', 'git_log', 'git_show', 'git_stage', 'git_status'],
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

test('git_stage and git_commit write one commit', async () => {
  const { dir } = await makeRepo()
  const [, , , , , stageTool, commitTool] = fakeContext(dir)
  const exec = { signal: signal(), agent: undefined }

  await appendFile(path.join(dir, 'a.txt'), 'two\n')
  await writeFile(path.join(dir, 'b.txt'), 'new\n')

  const stagedExplicit = await stageTool.execute({ cwd: dir, paths: ['a.txt'] }, exec)
  assert.deepEqual(stagedExplicit.files.map((f) => f.path), ['a.txt'])
  assert.equal(stagedExplicit.files[0].status, 'M')

  await stageTool.execute({ cwd: dir, all: true }, exec)
  const stagedAllRaw = await runGit(dir, ['diff', '--cached', '--name-status'], signal())
  const stagedRows = stagedAllRaw.stdout.trim().split(String.fromCharCode(10)).map((line) => line.split(String.fromCharCode(9)))
  assert.deepEqual(stagedRows.map((row) => row[1]).sort(), ['a.txt', 'b.txt'])
  assert.ok(stagedRows.some((row) => row[0] === 'A' && row[1] === 'b.txt'))

  const committed = await commitTool.execute({ cwd: dir, message: 'second' }, exec)
  assert.match(committed.hash, /^[0-9a-f]{7,}$/)
  assert.match(committed.text, /second/)

  const status = await runGit(dir, ['status', '--porcelain'], signal())
  assert.equal(status.stdout.trim(), '')
  const logResult = await runGit(dir, ['log', '--oneline'], signal())
  assert.equal(logResult.stdout.trim().split('\n').length, 2)
})

test('git_commit refuses an empty index and a merge in progress', async () => {
  const { dir } = await makeRepo()
  const [, , , , , , commitTool] = fakeContext(dir)
  const exec = { signal: signal(), agent: undefined }

  await assert.rejects(() => commitTool.execute({ cwd: dir, message: 'empty' }, exec), /Nothing is staged/)

  await appendFile(path.join(dir, 'a.txt'), 'two\n')
  await runGit(dir, ['add', 'a.txt'], signal())
  const head = await runGit(dir, ['rev-parse', 'HEAD'], signal())
  await writeFile(path.join(dir, '.git', 'MERGE_HEAD'), head.stdout)
  await assert.rejects(
    () => commitTool.execute({ cwd: dir, message: 'during merge' }, exec),
    /merge is in progress/,
  )
})

test('git_blame names the author of a line', async () => {
  const { dir } = await makeRepo()
  fakeContext(dir)
  const tools = fakeContext(dir)
  const blameTool = tools[tools.length - 1]
  const result = await blameTool.execute({ cwd: dir, path: 'a.txt' }, { signal: signal(), agent: undefined })
  assert.match(result.text, /T\s+20/)
  assert.match(result.text, /one/)
})

test('git_stage rejects an empty path list', async () => {
  const { dir } = await makeRepo()
  const tools = fakeContext(dir)
  const stageTool = tools[5]
  await assert.rejects(
    () => stageTool.execute({ cwd: dir }, { signal: signal(), agent: undefined }),
    /At least one path/,
  )
})

test('policy: isInside compares path segments', () => {
  assert.equal(isInside('/srv/app', '/srv/app'), true)
  assert.equal(isInside('/srv/app/sub', '/srv/app'), true)
  assert.equal(isInside('/srv/app2', '/srv/app'), false)
  assert.equal(isInside('/srv', '/srv/app'), false)
  assert.equal(isInside('/srv/app/../other', '/srv/app'), false)
})

test('policy: normalizeRoots trims, expands ~ and drops junk', () => {
  const roots = normalizeRoots(['  /a ', '', 7, null, '~/b'])
  assert.equal(roots[0], '/a')
  assert.equal(roots.length, 2)
  assert.ok(roots[1].endsWith('/b'))
  assert.deepEqual(normalizeRoots(undefined), [])
  assert.deepEqual(normalizeRoots('not-an-array'), [])
})

test('policy: every tool rejects a repository outside allowedRoots', async () => {
  const { dir } = await makeRepo()
  const other = await mkdtemp(path.join(tmpdir(), 'dsh-git-allowed-'))
  fakeContext(dir, { allowedRoots: [other] })
  const tools = fakeContext(dir, { allowedRoots: [other] })
  const exec = { signal: signal(), agent: undefined }
  await assert.rejects(
    () => tools[0].execute({ cwd: dir }, exec),
    /outside the allowed roots/,
  )
  await rm(other, { recursive: true, force: true })
})

test('policy: a repository inside allowedRoots still works', async () => {
  const { dir } = await makeRepo()
  const tools = fakeContext(dir, { allowedRoots: [path.dirname(dir)] })
  const result = await tools[0].execute({ cwd: dir }, { signal: signal(), agent: undefined })
  assert.equal(result.clean, true)
})

/**
 * Repository-root allowlist.
 *
 * An empty list means no restriction (the 0.1-0.2 behaviour). A non-empty list
 * restricts every tool to repositories that are the root itself or inside it.
 * Both sides are resolved through realpath so a symlink cannot escape.
 */
import { realpath } from 'node:fs/promises'
import path from 'node:path'

/**
 * Normalize a configured list of roots: trim, expand a leading ~, and resolve
 * against the process working directory. Invalid entries are dropped.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeRoots(value) {
  if (!Array.isArray(value)) return []
  const home = process.env.HOME ?? ''
  const roots = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const expanded = trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(home, trimmed.slice(1))
      : trimmed
    roots.push(path.resolve(expanded))
  }
  return roots
}

/**
 * Is \`target\` the same directory as \`root\` or inside it?
 * Compares path segments, so /srv/app2 is not inside /srv/app.
 */
export function isInside(target, root) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Throw unless the repository root is allowed.
 * @param {string} repoRoot absolute path of the repository root
 * @param {string[]} allowedRoots normalized roots; empty means unrestricted
 */
export async function assertAllowed(repoRoot, allowedRoots) {
  if (allowedRoots.length === 0) return
  const realRepo = await realpath(repoRoot)
  for (const allowed of allowedRoots) {
    let realAllowed
    try {
      realAllowed = await realpath(allowed)
    } catch {
      continue
    }
    if (isInside(realRepo, realAllowed)) return
  }
  throw new Error(
    'Repository ' + repoRoot + ' is outside the allowed roots (' + allowedRoots.join(', ') + '). '
    + 'Add it to the dsh-git plugin config allowedRoots to work there.',
  )
}

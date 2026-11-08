/**
 * dsh-git: git tools for DeepSeek Harness Sessions.
 *
 * The plugin registers eight tools on \`ctx.tools\`. It has no runtime
 * dependencies: tools are declared with raw JSON Schema, and git runs through
 * \`node:child_process\` argument vectors (never a shell string).
 */
import { normalizeRoots } from './policy.js'
import { definitions } from './tools.js'

/** Cordis plugin name, used in profile patches. */
export const name = 'dsh-git'

/** Services this plugin needs before it can mount. */
export const inject = ['tools', 'workingDirectory']

/**
 * Mount the tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ allowedRoots?: string[] }} [config] profile configuration
 */
export function apply(ctx, config = {}) {
  const policy = { allowedRoots: normalizeRoots(config.allowedRoots) }
  for (const definition of definitions(ctx, policy)) {
    ctx.tools.register(definition)
  }
}

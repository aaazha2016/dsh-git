/**
 * dsh-git: read-only git tools for DeepSeek Harness Sessions.
 *
 * The plugin registers five tools on `ctx.tools`. It has no runtime
 * dependencies: tools are declared with raw JSON Schema, and git runs through
 * `node:child_process` argument vectors (never a shell string).
 */
import { definitions } from './tools.js'

/** Cordis plugin name, used in profile patches. */
export const name = 'dsh-git'

/** Services this plugin needs before it can mount. */
export const inject = ['tools', 'workingDirectory']

/**
 * Mount the tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  for (const definition of definitions(ctx)) {
    ctx.tools.register(definition)
  }
}

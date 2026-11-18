/**
 * 用 Harness 自己的工具定义器检查 schema。
 * 定义器抛错就整份拒绝，避免留下缺字段的工具。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export function schemaError(parameters) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return 'schema'
  if (Object.keys(parameters).length === 0) return 'schema'
  try {
    defineTool({
      name: 'schema_probe',
      description: '检查新工具 schema',
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        return ''
      },
    })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'schema'
  }
}

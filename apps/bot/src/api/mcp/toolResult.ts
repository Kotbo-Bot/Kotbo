import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Helpers annotés explicitement en `CallToolResult` (le type de retour attendu
// par `registerTool`), plutôt qu'en union de types anonymes inférés. Cela donne
// un point d'ancrage stable au vérificateur ; le vrai gain mémoire vient
// toutefois du wrapper non générique de `registerMcpTools` (`mcpTools.ts`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpToolHandler = (args: any) => CallToolResult | Promise<CallToolResult>;

export const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export const err = (msg: string, meta?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
  isError: true,
  ...(meta ? { _meta: meta } : {}),
});


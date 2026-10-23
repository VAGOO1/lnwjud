import { createHash } from 'node:crypto';
import { appError, err } from '@lnwjud/domain';
import { defineTool, missingService, type McpToolContext, type McpToolDefinition } from './tool-types.js';
import { codexRulesSchema } from './schemas.js';

export const CODEX_RULES_TOOL_NAMES = Object.freeze(['codex_rules'] as const);

/** The workspace source is read only after native approval; external target reads stay in CodexRulesService. */
export function codexRulesTools(context: McpToolContext): McpToolDefinition[] {
  return [defineTool({
    name: 'codex_rules',
    description: 'Native-approved exact-file deployment for derived CODEX_HOME AGENTS.md or explicitly selected AGENTS.override.md. Inspect produces an owner-bound, 120-second snapshot; apply consumes it once and creates a durable host-owned rollback receipt. Full Bypass never bypasses this approval.',
    permission: 'DANGEROUS',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: codexRulesSchema,
    handler: async (input, signal, authorization) => {
      const rules = context.services.codexRules;
      if (rules === undefined) return missingService();
      const owner = `${context.actor.clientId}:${context.actor.sessionId ?? ''}`;
      if (input.operation === 'inspect') return rules.inspect(owner, input.target, authorization, signal);
      if (input.operation === 'probe_new_session') {
        if (input.expected_current_sha256 === undefined) return err(appError('INVALID_INPUT', 'probe_new_session requires expected_current_sha256'));
        return rules.probeNewSession(owner, input.target, input.expected_current_sha256, authorization, signal);
      }
      if (input.operation === 'probe_status') {
        if (input.probe_id === undefined) return err(appError('INVALID_INPUT', 'probe_status requires probe_id'));
        return rules.probeStatus(owner, input.probe_id, authorization, signal);
      }
      if (input.operation === 'backup_apply') {
        if (input.snapshot_id === undefined || input.workspaceId === undefined || input.source_path === undefined || input.source_sha256 === undefined || input.expected_old_sha256 === undefined) {
          return err(appError('INVALID_INPUT', 'backup_apply requires snapshot_id, workspaceId, source_path, expected_old_sha256, and source_sha256'));
        }
        if (context.services.file === undefined) return missingService();
        const source = await context.services.file.readFile(context.actor, input.workspaceId, { path: input.source_path }, authorization);
        if (!source.ok) return source;
        if (source.value.encoding !== undefined && source.value.encoding !== 'utf8') return err(appError('INVALID_INPUT', 'Rule source must be a UTF-8 workspace text file'));
        const bytes = Buffer.from(source.value.content, 'utf8');
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== input.source_sha256.toLowerCase()) return err(appError('CONFLICT', 'Workspace source changed or does not match declared SHA-256'));
        return rules.backupApply(owner, input.snapshot_id, input.expected_old_sha256, bytes, input.source_sha256, authorization, signal);
      }
      if (input.backup_id === undefined || input.expected_current_sha256 === undefined) return err(appError('INVALID_INPUT', 'rollback requires backup_id and expected_current_sha256'));
      return rules.rollback(owner, input.backup_id, input.expected_current_sha256, authorization, signal);
    },
  })];
}

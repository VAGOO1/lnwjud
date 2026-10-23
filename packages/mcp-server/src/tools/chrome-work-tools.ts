import { z } from 'zod';
import { ok } from '@lnwjud/domain';
import { truthfulUnavailable } from '../tool-delivery-contract.js';
import { domCdpCapabilitySchema } from './schemas.js';
import { defineTool, type McpToolContext, type McpToolDefinition } from './tool-types.js';

const prepareSchema = z.object({ workspaceId: z.string().trim().min(1).max(256), tab_id: z.string().trim().min(1).max(256), pageUrl: z.string().trim().url().max(4096), idempotencyKey: z.string().trim().min(1).max(256), requests: z.array(domCdpCapabilitySchema).min(1).max(100) }).strict();
const statusSchema = z.object({ workspaceId: z.string().trim().min(1).max(256), primaryWorkId: z.string().trim().min(1).max(256), continuityToken: z.string().trim().min(1).max(4096).optional() }).strict();
const reconnectSchema = z.object({ workspaceId: z.string().trim().min(1).max(256), primaryWorkId: z.string().trim().min(1).max(256), continuityToken: z.string().trim().min(1).max(4096), expectedConnectionRevision: z.number().int().nonnegative() }).strict();

const extendSchema = prepareSchema.extend({ primaryWorkId: z.string().trim().min(1).max(256), continuityToken: z.string().trim().min(1).max(4096), expectedConnectionRevision: z.number().int().positive(), expectedBudgetRevision: z.number().int().positive(), expectedContinuationRevision: z.number().int().nonnegative() }).strict();

export function chromeWorkTools(context: McpToolContext): McpToolDefinition[] {
  return [
      defineTool({ name: 'chrome_work_prepare', description: 'Prepare an inert host-owned Chrome work proposal from exact validated dom_cdp requests. It never opens Chrome, asks for approval, or dispatches a browser action; Desktop must review it.', permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, inputSchema: prepareSchema,
        handler: async (input, signal) => { const service = context.services.chromeWork; const prepare = context.registryRuntime?.prepareChromeWorkPlan; if (service === undefined || prepare === undefined) return ok(truthfulUnavailable('chrome_work_prepare', 'needs_setup', ['Desktop Chrome approval host and selected Active Project'])); const plan = await prepare(input, signal); return plan.ok ? service.prepare(context.actor, plan.value, signal) : plan; } }),
    defineTool({ name: 'chrome_work_extend', description: 'Propose exact newly known phases for the SAME Chrome work and retained three-window budget. Requires continuity token and current revisions. This atomically deactivates selection; Desktop must freshly review/select the work. Never dispatches or replays actions.', permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, inputSchema: extendSchema,
      handler: async (input, signal) => { const service = context.services.chromeWork; const prepare = context.registryRuntime?.prepareChromeWorkPlan; if (service?.extend === undefined || prepare === undefined) return ok(truthfulUnavailable('chrome_work_extend', 'needs_setup', ['Retained Desktop Chrome work and continuity token'])); const plan = await prepare(input, signal); return plan.ok ? service.extend(context.actor, input, plan.value, signal) : plan; } }),
    defineTool({ name: 'chrome_work_status', description: 'Read one host-owned Chrome work record. It does not select, resume, mutate, or create work. A new session may provide the existing opaque continuity token for authenticated status.', permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: statusSchema,
      handler: async (input, signal) => context.services.chromeWork?.status(context.actor, input, signal) ?? ok(truthfulUnavailable('chrome_work_status', 'needs_setup', ['Desktop Chrome approval host'])) }),
      defineTool({ name: 'chrome_work_reconnect', description: 'Reconnect an existing host-owned Chrome work record with its opaque continuity token and expected revision. It never replays browser actions.', permission: 'WRITE', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, inputSchema: reconnectSchema,
      handler: async (input, signal) => context.services.chromeWork?.reconnect(context.actor, input, signal) ?? ok(truthfulUnavailable('chrome_work_reconnect', 'needs_setup', ['Retained Desktop Chrome work and continuity token'])) }),
  ];
}

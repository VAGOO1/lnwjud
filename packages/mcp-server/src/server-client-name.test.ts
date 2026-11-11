import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { FileActor } from '@lnwjud/application';
import { ok } from '@lnwjud/domain';
import { ActivityTracker } from './activity-tracker.js';
import { createMcpServer } from './server.js';
import type { McpApplicationServices } from './tool-registry.js';

const actor: FileActor = { clientId: 'client-name-test', clientName: 'client-name-test', sessionId: 'client-name-session' };

describe('connected AI client label', () => {
  it('shows the name the client gave at connect time on its in-flight call', async () => {
    const tracker = new ActivityTracker();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const server = createMcpServer({
      services: { extensions: {
        callMcpTool: async () => { await gate; return ok({ content: [{ type: 'text', text: 'done' }] }); },
      } } as unknown as McpApplicationServices,
      actor,
      activityTracker: tracker,
      authorizationModeProvider: () => 'full_bypass',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'Gemini CLI test', version: '9.9.9' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const pending = client.callTool({ name: 'mcp_call', arguments: { server: 'mock', tool: 'slow', userConfirmed: true } });
      for (let i = 0; i < 100 && tracker.listInFlight().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      const inflight = tracker.listInFlight();
      expect(inflight.length).toBeGreaterThan(0);
      expect(inflight.every((item) => item.clientName === 'Gemini CLI test')).toBe(true);
      release();
      await pending;
      expect(tracker.listInFlight()).toHaveLength(0);
    } finally {
      release();
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

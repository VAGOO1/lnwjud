import { describe, expect, it } from 'vitest';
import { ActivityTracker, boundedClientName, CLIENT_NAME_MAX_LENGTH, type ActivitySinkEvent } from './activity-tracker.js';

describe('client name label', () => {
  it('cleans control characters, collapses spaces and bounds length', () => {
    expect(boundedClientName('  Claude\u0000 \n Desktop  ')).toBe('Claude Desktop');
    expect(boundedClientName('x'.repeat(500))).toHaveLength(CLIENT_NAME_MAX_LENGTH);
    expect(boundedClientName('   ')).toBeUndefined();
    expect(boundedClientName(42)).toBeUndefined();
    expect(boundedClientName(undefined)).toBeUndefined();
  });

  it('exposes the label on in-flight calls but never copies it into sink events', async () => {
    const events: ActivitySinkEvent[] = [];
    const tracker = new ActivityTracker({ record: async (event: ActivitySinkEvent): Promise<void> => { events.push(event); } });
    const callId = await tracker.begin('read_file', { path: 'a.txt' }, { sessionId: 's1', clientName: 'openai-mcp' });
    const [entry] = tracker.listInFlight();
    expect(entry?.clientName).toBe('openai-mcp');
    expect(JSON.stringify(events)).not.toContain('openai-mcp');
    await tracker.end(callId, 'SUCCESS', 3);
    expect(JSON.stringify(events)).not.toContain('openai-mcp');
  });

  it('leaves the label absent when the client never identified itself', async () => {
    const tracker = new ActivityTracker();
    await tracker.begin('read_file', { path: 'a.txt' }, { sessionId: 's1' });
    expect(tracker.listInFlight()[0]?.clientName).toBeUndefined();
  });
});

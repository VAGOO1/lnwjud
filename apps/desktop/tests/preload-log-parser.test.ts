import { describe, expect, it } from 'vitest';
import { parseLogCorrelation } from '../src/preload/log-parser.js';

describe('preload log correlation parser', () => {
  it.each(['ttl_expired', 'stdio_stopped', 'transport_stopped', 'transport_live', 'other'] as const)('preserves allowlisted tunnel lifecycle %s', (lifecycle) => {
    expect(parseLogCorrelation({ kind: 'tunnel', lifecycle, instanceId: 'instance', requestId: 'request', pid: 42 }))
      .toEqual({ kind: 'tunnel', lifecycle, instanceId: 'instance', requestId: 'request', pid: 42 });
  });

  it('drops an unknown lifecycle without dropping otherwise valid tunnel correlation', () => {
    expect(parseLogCorrelation({ kind: 'tunnel', lifecycle: 'secret-future-value', instanceId: 'instance' }))
      .toEqual({ kind: 'tunnel', instanceId: 'instance' });
  });
});

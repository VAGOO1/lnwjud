import { describe, expect, it } from 'vitest';
import {
  buildTunnelOAuthAuthorizationUrl,
  createTunnelOAuthLoginTransaction,
  parseTunnelOAuthCallback,
  type TunnelOAuthProviderDescriptor,
} from '../src/main/tunnel-oauth-core.js';

const provider: TunnelOAuthProviderDescriptor = {
  id: 'fixture',
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  clientId: 'desktop-client',
  scopes: ['openid', 'profile'],
  enabled: true,
  supportsTunnelProvisioning: true,
};

describe('tunnel OAuth PKCE flow', () => {
  it('creates S256 PKCE and an authorization URL without embedding the verifier', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const transaction = createTunnelOAuthLoginTransaction('http://127.0.0.1:49152/oauth/callback', now);
    expect(transaction.state.length).toBeGreaterThan(30);
    expect(transaction.verifier.length).toBeGreaterThan(43);
    expect(transaction.challenge).not.toBe(transaction.verifier);

    const url = new URL(buildTunnelOAuthAuthorizationUrl(provider, transaction));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe(transaction.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(transaction.challenge);
    expect(url.toString()).not.toContain(transaction.verifier);
  });

  it('accepts only the exact loopback callback, state, and live transaction', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const transaction = createTunnelOAuthLoginTransaction('http://127.0.0.1:49152/oauth/callback', now);
    const callback = `http://127.0.0.1:49152/oauth/callback?code=fixture-code&state=${encodeURIComponent(transaction.state)}`;
    expect(parseTunnelOAuthCallback(callback, transaction, new Date('2026-09-01T00:01:00.000Z'))).toEqual({
      code: 'fixture-code', state: transaction.state,
    });
    expect(() => parseTunnelOAuthCallback(callback.replace(transaction.state, 'wrong'), transaction, now)).toThrow('state mismatch');
    expect(() => parseTunnelOAuthCallback(callback.replace('/oauth/callback', '/other'), transaction, now)).toThrow('redirect URI');
    expect(() => parseTunnelOAuthCallback(callback, transaction, new Date('2026-09-01T00:06:00.000Z'))).toThrow('expired');
  });

  it('fails closed for unsupported provisioning and non-loopback/insecure provider endpoints', () => {
    const transaction = createTunnelOAuthLoginTransaction('http://localhost:49152/oauth/callback');
    expect(() => buildTunnelOAuthAuthorizationUrl({ ...provider, supportsTunnelProvisioning: false }, transaction)).toThrow('not available');
    expect(() => buildTunnelOAuthAuthorizationUrl({ ...provider, authorizationEndpoint: 'http://auth.example.test/authorize' }, transaction)).toThrow('HTTPS');
    expect(() => createTunnelOAuthLoginTransaction('https://example.test/oauth/callback')).toThrow('loopback');
  });
});

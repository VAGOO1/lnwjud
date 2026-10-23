import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface TunnelOAuthProviderDescriptor {
  readonly id: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly enabled: boolean;
  readonly supportsTunnelProvisioning: boolean;
}

export interface TunnelOAuthLoginTransaction {
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface TunnelOAuthCallback {
  readonly code: string;
  readonly state: string;
}

const PKCE_VERIFIER_BYTES = 48;
const STATE_BYTES = 32;
const DEFAULT_TRANSACTION_TTL_MS = 5 * 60_000;

export function createTunnelOAuthLoginTransaction(
  redirectUri: string,
  now = new Date(),
  ttlMs = DEFAULT_TRANSACTION_TTL_MS,
): TunnelOAuthLoginTransaction {
  assertLoopbackRedirectUri(redirectUri);
  const verifier = base64Url(randomBytes(PKCE_VERIFIER_BYTES));
  const state = base64Url(randomBytes(STATE_BYTES));
  const challenge = base64Url(createHash('sha256').update(verifier, 'ascii').digest());
  const safeTtl = Math.max(30_000, Math.min(15 * 60_000, ttlMs));
  return {
    state,
    verifier,
    challenge,
    redirectUri,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + safeTtl).toISOString(),
  };
}

export function buildTunnelOAuthAuthorizationUrl(
  provider: TunnelOAuthProviderDescriptor,
  transaction: TunnelOAuthLoginTransaction,
): string {
  assertProviderDescriptor(provider);
  if (!provider.enabled || !provider.supportsTunnelProvisioning) {
    throw new Error('Tunnel OAuth provisioning is not available from this provider');
  }
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', transaction.redirectUri);
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', transaction.state);
  url.searchParams.set('code_challenge', transaction.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function parseTunnelOAuthCallback(
  callbackUrl: string,
  transaction: TunnelOAuthLoginTransaction,
  now = new Date(),
): TunnelOAuthCallback {
  const expected = new URL(transaction.redirectUri);
  const actual = new URL(callbackUrl);
  if (actual.protocol !== expected.protocol || actual.hostname !== expected.hostname || actual.port !== expected.port || actual.pathname !== expected.pathname) {
    throw new Error('OAuth callback redirect URI does not match the active login transaction');
  }
  if (now.getTime() > Date.parse(transaction.expiresAt)) throw new Error('OAuth login transaction expired');
  const error = actual.searchParams.get('error');
  if (error !== null) throw new Error(`OAuth authorization failed: ${error}`);
  const code = actual.searchParams.get('code')?.trim() ?? '';
  const state = actual.searchParams.get('state')?.trim() ?? '';
  if (code.length === 0) throw new Error('OAuth callback is missing authorization code');
  if (!safeStringEqual(state, transaction.state)) throw new Error('OAuth callback state mismatch');
  return { code, state };
}

export function assertProviderDescriptor(provider: TunnelOAuthProviderDescriptor): void {
  if (provider.id.trim().length === 0) throw new Error('OAuth provider id is required');
  if (provider.clientId.trim().length === 0) throw new Error('OAuth client id is required');
  for (const endpoint of [provider.authorizationEndpoint, provider.tokenEndpoint]) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('OAuth provider endpoints must use HTTPS');
    if (url.username.length > 0 || url.password.length > 0) throw new Error('OAuth provider endpoint must not contain credentials');
  }
}

export function assertLoopbackRedirectUri(redirectUri: string): void {
  const url = new URL(redirectUri);
  if (url.protocol !== 'http:') throw new Error('Desktop OAuth loopback redirect must use HTTP');
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    throw new Error('Desktop OAuth redirect must be loopback-only');
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new Error('Desktop OAuth redirect URI is invalid');
  }
}

function safeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

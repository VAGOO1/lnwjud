import { createHash } from 'node:crypto';
export type { HostMutationApprovalContext, HostMutationApprovalRequest } from './tool-registry.js';

export interface HostApprovalInvocation {
  readonly callId: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
  readonly inputDigest: string;
}

/** In-process host proof. JSON fields, headers and trace IDs cannot mint it. */
export interface HostApprovalInvocationProof { readonly hostInvocation: true; }
const proofs = new WeakMap<HostApprovalInvocationProof, Readonly<HostApprovalInvocation>>();

/** Host denial with a durable stop reason, never an approval or replay authority. */
export class HostApprovalStop extends Error {
  public constructor(public readonly hostWorkId: string, public readonly reason: string) {
    super(`Host approval job stopped: ${reason}; do not retry this job automatically`);
    this.name = 'HostApprovalStop';
  }
}

/** Host-internal entry point; never exposed as an MCP tool or input field. */
export function createHostApprovalInvocation(value: HostApprovalInvocation): HostApprovalInvocationProof {
  for (const part of [value.callId, value.clientId, value.sessionId]) {
    if (typeof part !== 'string' || !part.trim() || part.length > 512) throw new Error('Invalid host invocation identity');
  }
  if (!/^[a-f0-9]{64}$/u.test(value.inputDigest)) throw new Error('Invalid host invocation digest');
  const proof = Object.freeze({ hostInvocation: true as const });
  proofs.set(proof, Object.freeze({ ...value }));
  return proof;
}

export function readHostApprovalInvocation(value: unknown): Readonly<HostApprovalInvocation> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return proofs.get(value as HostApprovalInvocationProof);
}

/** Exact validated JSON input, independent of key ordering; not a redacted display summary. */
export function hostApprovalInputDigest(toolName: string, input: unknown): string {
  const snapshot: unknown = JSON.parse(JSON.stringify(input));
  return createHash('sha256').update(canonical([toolName, snapshot])).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type AgentSwarmState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'termination_unverified';
export type AgentSwarmTaskState = 'blocked' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'termination_unverified';

export interface AgentSwarmTaskRecord {
  readonly id: string;
  readonly promptDigest: string;
  readonly promptLength: number;
  readonly dependsOn: readonly string[];
  readonly state: AgentSwarmTaskState;
  readonly codexTaskId?: string;
  readonly resultText: string;
  readonly outputTruncated: boolean;
  readonly error?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface AgentSwarmRecord {
  readonly id: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly maxConcurrency: number;
  readonly state: AgentSwarmState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tasks: readonly AgentSwarmTaskRecord[];
}

export interface CreateAgentSwarmRecord {
  readonly id: string;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly maxConcurrency: number;
  readonly createdAt: string;
  readonly tasks: readonly {
    readonly id: string;
    readonly promptDigest: string;
    readonly promptLength: number;
    readonly dependsOn: readonly string[];
    readonly state: AgentSwarmTaskState;
  }[];
}

export interface AgentSwarmTaskUpdate {
  readonly state?: AgentSwarmTaskState;
  readonly codexTaskId?: string | null;
  readonly resultText?: string;
  readonly outputTruncated?: boolean;
  readonly error?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

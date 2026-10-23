export type EngineeringTaskKind =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'review'
  | 'incident'
  | 'release'
  | 'maintenance'
  | 'docs'
  | 'unknown';

export type EngineeringRiskTier = 'low' | 'medium' | 'high' | 'critical';

export type EngineeringDeliveryScope =
  | 'local'
  | 'commit'
  | 'push'
  | 'pull_request'
  | 'merge'
  | 'release'
  | 'deploy';

export type EngineeringGateStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'not_applicable'
  | 'stale';

export type EngineeringGateEvidenceSource = 'host_observed' | 'user_attested';

export interface EngineeringGateEvidence {
  readonly source: EngineeringGateEvidenceSource;
  readonly observedAt: string;
  readonly workspaceId: string;
  readonly commit?: string;
  readonly command?: string;
  readonly runId?: string;
  readonly exitCode?: number;
  readonly conclusion?: string;
  readonly artifact?: string;
}

export interface EngineeringGateDefinition {
  readonly id: string;
  readonly title: string;
  readonly applicability: 'required' | 'optional' | 'not_applicable';
  readonly status: EngineeringGateStatus;
  readonly reason: string;
  readonly basedOnUserIntentRevision: number;
  readonly checkCommand?: string;
  readonly requiredPlatforms?: readonly ('win32' | 'darwin' | 'linux')[];
  readonly evidence?: EngineeringGateEvidence;
}

/** Required proof gates cannot be dismissed by a free-form reason. */
export function mayMarkEngineeringGateNotApplicable(gate: EngineeringGateDefinition): boolean {
  return gate.applicability !== 'required' || gate.id === 'docs_impact' || gate.id === 'independent_review';
}

const HOST_OBSERVED_GATE_IDS = new Set(['diff', 'focused_validation', 'integration', 'restart_persistence', 'architecture', 'cross_platform', 'exact_sha_ci', 'package']);

export function requiresHostObservedEngineeringEvidence(gateId: string): boolean {
  return HOST_OBSERVED_GATE_IDS.has(gateId);
}

/**
 * Minimal Engineering Harness projection stored on the existing durable goal.
 * Goal plan, acceptance criteria, evidence, checkpoints, leases, and intent
 * revision remain authoritative in their existing fields.
 */
export type EngineeringReviewFindingSeverity = 'blocking' | 'non_blocking';
export type EngineeringReviewFindingState = 'open' | 'validated' | 'rejected' | 'resolved';

export interface EngineeringReviewFinding {
  readonly id: string;
  readonly title: string;
  readonly severity: EngineeringReviewFindingSeverity;
  readonly state: EngineeringReviewFindingState;
  readonly reason: string;
  readonly source?: string;
}

export interface EngineeringGoalMetadata {
  readonly schemaVersion: 1;
  readonly primaryTaskKind: EngineeringTaskKind;
  readonly riskTier: EngineeringRiskTier;
  readonly policyDigest: string;
  readonly deliveryScope: EngineeringDeliveryScope;
  readonly scopedPath?: string;
  readonly gates: readonly EngineeringGateDefinition[];
  readonly reviewFindings?: readonly EngineeringReviewFinding[];
}

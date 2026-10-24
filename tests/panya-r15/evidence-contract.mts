/**
 * PANYA R15 — standalone observation review, synthetic contract only.
 * A raw JSON claim (even one shaped like native output) is NOT Host attestation.
 * Always fail closed without a separately authenticated original process,
 * boot, Job and per-marker ownership binding. No mutation API is exposed.
 */
export interface R15Review {
  readonly mode: 'R15_STAGING_CONTRACT_ONLY';
  readonly status: 'HOLD';
  readonly observation: string;
  readonly reason: string;
  readonly nativeReceiptVerified: false;
  readonly canMutateHost: false;
  readonly canReleaseReservation: false;
}
function hold(observation: string, reason: string): R15Review {
  return { mode: 'R15_STAGING_CONTRACT_ONLY', status: 'HOLD', observation, reason,
    nativeReceiptVerified: false, canMutateHost: false, canReleaseReservation: false };
}
function obj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export function reviewR15Observation(raw: unknown): R15Review {
  if (typeof raw !== 'string' || raw.length < 2 || raw.length > 4096)
    return hold('UNKNOWN', 'INVALID_OR_OVERSIZED_JSON');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return hold('UNKNOWN', 'MALFORMED_JSON'); }
  try { if (JSON.stringify(parsed) !== raw) return hold('UNKNOWN', 'NONCANONICAL_OR_DUPLICATE_KEYS'); }
  catch { return hold('UNKNOWN', 'CANONICALIZATION_FAILED'); }
  if (!obj(parsed) || parsed.mode !== 'R15_WINDOWS_STAGING_CURRENT_OBSERVATION_ONLY' ||
      parsed.provenance !== 'WIN32_OPENPROCESS_GETPROCESSTIMES' ||
      typeof parsed.targetPid !== 'number' || !Number.isSafeInteger(parsed.targetPid) || parsed.targetPid <= 0 ||
      parsed.bootIdentity !== 'UNATTESTED_NO_UNIQUE_BOOT_ID' ||
      parsed.jobOrigin !== 'UNKNOWN_NO_EXACT_JOB_HANDLE' ||
      parsed.originalBinding !== 'UNKNOWN_NO_ORIGINAL_BINDING' ||
      parsed.taskOutcome !== 'UNKNOWN_NO_TERMINAL_RECEIPT' ||
      parsed.canMutateHost !== false || parsed.canReleaseReservation !== false ||
      parsed.nativeReceiptVerified !== false) return hold('UNKNOWN','UNTRUSTED_OR_INVALID_SOURCE_CONTRACT');
  if (parsed.observation === 'PROCESS_OBJECT_OBSERVED_AT_QUERY') {
    if (typeof parsed.kernelCreationFiletimeUtcTicks !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(parsed.kernelCreationFiletimeUtcTicks) ||
        typeof parsed.kernelCreationUtc !== 'string') return hold('UNKNOWN','CREATION_TIME_UNVERIFIED');
    return hold('PROCESS_OBJECT_OBSERVED_AT_QUERY','CURRENT_OBJECT_ONLY_NO_ORIGINAL_BINDING');
  }
  if (['NOT_OPENED_UNPROVEN','GET_TIMES_FAILED_UNPROVEN',
    'INVALID_FILETIME_UNPROVEN','INVALID_PID_UNPROVEN','UNSUPPORTED_OS_UNPROVEN'].includes(String(parsed.observation))) {
    return hold('NOT_PROVEN_CURRENT','NO_OPEN_HANDLE_DOES_NOT_PROVE_TASK_TERMINATED');
  }
  return hold('UNKNOWN','UNKNOWN_OBSERVATION');
}

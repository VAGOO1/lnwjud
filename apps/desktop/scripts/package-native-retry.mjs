/* global setTimeout */

const transientFailurePattern = /connection reset by peer|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|socket hang up|TLS handshake timeout|temporary failure in name resolution|Response code (?:500|502|503|504)\b/i;

export function isTransientElectronBuilderFailure(error) {
  const details = `${error?.message ?? ''}\n${error?.output ?? ''}`;
  return transientFailurePattern.test(details);
}

export async function runElectronBuilderWithRetry(operation, sleepFn = defaultSleep, onRetry = () => undefined) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt === 3 || !isTransientElectronBuilderFailure(error)) throw error;
      const delayMs = 1_000 * 2 ** (attempt - 1);
      onRetry({ attempt, nextAttempt: attempt + 1, delayMs, error });
      await sleepFn(delayMs);
    }
  }
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

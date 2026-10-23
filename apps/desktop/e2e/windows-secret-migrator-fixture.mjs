export function windowsSecretMigratorBuildTimeoutMs(ci) {
  return ci ? 300_000 : 120_000;
}

export function windowsSecretMigratorE2eTimeoutMs(ci) {
  return ci ? 420_000 : 180_000;
}

export async function buildWindowsSecretMigratorFixture({ execFile, powershell, scriptPath, env, ci }) {
  const timeout = windowsSecretMigratorBuildTimeoutMs(ci);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  try {
    return await execFile(powershell, args, { windowsHide: true, env, timeout });
  } catch (cause) {
    const error = cause ?? {};
    const stdout = tail(error.stdout);
    const stderr = tail(error.stderr);
    const metadata = [
      `timeoutMs=${timeout}`,
      `code=${error.code ?? 'unknown'}`,
      `signal=${error.signal ?? 'none'}`,
      `killed=${error.killed === true}`,
    ].join(' ');
    throw new Error(
      `Windows secret-migrator fixture build failed (${metadata})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause },
    );
  }
}

function tail(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.slice(-16_384);
}

// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// PANYA P1: source-only Host release pin; never populated from MCP or env.
// UNBUILT: the release pipeline must substitute an official, verified hash
// into the bundled TypeScript before any Native Helper execution is admitted.
import path from 'node:path';
import type { TrustedWindowsHelper } from './windows-contained-launch.js';

/**
 * Generated only by an independently authorized, reproducible native build.
 * An undefined pin DENIES Native Helper execution; it does not fall back to
 * WindowsPowerShell, an executable on PATH, or an uncontained process.
 */
export const WINDOWS_NATIVE_HELPER_RELEASE_SHA256: string | undefined = undefined;

export function hostTrustedWindowsHelper(
  resourcesPath: string | undefined,
  releaseSha256: string | undefined = WINDOWS_NATIVE_HELPER_RELEASE_SHA256,
): TrustedWindowsHelper | undefined {
  if (process.platform !== 'win32' || !resourcesPath ||
      !path.isAbsolute(resourcesPath) || !releaseSha256 ||
      !/^[a-f0-9]{64}$/i.test(releaseSha256)) return undefined;
  // Host must pin resourcesPath from its installed/package identity, not
  // from untrusted client inputs or repo-local staging paths.
  const trustedRoot = path.join(resourcesPath, 'windows-containment-helper');
  return {
    trustedRoot,
    executablePath: path.join(trustedRoot, 'lnwjud-windows-containment-helper.exe'),
    expectedSha256: releaseSha256.toLowerCase(),
  };
}

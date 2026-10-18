// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// PANYA R5B GitHub STAGING-ONLY Candidate pinned from R4 CI artifact 12122657241.
// Not a production release signature, Live permission or Host 5090 admission.
// This binary was verified independently against GitHub ZIP and provenance.
// No MCP input or environment override is accepted for the release pin.
import path from 'node:path';
import type { TrustedWindowsHelper } from './windows-contained-launch.js';

/**
 * R5B CI candidate: exact SHA-256 of the verified R4 Native Helper binary.
 * The packaged Host must independently bind its resourcesPath and verify
 * the executable's real hash before launch. This pin is NOT a signature,
 * production admission or authority to bypass any Host approval/gate.
 */
export const WINDOWS_NATIVE_HELPER_RELEASE_SHA256: string | undefined = 'c07f4c28c0d2e409c8b1d01c8368ab8d1b713e76250dea9a059337e3d083557d';

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

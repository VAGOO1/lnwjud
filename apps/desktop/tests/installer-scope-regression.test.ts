import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const builderConfig = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
const installerScript = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8');

describe('Windows installer scope regression', () => {
  it('keeps the historical per-user install mode selected by default', () => {
    expect(builderConfig).toContain('oneClick: false');
    expect(builderConfig).toContain('perMachine: false');
    expect(builderConfig).toContain('selectPerMachineByDefault: false');
    expect(builderConfig).not.toContain('selectPerMachineByDefault: true');
  });

  it('keeps silent update uninstall from waiting on the user-data prompt', () => {
    const silentGuard = installerScript.indexOf('IfSilent keepData 0');
    const prompt = installerScript.indexOf('MessageBox MB_YESNO|MB_ICONQUESTION');
    expect(silentGuard).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeGreaterThan(silentGuard);
  });
});

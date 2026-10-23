import { describe, expect, it } from 'vitest';
import { normalizeProjectProfile } from './ponytail-policy.js';
import { parseProjectEngineeringSettings, projectEngineeringSettings } from './engineering-policy.js';

describe('project Engineering Harness profile', () => {
  it('defaults to inherit without enabling the Harness', () => {
    expect(projectEngineeringSettings({})).toEqual({ mode: 'inherit', commands: {}, requiredPlatforms: [] });
  });

  it('parses bounded project checks while preserving unrelated profile keys', () => {
    const normalized = normalizeProjectProfile({
      ponytail: { mode: 'lite' },
      project: { language: 'typescript' },
      engineering: {
        mode: 'inherit',
        profile: 'strict',
        commands: { test: 'corepack pnpm@10.15.0 test' },
        architecture: { checkCommand: 'corepack pnpm@10.15.0 lint' },
        requiredPlatforms: ['win32', 'darwin', 'linux'],
      },
    });

    expect(normalized).toMatchObject({ ponytail: { mode: 'lite' }, project: { language: 'typescript' } });
    expect(projectEngineeringSettings(normalized)).toEqual({
      mode: 'inherit',
      profile: 'strict',
      commands: { test: 'corepack pnpm@10.15.0 test' },
      architecture: { checkCommand: 'corepack pnpm@10.15.0 lint' },
      requiredPlatforms: ['win32', 'darwin', 'linux'],
    });
  });

  it('accepts repository off but rejects repository on and malformed policy fields', () => {
    expect(parseProjectEngineeringSettings({ mode: 'off' })).toEqual({ mode: 'off', commands: {}, requiredPlatforms: [] });
    expect(() => parseProjectEngineeringSettings({ mode: 'on' })).toThrow(/inherit or off/i);
    expect(() => parseProjectEngineeringSettings({ mode: 'inherit', profile: 'custom' })).toThrow(/standard, senior, or strict/i);
    expect(() => parseProjectEngineeringSettings({ mode: 'inherit', unknown: true })).toThrow(/unknown field/i);
    expect(() => parseProjectEngineeringSettings({ mode: 'inherit', commands: { test: 'x'.repeat(4097) } })).toThrow(/bounded command/i);
    expect(() => parseProjectEngineeringSettings({ mode: 'inherit', requiredPlatforms: ['freebsd'] })).toThrow(/unsupported platform/i);
  });

  it('keeps the existing project-profile secret rejection in front of Engineering policy', () => {
    expect(() => normalizeProjectProfile({ engineering: { commands: { test: 'ok' }, apiKey: 'must-not-persist' } })).toThrow(/secret-bearing field/i);
  });
});

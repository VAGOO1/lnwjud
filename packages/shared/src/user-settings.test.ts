import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENGINEERING_HARNESS_SETTINGS,
  DEFAULT_RECOVERY_RETENTION_DAYS,
  parseEngineeringHarnessSettings,
  parseEngineeringHarnessWorkspaceOverrides,
  serializeEngineeringHarnessWorkspaceOverrides,
  parseIntegerSetting,
  parseMcpAllowedHostnames,
  serializeEngineeringHarnessSettings,
} from './user-settings.js';

describe('MCP Host allow-list settings', () => {
  it('keeps only explicit hostname values and rejects URLs, ports, and wildcards', () => {
    expect(parseMcpAllowedHostnames('Example.Ngrok-Free.Dev;example.ngrok-free.dev;https://evil.example;evil.example:443;*.example.com;[::1]'))
      .toEqual(['example.ngrok-free.dev', '[::1]']);
  });
});

describe('recovery retention defaults', () => {
  it('uses 30 days only when retention has never been configured', () => {
    const missingStoredValue: string | null = null;
    expect(parseIntegerSetting(missingStoredValue ?? undefined, DEFAULT_RECOVERY_RETENTION_DAYS, 0, 3650)).toBe(30);
    expect(parseIntegerSetting('0', DEFAULT_RECOVERY_RETENTION_DAYS, 0, 3650)).toBe(0);
    expect(parseIntegerSetting('90', DEFAULT_RECOVERY_RETENTION_DAYS, 0, 3650)).toBe(90);
  });
});

describe('Engineering Harness settings', () => {
  it('defaults missing settings to OFF with the Senior coding-project preset', () => {
    expect(parseEngineeringHarnessSettings(null)).toEqual({
      settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS,
      diagnostic: null,
    });
  });

  it('round-trips a valid custom opt-in', () => {
    const expected = {
      schemaVersion: 1 as const,
      enabled: true,
      profile: 'custom' as const,
      applyTo: 'all_workspaces' as const,
      autoProjectAssessment: false,
      custom: {
        analysis: 'cross_file' as const,
        review: 'always' as const,
        validation: 'strict' as const,
        docsImpactCheck: true,
      },
    };
    expect(parseEngineeringHarnessSettings(serializeEngineeringHarnessSettings(expected))).toEqual({
      settings: expected,
      diagnostic: null,
    });
  });

  it('round-trips bounded workspace user overrides and fails closed for malformed maps', () => {
    const expected = {
      'workspace-a': { mode: 'off' as const },
      'workspace-b': { mode: 'on' as const, profile: 'strict' as const },
    };
    expect(parseEngineeringHarnessWorkspaceOverrides(serializeEngineeringHarnessWorkspaceOverrides(expected))).toEqual(expected);
    expect(parseEngineeringHarnessWorkspaceOverrides('{')).toEqual({});
    expect(parseEngineeringHarnessWorkspaceOverrides(JSON.stringify({ 'workspace-a': { mode: 'inherit' } }))).toEqual({});
    expect(parseEngineeringHarnessWorkspaceOverrides(JSON.stringify({ 'workspace-a': { mode: 'on', extra: true } }))).toEqual({});
  });

  it('fails closed to OFF for malformed, unknown, future-version, and oversized values', () => {
    const invalidCases = [
      ['{', 'invalid_json'],
      [JSON.stringify({ schemaVersion: 1, enabled: true, profile: 'expert', applyTo: 'coding_projects', autoProjectAssessment: true }), 'invalid_shape'],
      [JSON.stringify({ schemaVersion: 2, enabled: true, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true }), 'unsupported_schema_version'],
      [JSON.stringify({ schemaVersion: 1, enabled: true, profile: 'senior', applyTo: 'coding_projects', autoProjectAssessment: true, extra: 'x' }), 'invalid_shape'],
      ['x'.repeat(16 * 1024 + 1), 'invalid_shape'],
    ] as const;

    for (const [raw, diagnostic] of invalidCases) {
      expect(parseEngineeringHarnessSettings(raw)).toEqual({
        settings: DEFAULT_ENGINEERING_HARNESS_SETTINGS,
        diagnostic,
      });
    }
  });
});

import type { EngineeringProfile } from './user-settings.js';

export type ProjectEngineeringMode = 'inherit' | 'off';
export type ProjectEngineeringProfile = Exclude<EngineeringProfile, 'custom'>;
export type EngineeringCommandKind = 'dev' | 'test' | 'lint' | 'typecheck' | 'build';
export type EngineeringRequiredPlatform = 'win32' | 'darwin' | 'linux';

export interface ProjectEngineeringSettings {
  readonly mode: ProjectEngineeringMode;
  readonly profile?: ProjectEngineeringProfile;
  readonly commands: Readonly<Partial<Record<EngineeringCommandKind, string>>>;
  readonly architecture?: {
    readonly checkCommand: string;
  };
  readonly requiredPlatforms: readonly EngineeringRequiredPlatform[];
}

export function projectEngineeringSettings(profile: unknown): ProjectEngineeringSettings {
  if (!isRecord(profile) || profile.engineering === undefined) {
    return { mode: 'inherit', commands: {}, requiredPlatforms: [] };
  }
  return parseProjectEngineeringSettings(profile.engineering);
}

export function parseProjectEngineeringSettings(value: unknown): ProjectEngineeringSettings {
  if (!isRecord(value)) throw new Error('Project profile engineering must be an object');
  assertOnlyKeys(value, ['mode', 'profile', 'commands', 'architecture', 'requiredPlatforms'], 'engineering');

  const mode = value.mode ?? 'inherit';
  if (mode !== 'inherit' && mode !== 'off') throw new Error('Project profile engineering.mode must be inherit or off');

  const profile = value.profile;
  if (profile !== undefined && profile !== 'standard' && profile !== 'senior' && profile !== 'strict') {
    throw new Error('Project profile engineering.profile must be standard, senior, or strict');
  }

  const commands = parseCommands(value.commands);
  const architecture = parseArchitecture(value.architecture);
  const requiredPlatforms = parseRequiredPlatforms(value.requiredPlatforms);
  return {
    mode,
    ...(profile === undefined ? {} : { profile }),
    commands,
    ...(architecture === undefined ? {} : { architecture }),
    requiredPlatforms,
  };
}

function parseCommands(value: unknown): ProjectEngineeringSettings['commands'] {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('Project profile engineering.commands must be an object');
  assertOnlyKeys(value, ['dev', 'test', 'lint', 'typecheck', 'build'], 'engineering.commands');
  const result: Partial<Record<EngineeringCommandKind, string>> = {};
  for (const kind of ['dev', 'test', 'lint', 'typecheck', 'build'] as const) {
    const command = value[kind];
    if (command === undefined) continue;
    result[kind] = boundedCommand(command, `engineering.commands.${kind}`);
  }
  return result;
}

function parseArchitecture(value: unknown): ProjectEngineeringSettings['architecture'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Project profile engineering.architecture must be an object');
  assertOnlyKeys(value, ['checkCommand'], 'engineering.architecture');
  const checkCommand = boundedCommand(value.checkCommand, 'engineering.architecture.checkCommand');
  if (checkCommand.length > 2048) throw new Error('Project profile engineering.architecture.checkCommand exceeds the evidence command limit');
  return { checkCommand };
}

function parseRequiredPlatforms(value: unknown): readonly EngineeringRequiredPlatform[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) throw new Error('Project profile engineering.requiredPlatforms must be a bounded array');
  const result = new Set<EngineeringRequiredPlatform>();
  for (const platform of value) {
    if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
      throw new Error('Project profile engineering.requiredPlatforms contains an unsupported platform');
    }
    result.add(platform);
  }
  return [...result];
}

function boundedCommand(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096 || value.includes('\0')) {
    throw new Error(`Project profile ${field} must be a non-empty bounded command`);
  }
  return value.trim();
}

function assertOnlyKeys(value: Readonly<Record<string, unknown>>, allowedKeys: readonly string[], field: string): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`Project profile ${field} contains unknown field: ${unknown}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

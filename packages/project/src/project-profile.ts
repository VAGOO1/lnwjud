export type ProjectKind = 'node' | 'python' | 'rust' | 'go' | 'php' | 'java' | 'dotnet' | 'unknown';
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';
export type ProjectFramework = 'react' | 'typescript' | 'vite';
export type ProjectCommandKind = 'dev' | 'test' | 'lint' | 'typecheck' | 'build';
export type ProjectDetectionConfidence = 'strong' | 'medium' | 'weak' | 'none';

export interface ProjectProfile {
  readonly rootPath: string;
  readonly kind: ProjectKind;
  readonly packageManager: PackageManager;
  readonly frameworks: readonly ProjectFramework[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly configFiles: readonly string[];
  readonly confidence: ProjectDetectionConfidence;
  readonly detectedFiles: readonly string[];
  readonly platforms: readonly Exclude<ProjectKind, 'unknown'>[];
  /** Manifest-derived candidates only. Callers must still route execution through normal permissions. */
  readonly suggestedCommands: Readonly<Partial<Record<ProjectCommandKind, string>>>;
}

export function wantsMcpStdio(argv: readonly string[]): boolean {
  return argv.includes('--mcp-stdio');
}

export function shouldHoldSingleInstanceLock(argv: readonly string[]): boolean {
  return !wantsMcpStdio(argv);
}

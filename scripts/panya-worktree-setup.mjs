import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const expectedNodeMajor = 24;
const expectedPackageManager = 'pnpm@10.15.0';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argumentsList = process.argv.slice(2);

if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
  printUsage();
  process.exit(0);
}

const unsupportedArguments = argumentsList.filter((argument) => argument !== '--offline');
if (unsupportedArguments.length > 0) {
  throw new Error(`Unsupported argument(s): ${unsupportedArguments.join(', ')}. Use --offline or --help.`);
}

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor !== expectedNodeMajor) {
  throw new Error(`Node ${expectedNodeMajor}.x is required; current runtime is ${process.version}.`);
}

const packageJsonPath = path.join(repositoryRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
if (packageJson.packageManager !== expectedPackageManager) {
  throw new Error(`package.json must pin ${expectedPackageManager}; found ${JSON.stringify(packageJson.packageManager)}.`);
}

const pnpmArguments = [expectedPackageManager, 'install', '--frozen-lockfile', '--ignore-scripts'];
if (argumentsList.includes('--offline')) pnpmArguments.push('--offline');

process.stdout.write(`Installing locked workspace dependencies with ${expectedPackageManager}${argumentsList.includes('--offline') ? ' (offline)' : ''}.\n`);
await runCorepack(pnpmArguments);
process.stdout.write('Dependency setup completed. No build, application launch, deploy, browser, or 5090 network action was performed.\n');

function printUsage() {
  process.stdout.write([
    'Usage: node scripts/panya-worktree-setup.mjs [--offline]',
    '',
    'Requires Node 24.x and packageManager pnpm@10.15.0.',
    'Runs: corepack pnpm@10.15.0 install --frozen-lockfile --ignore-scripts',
    'Use --offline only when the required package cache is already available.',
    '',
  ].join('\n'));
}

function runCorepack(args) {
  const windows = process.platform === 'win32';
  const command = windows ? 'cmd.exe' : 'corepack';
  // All arguments are fixed above; no user-supplied text reaches the shell.
  const spawnArgs = windows ? ['/d', '/s', '/c', `corepack ${args.join(' ')}`] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.once('error', (error) => reject(new Error(`Could not start Corepack: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Corepack exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}.`));
    });
  });
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const bridgeFileName = 'windows-capability-bridge.ps1';
const defaultSourcePath = path.join(repositoryRoot, 'packages', 'capabilities', 'src', bridgeFileName);
const defaultStageDirectory = path.join(desktopRoot, 'build', 'capability-bridge');
const defaultGeneratedOutput = path.join(repositoryRoot, 'packages', 'capabilities', 'src', 'windows-capability-integrity.generated.ts');
const defaultPackagedBridgePath = path.join(desktopRoot, 'dist', 'installers', 'win-unpacked', 'resources', bridgeFileName);
const defaultCompiledBundlePath = path.join(desktopRoot, 'dist', 'main', 'main.js');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(`Windows capability bridge verification failed: ${message}`);
}

function parseDescriptor(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`integrity descriptor is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('integrity descriptor must be an object');
  if (value.schemaVersion !== 1) fail('integrity descriptor schemaVersion must be 1');
  if (value.fileName !== bridgeFileName) fail(`integrity descriptor fileName must be ${bridgeFileName}`);
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1) fail('integrity descriptor sizeBytes must be a positive safe integer');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) fail('integrity descriptor sha256 must be a lowercase SHA-256 digest');
  return value;
}

function readGeneratedExpectation(text) {
  const shaMatch = text.match(/WINDOWS_CAPABILITY_BRIDGE_SHA256\s*=\s*'([0-9a-f]{64})'/);
  const sizeMatch = text.match(/WINDOWS_CAPABILITY_BRIDGE_SIZE_BYTES\s*=\s*(\d+)/);
  if (shaMatch === null) fail('generated compiled expectation is missing the bridge sha256');
  if (sizeMatch === null) fail('generated compiled expectation is missing the bridge byte count');
  return { sha256: shaMatch[1], sizeBytes: Number.parseInt(sizeMatch[1], 10) };
}

export async function verifyCapabilityBridgeArtifacts({
  sourcePath = defaultSourcePath,
  stageDirectory = defaultStageDirectory,
  generatedOutput = defaultGeneratedOutput,
  packagedBridgePath,
  compiledBundlePath,
  compiledExpectationSha256,
  compiledExpectationSizeBytes,
} = {}) {
  const stagedBridgePath = path.join(stageDirectory, bridgeFileName);
  const [sourceBytes, stagedBytes, manifest, descriptorText, generatedText] = await Promise.all([
    readFile(sourcePath),
    readFile(stagedBridgePath),
    readFile(path.join(stageDirectory, 'windows-capability-bridge.sha256'), 'utf8'),
    readFile(path.join(stageDirectory, 'windows-capability-bridge.integrity.json'), 'utf8'),
    readFile(generatedOutput, 'utf8'),
  ]);
  const descriptor = parseDescriptor(descriptorText);
  const stagedIdentity = { fileName: bridgeFileName, sizeBytes: stagedBytes.byteLength, sha256: sha256(stagedBytes) };

  if (!sourceBytes.equals(stagedBytes)) fail('source bytes differ from staged package bytes');
  if (descriptor.sizeBytes !== stagedIdentity.sizeBytes) fail(`descriptor sizeBytes ${descriptor.sizeBytes} does not match staged size ${stagedIdentity.sizeBytes}`);
  if (descriptor.sha256 !== stagedIdentity.sha256) fail(`descriptor sha256 ${descriptor.sha256} does not match staged sha256 ${stagedIdentity.sha256}`);
  if (manifest !== `${stagedIdentity.sha256}  ${bridgeFileName}\n`) fail('sha256 manifest does not match staged bytes');

  const generatedExpectation = readGeneratedExpectation(generatedText);
  if (generatedExpectation.sha256 !== stagedIdentity.sha256) fail('generated compiled sha256 expectation does not match staged bytes');
  if (generatedExpectation.sizeBytes !== stagedIdentity.sizeBytes) fail('generated compiled byte-count expectation does not match staged bytes');

  if (compiledExpectationSha256 !== undefined && compiledExpectationSha256 !== stagedIdentity.sha256) fail('compiled sha256 expectation does not match staged bytes');
  if (compiledExpectationSizeBytes !== undefined && compiledExpectationSizeBytes !== stagedIdentity.sizeBytes) fail('compiled byte-count expectation does not match staged bytes');

  if (compiledBundlePath !== undefined) {
    const compiledBundle = await readFile(compiledBundlePath, 'utf8');
    if (!compiledBundle.includes(stagedIdentity.sha256)) fail('compiled bundle does not contain the staged bridge sha256 expectation');
    if (!compiledBundle.includes(String(stagedIdentity.sizeBytes))) fail('compiled bundle does not contain the staged bridge byte-count expectation');
  }

  if (packagedBridgePath !== undefined) {
    const packagedBytes = await readFile(packagedBridgePath);
    if (!packagedBytes.equals(stagedBytes)) fail('packaged bridge bytes differ from staged package bytes');
    if (sha256(packagedBytes) !== stagedIdentity.sha256) fail('packaged bridge sha256 differs from staged package bytes');
  }

  return stagedIdentity;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const identity = await verifyCapabilityBridgeArtifacts({
    packagedBridgePath: defaultPackagedBridgePath,
    compiledBundlePath: defaultCompiledBundlePath,
  });
  process.stdout.write(`verified windows-capability-bridge sha256 ${identity.sha256} bytes ${identity.sizeBytes}\n`);
}

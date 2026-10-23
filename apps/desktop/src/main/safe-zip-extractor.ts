import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { Open } from 'unzipper';

export type ZipExtractImplementation = (archivePath: string, options: { readonly dir: string }) => Promise<void>;

async function extractZipWithUnzipper(archivePath: string, options: { readonly dir: string }): Promise<void> {
  const archive = await Open.file(archivePath);
  await archive.extract({ path: options.dir });
}

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const UNIX_HOST = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMBOLIC_LINK = 0o120000;
const MAX_ZIP_ENTRIES = 8_192;
const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export async function extractZipSafely(
  archivePath: string,
  destination: string,
  extractImpl: ZipExtractImplementation = extractZipWithUnzipper,
): Promise<void> {
  const extractionRoot = path.resolve(destination);
  try {
    await validateZipArchive(archivePath);
    await extractImpl(archivePath, { dir: extractionRoot });
    await assertExtractedTreeSafe(extractionRoot);
  } catch (error: unknown) {
    await rm(extractionRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function validateZipArchive(archivePath: string): Promise<void> {
  const archive = await readFile(archivePath);
  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) throw new Error('ZIP archive is missing a valid end-of-central-directory record');

  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }
  if (entryCount === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported for runtime provider installation');
  }
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error('ZIP archive contains too many entries');

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset < 0 || centralDirectoryEnd > eocdOffset || centralDirectoryEnd > archive.length) {
    throw new Error('ZIP central directory is outside the archive bounds');
  }

  const entryNames = new Set<string>();
  let totalUncompressedBytes = 0;
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralDirectoryEnd || archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('ZIP central directory entry is malformed');
    }
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralDirectoryEnd) throw new Error('ZIP central directory entry exceeds archive bounds');
    if (compressedSize > archive.length) throw new Error('ZIP entry compressed size exceeds archive bounds');
    if (uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) throw new Error('ZIP entry expands beyond the per-entry safety limit');
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error('ZIP archive expands beyond the total safety limit');

    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const entryName = decodeZipEntryName(nameBytes);
    const normalizedName = validateZipEntryName(entryName);
    const collisionKey = normalizedName.replace(/\/+$/, '').toLowerCase();
    if (collisionKey.length === 0 || entryNames.has(collisionKey)) {
      throw new Error(`ZIP archive contains a duplicate or empty entry name: ${entryName}`);
    }
    entryNames.add(collisionKey);

    const hostOs = versionMadeBy >>> 8;
    if (hostOs === UNIX_HOST) {
      const mode = (externalAttributes >>> 16) & 0xffff;
      const fileType = mode & UNIX_FILE_TYPE_MASK;
      if (fileType === UNIX_SYMBOLIC_LINK) throw new Error(`ZIP archive contains a symbolic link entry: ${entryName}`);
      if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE && fileType !== UNIX_DIRECTORY) {
        throw new Error(`ZIP archive contains an unsupported Unix file type: ${entryName}`);
      }
    }
    if ((flags & 0x1) !== 0) throw new Error(`Encrypted ZIP entries are not supported: ${entryName}`);

    validateLocalHeader(archive, localHeaderOffset, nameBytes, flags);
    cursor = entryEnd;
  }
  if (cursor > centralDirectoryEnd) throw new Error('ZIP central directory size is inconsistent');
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - (22 + MAX_ZIP_COMMENT_BYTES));
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  return -1;
}

function decodeZipEntryName(nameBytes: Buffer): string {
  // unzipper decodes central-directory names with Buffer.toString('utf8')
  // regardless of the UTF-8 flag. Mirror that exact decoding here so the
  // pre-extraction collision/path checks cannot disagree with extraction.
  return nameBytes.toString('utf8');
}

function validateZipEntryName(entryName: string): string {
  if (entryName.length === 0 || entryName.includes('\0')) throw new Error('ZIP archive contains an invalid empty or NUL entry name');
  const normalized = entryName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`ZIP archive contains an absolute entry path: ${entryName}`);
  }
  const withoutTrailingSlash = normalized.replace(/\/+$/, '');
  const segments = withoutTrailingSlash.split('/');
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`ZIP archive contains an unsafe entry path: ${entryName}`);
  }
  return normalized;
}

function validateLocalHeader(archive: Buffer, localHeaderOffset: number, centralNameBytes: Buffer, centralFlags: number): void {
  if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error('ZIP local file header is malformed');
  }
  const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
  const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
  const localNameStart = localHeaderOffset + 30;
  const localNameEnd = localNameStart + localNameLength;
  if (localNameEnd + localExtraLength > archive.length) throw new Error('ZIP local file header exceeds archive bounds');
  const localNameBytes = archive.subarray(localNameStart, localNameEnd);
  if (!localNameBytes.equals(centralNameBytes) || localFlags !== centralFlags) {
    throw new Error('ZIP local and central directory metadata do not match');
  }
}

async function assertExtractedTreeSafe(extractionRoot: string): Promise<void> {
  const rootRealPath = await realpath(extractionRoot);
  await visitDirectory(rootRealPath, rootRealPath);
}

async function visitDirectory(rootRealPath: string, directoryPath: string): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) throw new Error(`ZIP extraction rejected symbolic link entry: ${entry.name}`);

    const entryRealPath = await realpath(entryPath);
    if (!isPathWithin(rootRealPath, entryRealPath)) {
      throw new Error(`ZIP extraction escaped the destination root: ${entry.name}`);
    }
    if (metadata.isDirectory()) await visitDirectory(rootRealPath, entryRealPath);
  }
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

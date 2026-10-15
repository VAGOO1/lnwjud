import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { AtomicFileWriter } from './atomic-writer.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AtomicFileWriter', () => {
  it('writes through a temporary file in the target directory and replaces the target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'file.txt');
    const result = await new AtomicFileWriter().write(target, 'new content\n');

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(target, 'utf8')).resolves.toBe('new content\n');
  });

  it('creates missing nested parent directories before writing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'docs', 'superpowers', 'plans', 'plan.md');
    const result = await new AtomicFileWriter().write(target, 'nested\n');

    expect(result).toEqual({ ok: true, value: undefined });
    await expect(readFile(target, 'utf8')).resolves.toBe('nested\n');
  });

  it('revalidates immediately before publication and leaves the live target unchanged on conflict', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-write-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'file.txt');
    await writeFile(target, 'before\n', 'utf8');
    let validations = 0;
    const validateDestination = async (): Promise<Result<void>> => {
      validations += 1;
      return validations < 3 ? ok(undefined) : err(appError('CONFLICT', 'destination changed', true));
    };

    const result = await new AtomicFileWriter().write(target, 'after\n', { validateDestination });

    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(validations).toBe(3);
    await expect(readFile(target, 'utf8')).resolves.toBe('before\n');
    expect(await readdir(root)).toEqual(['file.txt']);
  });

  it('refuses EEXIST without changing an existing destination', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-noreplace-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'existing.txt');
    await writeFile(target, 'original');
    const result = await new AtomicFileWriter().write(target, 'replacement', { createOnly: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('original');
    expect(await readdir(root)).toEqual(['existing.txt']);
  });

  it('publishes exactly one of 20 concurrent create-only writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-noreplace-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'race.txt');
    const writer = new AtomicFileWriter();
    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      writer.write(target, 'candidate-' + i, { createOnly: true }),
    ));
    const winners = outcomes.flatMap((result, i) => result.ok ? [i] : []);
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toHaveLength(19);
    await expect(readFile(target, 'utf8')).resolves.toBe('candidate-' + winners[0]);
    expect(await readdir(root)).toEqual(['race.txt']);
  });

  it('does not clobber a file created after the final guard validation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-noreplace-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'late.txt');
    let validations = 0;
    const validateDestination = async (): Promise<Result<void>> => {
      validations += 1;
      if (validations === 3) await writeFile(target, 'rival', { flag: 'wx' });
      return ok(undefined);
    };
    const result = await new AtomicFileWriter().write(target, 'candidate', {
      createOnly: true, validateDestination,
    });
    expect(validations).toBe(3);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(readFile(target, 'utf8')).resolves.toBe('rival');
    expect(await readdir(root)).toEqual(['late.txt']);
  });

  it('refuses to replace a symlink destination or its target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-noreplace-'));
    temporaryRoots.push(root);
    const original = path.join(root, 'original.txt');
    const alias = path.join(root, 'alias.txt');
    await writeFile(original, 'protected');
    await symlink(original, alias, 'file');
    const result = await new AtomicFileWriter().write(alias, 'candidate', { createOnly: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(readFile(original, 'utf8')).resolves.toBe('protected');
    await expect(readFile(alias, 'utf8')).resolves.toBe('protected');
    expect((await readdir(root)).sort()).toEqual(['alias.txt', 'original.txt']);
  });

});

import { describe, expect, it } from 'vitest';
import { parseDelimitedList } from './text-list.js';

describe('parseDelimitedList', () => {
  it('trims entries, accepts semicolon/newline delimiters, and removes exact duplicates', () => {
    expect(parseDelimitedList(' alpha ; beta\nalpha\r\ngamma ')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('can deduplicate case-insensitively for filesystem/path settings', () => {
    expect(parseDelimitedList('C:\\Work\n c:\\work ; D:\\Other', { caseInsensitive: true })).toEqual([
      'C:\\Work',
      'D:\\Other',
    ]);
  });

  it('returns an empty list for blank or missing input', () => {
    expect(parseDelimitedList(undefined)).toEqual([]);
    expect(parseDelimitedList(null)).toEqual([]);
    expect(parseDelimitedList('   ')).toEqual([]);
  });
});

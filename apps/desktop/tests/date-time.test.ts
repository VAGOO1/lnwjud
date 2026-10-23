import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../src/renderer/date-time.js';

describe('desktop date/time formatting', () => {
  it('uses one Asia/Bangkok 24-hour DD/MM/YYYY standard for Thai UI', () => {
    expect(formatDateTime('2026-09-09T05:23:22.224Z', '—', 'th')).toBe('09/09/2026 12:23:22');
    expect(formatDateTime('2026-12-31T18:30:00.000Z', '—', 'th')).toBe('01/01/2027 01:30:00');
  });

  it('uses the same timezone and 24-hour format for English UI', () => {
    expect(formatDateTime('2026-08-29T11:07:06.999Z', '—', 'en')).toBe('29/08/2026 18:07:06');
  });

  it('preserves invalid source text instead of fabricating a date', () => {
    expect(formatDateTime('not-a-date', 'fallback', 'th')).toBe('not-a-date');
  });

  it('uses the supplied fallback when no timestamp exists', () => {
    expect(formatDateTime(null, 'not checked', 'th')).toBe('not checked');
  });
});

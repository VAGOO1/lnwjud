import { describe, expect, it } from 'vitest';
import { formatDisplayDateTime, formatDisplayTimestampItem, formatOffsetIsoTimestamp } from './date-time-display.js';

describe('shared display date/time contract', () => {
  it('renders Thai and English UI with one Gregorian DD/MM/YYYY 24-hour standard', () => {
    expect(formatDisplayDateTime('2026-09-09T05:23:22.224Z', 'th')).toBe('09/09/2026 12:23:22');
    expect(formatDisplayDateTime('2026-09-09T05:23:22.224Z', 'en')).toBe('09/09/2026 12:23:22');
    expect(formatDisplayDateTime('2026-12-31T18:30:00.000Z', 'th')).toBe('01/01/2027 01:30:00');
  });

  it('uses real IANA timezone/DST rules when a timezone override is requested', () => {
    expect(formatDisplayDateTime('2026-03-08T06:30:00.000Z', 'en', { timeZone: 'America/New_York' })).toBe('08/03/2026 01:30:00');
    expect(formatDisplayDateTime('2026-03-08T07:30:00.000Z', 'en', { timeZone: 'America/New_York' })).toBe('08/03/2026 03:30:00');
  });

  it('emits ISO-8601 evidence timestamps with the configured local offset', () => {
    expect(formatOffsetIsoTimestamp('2026-09-15T17:13:20.407Z')).toBe('2026-09-16T00:13:20.407+07:00');
    expect(formatOffsetIsoTimestamp('2026-03-08T07:30:00.000Z', 'America/New_York')).toBe('2026-03-08T03:30:00.000-04:00');
  });

  it('localizes exact ISO timestamp values inside structured detail items without changing other diagnostic text', () => {
    expect(formatDisplayTimestampItem('started_at=2026-09-09T05:23:22.224Z', 'th')).toBe('started_at=09/09/2026 12:23:22');
    expect(formatDisplayTimestampItem('deadline_at=2026-09-09T05:24:22.224Z', 'en', { timeZone: 'Asia/Bangkok' })).toBe('deadline_at=09/09/2026 12:24:22');
    expect(formatDisplayTimestampItem('status=running', 'th')).toBe('status=running');
    expect(formatDisplayTimestampItem('url=https://example.com/2026-09-09T05:23:22.224Z', 'th')).toBe('url=https://example.com/2026-09-09T05:23:22.224Z');
  });

  it('preserves invalid source text and supports an explicit fallback for missing values', () => {
    expect(formatDisplayDateTime('not-a-date', 'th', { fallback: 'fallback' })).toBe('not-a-date');
    expect(formatDisplayDateTime(null, 'th', { fallback: 'not checked' })).toBe('not checked');
  });
});

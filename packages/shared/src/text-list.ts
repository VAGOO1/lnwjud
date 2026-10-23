export interface ParseDelimitedListOptions {
  readonly caseInsensitive?: boolean;
}

export function parseDelimitedList(
  value: string | null | undefined,
  options: ParseDelimitedListOptions = {},
): readonly string[] {
  if (value === null || value === undefined || value.trim().length === 0) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value.split(/[;\r\n]+/)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = options.caseInsensitive === true ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

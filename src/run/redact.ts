const PATTERNS: [RegExp, string][] = [
  [/bot\d+:[\w-]+/g, 'bot[REDACTED]'],
  [/sk-ant-[\w-]+/g, '[REDACTED]'],
  [/sk-or-[\w-]+/g, '[REDACTED]'],
  [/(chat_id=)[^&\s"]+/g, '$1[REDACTED]'],
  [/(\/\/)[^/\s@]+@/g, '$1[REDACTED]@'],
  [/(Basic )[\w+/=]+/g, '$1[REDACTED]'],
  [/BEGIN:VCALENDAR[\s\S]*?(END:VCALENDAR|$)/g, '[REDACTED iCalendar]'],
];

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// Applied at the record boundary: every string in the record is scrubbed before it is written.
export function redact<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redact(v, secrets)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets)])) as T;
  }
  return value;
}

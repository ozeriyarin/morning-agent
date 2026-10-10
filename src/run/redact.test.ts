import { describe, expect, it } from 'vitest';
import { redact, redactText } from './redact.js';

describe('redaction', () => {
  it.each([
    [
      'https://api.telegram.org/bot123:ABC-def_9/sendMessage',
      'https://api.telegram.org/bot[REDACTED]/sendMessage',
    ],
    ['x-api-key: sk-ant-api03-abc_DEF-1', 'x-api-key: [REDACTED]'],
    ['?chat_id=555&text=hi', '?chat_id=[REDACTED]&text=hi'],
    ['explicit s3cret value', 'explicit [REDACTED] value'],
    ['nothing to hide', 'nothing to hide'],
    ['https://a%40b.c:pw@caldav.icloud.com/x', 'https://[REDACTED]@caldav.icloud.com/x'],
    ['Authorization: Basic YTpi=', 'Authorization: Basic [REDACTED]'],
    ['body BEGIN:VCALENDAR\r\nSUMMARY:x\r\nEND:VCALENDAR!', 'body [REDACTED iCalendar]!'],
  ])('redactText(%j) is %j', (input, expected) => {
    expect(redactText(input, ['s3cret'])).toBe(expected);
  });

  it('walks nested objects and arrays and leaves numbers alone', () => {
    expect(redact({ a: ['s3cret', 1], b: { c: 's3cret!' } }, ['s3cret'])).toEqual({
      a: ['[REDACTED]', 1],
      b: { c: '[REDACTED]!' },
    });
  });
});

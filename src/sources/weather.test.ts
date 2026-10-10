import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SourceError } from '../types.js';
import { geocode, mapWeather, OpenMeteoSource, weatherLabel } from './weather.js';

const fixture: unknown = JSON.parse(readFileSync('test/fixtures/open-meteo-modiin.json', 'utf8'));
const location = { latitude: 31.89, longitude: 35.01, timezone: 'Asia/Jerusalem' };
const ctx = { date: '2026-10-10', reference: new Date('2026-10-10T04:00:00Z') };

describe('weather', () => {
  it('criterion 2: "Weather mapping: given a captured Open-Meteo response, the mapped day has min, max, precipitation probability and a weather code label in Hebrew."', () => {
    expect(mapWeather(fixture, '2026-10-10')).toEqual({
      date: '2026-10-10',
      min: 19,
      max: 31,
      precipitationProbability: 3,
      code: 3,
      label: 'מעונן',
    });
  });

  it.each([
    [0, 'בהיר'],
    [2, 'מעונן חלקית'],
    [45, 'ערפל'],
    [53, 'טפטוף'],
    [63, 'גשם'],
    [81, 'ממטרים'],
    [95, 'סופת רעמים'],
    [99, 'סופת רעמים עם ברד'],
    [1234, 'לא ידוע'],
  ])('labels WMO code %i as %s', (code, label) => {
    expect(weatherLabel(code)).toBe(label);
  });

  it('rejects a response without the requested day', () => {
    expect(() => mapWeather(fixture, '2026-10-11')).toThrow(SourceError);
    expect(() => mapWeather({ daily: {} }, '2026-10-10')).toThrow(SourceError);
  });

  it('requests the day in the configured zone and maps the body', async () => {
    let url = '';
    const fetchFn: typeof fetch = async (input) => {
      url = String(input);
      return Response.json(fixture);
    };
    const day = await new OpenMeteoSource(location, fetchFn).fetch(ctx);
    expect(url).toContain('start_date=2026-10-10');
    expect(url).toContain('timezone=Asia%2FJerusalem');
    expect(day.label).toBe('מעונן');
  });

  it('throws a SourceError on an HTTP failure', async () => {
    const fetchFn: typeof fetch = async () => new Response('down', { status: 500 });
    await expect(new OpenMeteoSource(location, fetchFn).fetch(ctx)).rejects.toThrow(
      'Open-Meteo HTTP 500',
    );
  });

  it('geocode asks for one Hebrew result and maps it to a place', async () => {
    let url = '';
    const body: unknown = JSON.parse(readFileSync('test/fixtures/geocoding-tel-aviv.json', 'utf8'));
    const fetchFn: typeof fetch = async (input) => {
      url = String(input);
      return Response.json(body);
    };
    expect(await geocode('תל אביב', 'UTC', fetchFn)).toEqual({
      name: 'תל אביב-יפו',
      latitude: 32.08088,
      longitude: 34.78057,
      timezone: 'Asia/Jerusalem',
    });
    expect(url).toContain('https://geocoding-api.open-meteo.com/v1/search?');
    expect(url).toContain('language=he');
    expect(url).toContain('count=1');
  });

  it('geocode returns null for no results and throws on an HTTP failure', async () => {
    const empty: typeof fetch = async () => Response.json({ generationtime_ms: 1 });
    expect(await geocode('nowhere', 'UTC', empty)).toBeNull();
    const down: typeof fetch = async () => new Response('down', { status: 503 });
    await expect(geocode('x', 'UTC', down)).rejects.toThrow('geocoding HTTP 503');
  });
});

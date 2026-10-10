import { z } from 'zod';
import { SourceError, type FetchContext, type Source, type WeatherDay } from '../types.js';

const WMO_LABELS: [number[], string][] = [
  [[0], 'בהיר'],
  [[1], 'בהיר ברובו'],
  [[2], 'מעונן חלקית'],
  [[3], 'מעונן'],
  [[45, 48], 'ערפל'],
  [[51, 53, 55], 'טפטוף'],
  [[56, 57], 'טפטוף קופא'],
  [[61], 'גשם קל'],
  [[63], 'גשם'],
  [[65], 'גשם חזק'],
  [[66, 67], 'גשם קופא'],
  [[71, 73, 75, 77], 'שלג'],
  [[80, 81], 'ממטרים'],
  [[82], 'ממטרים חזקים'],
  [[85, 86], 'ממטרי שלג'],
  [[95], 'סופת רעמים'],
  [[96, 99], 'סופת רעמים עם ברד'],
];

export function weatherLabel(code: number): string {
  return WMO_LABELS.find(([codes]) => codes.includes(code))?.[1] ?? 'לא ידוע';
}

const openMeteoSchema = z.object({
  daily: z.object({
    time: z.array(z.string()),
    weather_code: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    precipitation_probability_max: z.array(z.number().nullable()),
  }),
});

export function mapWeather(response: unknown, date: string): WeatherDay {
  const parsed = openMeteoSchema.safeParse(response);
  if (!parsed.success) throw new SourceError('weather', 'unexpected Open-Meteo response shape');
  const { daily } = parsed.data;
  const i = daily.time.indexOf(date);
  const code = daily.weather_code[i];
  const max = daily.temperature_2m_max[i];
  const min = daily.temperature_2m_min[i];
  if (i < 0 || code === undefined || max === undefined || min === undefined) {
    throw new SourceError('weather', `no forecast for ${date}`);
  }
  return {
    date,
    min: Math.round(min),
    max: Math.round(max),
    precipitationProbability: daily.precipitation_probability_max[i] ?? 0,
    code,
    label: weatherLabel(code),
  };
}

// The brief and the inbox /weather reply share these two sentences.
export function weatherSummary(day: WeatherDay): string {
  return `${day.label}, ${day.min}°-${day.max}°, סיכוי לגשם ${day.precipitationProbability}%.`;
}

export function weatherAdvice(day: WeatherDay): string {
  if (day.precipitationProbability >= 50) return 'כדאי לקחת מטרייה.';
  if (day.min <= 12) return 'קריר בבוקר, כדאי לקחת ז׳קט.';
  if (day.max >= 30) return 'חם היום, לשתות הרבה מים.';
  return 'יום נעים, אין צורך בהכנות מיוחדות.';
}

export interface WeatherLocation {
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface Place extends WeatherLocation {
  name: string;
}

const geocodingSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional(),
      }),
    )
    .default([]),
});

// Null when Open-Meteo knows no such place; a place without a timezone gets `fallbackZone`.
export async function geocode(
  name: string,
  fallbackZone: string,
  fetchFn: typeof fetch,
  timeoutMs = 15_000,
): Promise<Place | null> {
  const params = new URLSearchParams({ name, language: 'he', count: '1' });
  const res = await fetchFn(`https://geocoding-api.open-meteo.com/v1/search?${params}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new SourceError('geocoding', `Open-Meteo geocoding HTTP ${res.status}`);
  const parsed = geocodingSchema.safeParse(await res.json());
  if (!parsed.success) throw new SourceError('geocoding', 'unexpected geocoding response shape');
  const hit = parsed.data.results[0];
  return hit ? { ...hit, timezone: hit.timezone ?? fallbackZone } : null;
}

export class OpenMeteoSource implements Source<WeatherDay> {
  readonly name = 'weather';

  constructor(
    private readonly location: WeatherLocation,
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 25_000,
  ) {}

  async fetch(ctx: FetchContext): Promise<WeatherDay> {
    const params = new URLSearchParams({
      latitude: String(this.location.latitude),
      longitude: String(this.location.longitude),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: this.location.timezone,
      start_date: ctx.date,
      end_date: ctx.date,
    });
    const res = await this.fetchFn(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new SourceError(this.name, `Open-Meteo HTTP ${res.status}`);
    return mapWeather(await res.json(), ctx.date);
  }
}

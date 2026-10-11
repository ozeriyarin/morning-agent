import { loadICloudCredentials } from './config.js';
import { useEnvProxy } from './cli.js';
import { ICloudCalendarSource } from './sources/icloud-calendar.js';

// Prints iCloud collection names, their component sets and all VTODO DUE lines. No titles, no secrets.
useEnvProxy();
const credentials = loadICloudCredentials(process.env);
if (!credentials) throw new Error('ICLOUD_USERNAME / ICLOUD_APP_PASSWORD not set');
const source = new ICloudCalendarSource(credentials, 'Asia/Jerusalem', fetch);
console.log(JSON.stringify(await source.probe(), null, 2));

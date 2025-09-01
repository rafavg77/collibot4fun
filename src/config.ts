import dotenv from 'dotenv';

// Allow custom env file path via ENV_FILE, default to bot.env then .env
const envFile = process.env.ENV_FILE || 'bot.env';
dotenv.config({ path: envFile });

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Variable de entorno faltante: ${name}`);
  return v;
};

export const ENV = {
  DB_PATH: required('DB_PATH'),
  STARTUP_NOTIFY_NUMBERS: process.env.STARTUP_NOTIFY_NUMBERS || '',
  NODE_ENV: process.env.NODE_ENV || 'development',
  CHROMIUM_PATH: required('CHROMIUM_PATH'),
  WHATSAPP_AUTH_DIR: required('WHATSAPP_AUTH_DIR'),
  BOT_NAME: required('BOT_NAME'),
  DOOR_API_BASE: required('DOOR_API_BASE').replace(/\/$/, ''),
  RTSP_VISITS_URL: required('RTSP_VISITS_URL'),
  RTSP_PEDESTRIAN_URL: required('RTSP_PEDESTRIAN_URL'),
};

export function getRequired(name: keyof typeof ENV): string { return ENV[name]; }

export function splitCommaList(v: string): string[] {
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

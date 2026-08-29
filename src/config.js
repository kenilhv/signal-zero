// Signal Zero - configuration.
// Every value has a sensible default so `npm install && npm start` works with
// NO .env file present at all. Missing credentials degrade the pipeline into
// offline / deterministic modes rather than crashing it.

import dotenv from 'dotenv';

dotenv.config();

function str(name, fallback = '') {
  const v = process.env[name];
  if (v === undefined || v === null) return fallback;
  const trimmed = String(v).trim();
  return trimmed === '' ? fallback : trimmed;
}

function bool(name, fallback = false) {
  const v = str(name, '');
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name, fallback) {
  const n = Number.parseInt(str(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export const PORT = int('PORT', 3000);

// Bright Data powers the INGEST stage. Empty token => offline corpus.
export const BRIGHTDATA_API_TOKEN = str('BRIGHTDATA_API_TOKEN', '');

// LLM credentials. Used ONLY by triage tier 3 (low-confidence fallback).
// Never by dedup scoring, never by ranking - those stay deterministic.
export const OPENAI_API_KEY = str('OPENAI_API_KEY', '');
export const OPENAI_BASE_URL = str('OPENAI_BASE_URL', 'https://api.openai.com/v1');
export const OPENAI_MODEL = str('OPENAI_MODEL', 'gpt-4o-mini');

// Live scraping only makes sense when we actually have a Bright Data token.
export const USE_LIVE_SCRAPE = bool('USE_LIVE_SCRAPE', false) && BRIGHTDATA_API_TOKEN !== '';

export const config = {
  PORT,
  BRIGHTDATA_API_TOKEN,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  USE_LIVE_SCRAPE
};

export default config;

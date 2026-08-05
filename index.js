import express from 'express';
import { getConfigValue } from '../../src/util.js';
import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';

export const info = {
    id: 'deepseek-usage-meter',
    name: 'DeepSeek Usage Meter',
    description: 'Tracks DeepSeek API usage and balance from chat-completion responses.',
};

const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';
const PRICING_TTL_MS = 60 * 60 * 1000; // Re-fetch the pricing page hourly.
const BEIJING_OFFSET_MIN = 8 * 60;

// Fallback prices (USD per 1M tokens) and peak schedule, mirroring the DeepSeek pricing page.
const FALLBACK_MODELS = {
    'deepseek-v4-flash': { cache_hit: 0.0028, cache_miss: 0.14, output: 0.28 },
    'deepseek-v4-pro': { cache_hit: 0.003625, cache_miss: 0.435, output: 0.87 },
};
const FALLBACK_PEAK_HOURS = [
    { start: 9 * 60, end: 12 * 60 },
    { start: 14 * 60, end: 18 * 60 },
]; // Beijing time (UTC+8), daily
const FALLBACK_PEAK_MULTIPLIER = 2;

const authorize = (req, res, next) => {
    const token = req.header('X-Meter-Token') || '';
    const expected = getConfigValue('deepseekUsageMeterToken', '');
    if (!expected || token === expected) return next();
    return res.status(401).json({ error: 'Unauthorized' });
};

const deepseekKey = req => {
    const directories = req.user?.directories;
    if (!directories) return null;
    try {
        return readSecret(directories, SECRET_KEYS.DEEPSEEK);
    } catch {
        return null;
    }
};

const beijingMinutes = (date = new Date()) => (date.getUTCHours() * 60 + date.getUTCMinutes() + BEIJING_OFFSET_MIN) % (24 * 60);

const isPeak = (peakHours, minutes = beijingMinutes()) => peakHours.some(({ start, end }) => minutes >= start && minutes < end);

const fmtMinutes = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Parse the DeepSeek pricing page (Docusaurus HTML). Returns null if the expected
 * table cannot be found, so callers fall back to the built-in table.
 */
function parsePricingPage(html) {
    const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)];
    const models = [];
    const prices = {};

    for (const row of rows) {
        const cells = [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(cell => cell[1].replace(/<[^>]+>/g, '').trim());
        if (!cells.length) continue;

        if (cells[0] === 'MODEL') {
            models.push(...cells.slice(1).filter(Boolean));
            continue;
        }

        const label = cells.find(c => c.includes('1M INPUT TOKENS (CACHE HIT)') || c.includes('1M INPUT TOKENS (CACHE MISS)') || c.includes('1M OUTPUT TOKENS'));
        if (!label) continue;

        const values = cells.map(c => Number(c.replace('$', ''))).filter(v => Number.isFinite(v) && v > 0);
        if (values.length < models.length) continue;

        const key = label.includes('CACHE HIT') ? 'cache_hit' : label.includes('CACHE MISS') ? 'cache_miss' : 'output';
        models.forEach((model, i) => {
            prices[model] ??= {};
            prices[model][key] = values[i];
        });
    }

    if (Object.keys(prices).length === 0) return null;

    // "Peak hours: 9:00–12:00 and 14:00–18:00 (Beijing Time, UTC+8) daily"
    const peakMatch = html.match(/Peak hours:\s*(\d{1,2}):(\d{2})[^\d]+(\d{1,2}):(\d{2})[^\d]+(\d{1,2}):(\d{2})[^\d]+(\d{1,2}):(\d{2})/);
    // "During peak hours, prices will be 2x the regular prices"
    const multMatch = html.match(/(\d+)x the regular prices/);

    return {
        models: prices,
        peakHours: peakMatch ? [
            { start: Number(peakMatch[1]) * 60 + Number(peakMatch[2]), end: Number(peakMatch[3]) * 60 + Number(peakMatch[4]) },
            { start: Number(peakMatch[5]) * 60 + Number(peakMatch[6]), end: Number(peakMatch[7]) * 60 + Number(peakMatch[8]) },
        ] : FALLBACK_PEAK_HOURS,
        peakMultiplier: multMatch ? Number(multMatch[1]) : FALLBACK_PEAK_MULTIPLIER,
    };
}

async function fetchPricing() {
    try {
        const response = await fetch(PRICING_URL, {
            headers: { 'Accept-Language': 'en' },
            signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
            const parsed = parsePricingPage(await response.text());
            if (parsed) return { ...parsed, source: 'live' };
        }
    } catch (err) {
        console.debug('[DeepSeek Usage Meter] Pricing fetch failed, using fallback:', err.message);
    }
    return { models: FALLBACK_MODELS, peakHours: FALLBACK_PEAK_HOURS, peakMultiplier: FALLBACK_PEAK_MULTIPLIER, source: 'fallback' };
}

let pricingCache = null;

async function getPricing() {
    const now = Date.now();
    if (!pricingCache || now - pricingCache.at > PRICING_TTL_MS) {
        pricingCache = { at: now, data: await fetchPricing() };
    }
    return pricingCache.data;
}

export function init(router) {
    router.use(authorize);

    // Balance + prices, both pulled live from DeepSeek. Peak-hour pricing is
    // detected automatically from the announced Beijing-time window.
    router.get('/pricing', async (req, res) => {
        try {
            const pricing = await getPricing();
            const peak = isPeak(pricing.peakHours);
            const multiplier = peak ? pricing.peakMultiplier : 1;
            const effective = Object.fromEntries(Object.entries(pricing.models).map(([model, p]) => [model, {
                cache_hit: p.cache_hit * multiplier,
                cache_miss: p.cache_miss * multiplier,
                output: p.output * multiplier,
            }]));
            res.json({
                models: pricing.models,
                effective,
                peak,
                peakMultiplier: pricing.peakMultiplier,
                peakHours: pricing.peakHours.map(h => ({ start: fmtMinutes(h.start), end: fmtMinutes(h.end) })),
                beijingTime: fmtMinutes(beijingMinutes()),
                source: pricing.source,
                fetchedAt: new Date(pricingCache.at).toISOString(),
            });
        } catch (err) {
            console.error('[DeepSeek Usage Meter]', err.message);
            res.status(500).json({ error: 'Pricing request failed' });
        }
    });

    router.get('/balance', async (req, res) => {
        try {
            const key = deepseekKey(req);
            if (!key) return res.status(400).json({ error: 'No DeepSeek key configured' });
            const upstream = await fetch('https://api.deepseek.com/user/balance', {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(15000),
            });
            const body = await upstream.json();
            return res.status(upstream.status).json(body);
        } catch (err) {
            console.error('[DeepSeek Usage Meter]', err.message);
            return res.status(500).json({ error: 'Balance request failed' });
        }
    });

    console.log('[DeepSeek Usage Meter] Plugin loaded');
}


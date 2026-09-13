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

// Fallback prices (USD per 1M tokens) and peak schedule, mirroring the DeepSeek
// pricing page. These are the OFF-PEAK base rates; the peak multiplier (2x) is
// applied on top, so a fallback only reaches the announced peak prices when the
// base is the off-peak rate (not the pre-switch flat rate).
const FALLBACK_MODELS = {
    'deepseek-v4-flash': { cache_hit: 0.007, cache_miss: 0.22, output: 0.66 },
    'deepseek-v4-pro': { cache_hit: 0.022, cache_miss: 0.66, output: 1.98 },
    'deepseek-v4-flash-vision-exp': { cache_hit: 0.007, cache_miss: 0.22, output: 0.66 },
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

// Beijing day-of-week (0=Sun..6=Sat). The pricing page makes weekends (Sat/Sun,
// Beijing) all-off-peak, so peak billing must skip those days.
const beijingDay = (date = new Date()) => new Date(date.getTime() + BEIJING_OFFSET_MIN * 60000).getUTCDay();

const isPeak = (peakHours, minutes = beijingMinutes(), weekendOffPeak = false) =>
    (!weekendOffPeak || (beijingDay() !== 0 && beijingDay() !== 6)) &&
    peakHours.some(({ start, end }) => minutes >= start && minutes < end);

const fmtMinutes = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Drop a trailing footnote marker like `(2)` from a model-name cell. */
const stripFootnote = cell => cell.replace(/\(\d+\)\s*$/, '').trim();

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
            // Model names carry footnote markers in the header (`deepseek-v4-pro(2)`),
            // which must be stripped so keys match the API model ids.
            models.push(...cells.slice(1).map(stripFootnote).filter(Boolean));
            continue;
        }

        // The page renders the metric header as `1M INPUT TOKENS<br>(CACHE HIT)`,
        // which tag-strips to `1M INPUT TOKENS(CACHE HIT)` (no space before the
        // paren), so match with optional whitespace rather than a fixed literal.
        const key = cells
            .map(cell => /1M INPUT TOKENS\s*\(CACHE HIT\)/i.test(cell) ? 'cache_hit'
                : /1M INPUT TOKENS\s*\(CACHE MISS\)/i.test(cell) ? 'cache_miss'
                : /1M OUTPUT TOKENS/i.test(cell) ? 'output' : null)
            .find(k => k !== null);
        if (!key) continue;

        const values = cells.map(c => Number(c.replace(/[$,]/g, ''))).filter(v => Number.isFinite(v) && v > 0);
        if (values.length < models.length) continue;
        models.forEach((model, i) => {
            prices[model] ??= {};
            prices[model][key] = values[i];
        });
    }

    if (Object.keys(prices).length === 0) return null;

    // "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC" (new, UTC-based) or
    // "Peak hours: 9:00–12:00 and 14:00–18:00 (Beijing Time, UTC+8) daily" (old).
    const peakMatch = html.match(/Peak hours\b[^0-9]{0,24}(\d{1,2}):(\d{2})[^\d]+(\d{1,2}):(\d{2})[^\d]+(\d{1,2}):(\d{2})[^\d]+(\d{1,2}):(\d{2})/i);
    // The new page states the window in UTC; convert to Beijing minutes to match the rest of the plugin.
    // The zone word sits immediately AFTER the last time ("... 10:00 UTC"). A window
    // starting at the match start bleeds into the FOLLOWING sentence, which also
    // mentions "Beijing Time" (the pricing-adjustment notice), defeating the
    // !/beijing/ guard. Look right after the matched times instead.
    const afterTimes = peakMatch && html.slice(peakMatch.index + peakMatch[0].length, peakMatch.index + peakMatch[0].length + 40);
    const utcTimes = !!afterTimes && /utc/i.test(afterTimes) && !/beijing/i.test(afterTimes);
    const toBeijing = (h, m) => {
        const min = Number(h) * 60 + Number(m);
        return utcTimes ? (min + BEIJING_OFFSET_MIN) % (24 * 60) : min;
    };
    // "During peak hours, prices will be 2x the regular prices" (old) or
    // "Off-peak rates are half of the peak rates" (new).
    const multMatch = html.match(/(\d+)x the regular prices/);
    const halfMatch = /half of the peak rates/i.test(html);
    // "off-peak rates applying throughout the day on weekends (Saturdays and
    // Sundays, Beijing Time)" - weekends become all-off-peak. The page now
    // states it as "… UTC, Monday through Friday (all other hours are
    // off-peak)", so match both wordings.
    const weekendOffPeak = /off-peak rates applying throughout the day on weekends/i.test(html) ||
        /monday\s+through\s+friday/i.test(html) ||
        /monday\s*[-–]\s*friday/i.test(html);

    return {
        models: prices,
        peakHours: peakMatch ? [
            { start: toBeijing(peakMatch[1], peakMatch[2]), end: toBeijing(peakMatch[3], peakMatch[4]) },
            { start: toBeijing(peakMatch[5], peakMatch[6]), end: toBeijing(peakMatch[7], peakMatch[8]) },
        ] : FALLBACK_PEAK_HOURS,
        peakMultiplier: multMatch ? Number(multMatch[1]) : halfMatch ? 2 : FALLBACK_PEAK_MULTIPLIER,
        weekendOffPeak,
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
    return { models: FALLBACK_MODELS, peakHours: FALLBACK_PEAK_HOURS, peakMultiplier: FALLBACK_PEAK_MULTIPLIER, weekendOffPeak: false, source: 'fallback' };
}

let pricingCache = null;

async function getPricing() {
    const now = Date.now();
    if (!pricingCache || now - pricingCache.at > PRICING_TTL_MS) {
        pricingCache = { at: now, data: await fetchPricing() };
    }
    return pricingCache.data;
}

// --- Ollama Cloud ---------------------------------------------------------
// Ollama publishes its rate card as a static HTML page (two tables: normal
// rates, then the peak surcharge) and states the peak window in UTC, so this is
// simpler than the Beijing-time DeepSeek schedule: no timezone shifting, and
// only the DeepSeek models on that page carry a peak rate.
const OLLAMA_PRICING_URL = 'https://ollama.com/pricing';
const OLLAMA_USAGE_URL = 'https://ollama.com/api/usage';
const OLLAMA_PEAK_MULTIPLIER = 2;

const FALLBACK_OLLAMA_MODELS = {
    'deepseek-v4.1-flash': { cache_hit: 0.003, cache_miss: 0.15, output: 0.6 },
    'deepseek-v4-flash': { cache_hit: 0.007, cache_miss: 0.22, output: 0.66 },
    'deepseek-v4-pro': { cache_hit: 0.022, cache_miss: 0.66, output: 1.98 },
};
const FALLBACK_OLLAMA_PEAK_HOURS = [{ start: 12 * 60, end: 18 * 60 }]; // UTC, Mon-Fri

/**
 * Parse the Ollama pricing page. Table #1 is the normal rate card, table #2 the
 * peak rate card; both share the `Model | Input | Cached input | Output` header.
 * Returns null when the rate card is missing so callers use the built-in table.
 */
function parseOllamaPricingPage(html) {
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(table =>
        [...table[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map(row =>
            [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => cell[1].replace(/<[^>]+>/g, '').trim())));

    const toModels = rows => {
        const head = rows?.[0] ?? [];
        const at = name => head.indexOf(name);
        const [iIn, iHit, iOut] = [at('Input'), at('Cached input'), at('Output')];
        if (iIn < 0 || iHit < 0 || iOut < 0) return null;
        const num = value => Number(String(value ?? '').replace(/[$,]/g, ''));
        const models = {};
        for (const cells of rows.slice(1)) {
            const cache_miss = num(cells[iIn]);
            const output = num(cells[iOut]);
            // '-' in the cached column means the model has no cache discount, so
            // every input token bills at the normal rate.
            const cache_hit = Number.isFinite(num(cells[iHit])) ? num(cells[iHit]) : cache_miss;
            if (!cells[0] || ![cache_miss, output].every(Number.isFinite)) continue;
            models[cells[0]] = { cache_hit, cache_miss, output };
        }
        return Object.keys(models).length ? models : null;
    };

    const [rateCard, peakCard] = tables.map(toModels);
    if (!rateCard) return null;

    // "Peak pricing applies between 12:00 and 18:00 UTC, Monday to Friday."
    const rule = html.match(/Peak pricing applies between (\d{1,2}):(\d{2}) and (\d{1,2}):(\d{2}) UTC/i);
    return {
        models: rateCard,
        peakModels: peakCard ?? {},
        peakHours: rule
            ? [{ start: Number(rule[1]) * 60 + Number(rule[2]), end: Number(rule[3]) * 60 + Number(rule[4]) }]
            : FALLBACK_OLLAMA_PEAK_HOURS,
    };
}

const isOllamaPeak = (peakHours, date = new Date()) => {
    const day = date.getUTCDay();
    if (day === 0 || day === 6) return false; // weekends are off-peak all day
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    return peakHours.some(({ start, end }) => minutes >= start && minutes < end);
};

async function fetchOllamaPricing() {
    try {
        const response = await fetch(OLLAMA_PRICING_URL, { signal: AbortSignal.timeout(10000) });
        if (response.ok) {
            const parsed = parseOllamaPricingPage(await response.text());
            if (parsed) return { ...parsed, source: 'live' };
        }
    } catch (err) {
        console.debug('[DeepSeek Usage Meter] Ollama pricing fetch failed, using fallback:', err.message);
    }
    return { models: FALLBACK_OLLAMA_MODELS, peakModels: {}, peakHours: FALLBACK_OLLAMA_PEAK_HOURS, source: 'fallback' };
}

let ollamaPricingCache = null;

async function getOllamaPricing() {
    const now = Date.now();
    if (!ollamaPricingCache || now - ollamaPricingCache.at > PRICING_TTL_MS) {
        ollamaPricingCache = { at: now, data: await fetchOllamaPricing() };
    }
    return ollamaPricingCache.data;
}

export function init(router) {
    router.use(authorize);

    // Balance + prices, both pulled live from DeepSeek. Peak-hour pricing is
    // detected automatically from the announced Beijing-time window.
    router.get('/pricing', async (req, res) => {
        try {
            const pricing = await getPricing();
            const peak = isPeak(pricing.peakHours, beijingMinutes(), pricing.weekendOffPeak);
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
                weekendOffPeak: pricing.weekendOffPeak,
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

    // Ollama Cloud prices, scraped from ollama.com/pricing. Peak applies to the
    // DeepSeek models only, so `effective` overlays the peak card on the base card.
    router.get('/ollama/pricing', async (req, res) => {
        try {
            const pricing = await getOllamaPricing();
            const peak = isOllamaPeak(pricing.peakHours);
            res.json({
                models: pricing.models,
                effective: peak ? { ...pricing.models, ...pricing.peakModels } : pricing.models,
                peakModels: pricing.peakModels,
                peak,
                peakMultiplier: OLLAMA_PEAK_MULTIPLIER,
                peakHours: pricing.peakHours.map(h => ({ start: fmtMinutes(h.start), end: fmtMinutes(h.end) })),
                peakDays: 'Mon-Fri',
                utcTime: fmtMinutes(new Date().getUTCHours() * 60 + new Date().getUTCMinutes()),
                source: pricing.source,
                fetchedAt: new Date(ollamaPricingCache.at).toISOString(),
            });
        } catch (err) {
            console.error('[DeepSeek Usage Meter]', err.message);
            res.status(500).json({ error: 'Ollama pricing request failed' });
        }
    });

    // Session/weekly quota windows. Ollama API keys are not part of ST's secret
    // store, so the UI passes one per request; it is forwarded and never stored.
    router.get('/ollama/usage', async (req, res) => {
        try {
            const key = req.header('X-Ollama-Key') || '';
            if (!key) return res.status(400).json({ error: 'No Ollama API key configured' });
            const upstream = await fetch(OLLAMA_USAGE_URL, {
                headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(15000),
            });
            const body = await upstream.json();
            return res.status(upstream.status).json(body);
        } catch (err) {
            console.error('[DeepSeek Usage Meter]', err.message);
            return res.status(500).json({ error: 'Ollama usage request failed' });
        }
    });

    console.log('[DeepSeek Usage Meter] Plugin loaded');
}


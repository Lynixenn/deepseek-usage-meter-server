// Regression check for parsePricingPage: model-name cells carry footnote
// markers (`deepseek-v4-pro(2)`) that must not leak into the price keys.
// Run with: node test-parse.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// index.js imports SillyTavern/express modules, so evaluate the self-contained
// parser (and the constants it closes over) out of the source instead.
const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const scope = src.slice(src.indexOf('const PRICING_URL'), src.indexOf('async function fetchPricing'));
const parsePricingPage = new Function(`${scope}\nreturn parsePricingPage;`)();

const html = `
<tr><td colspan="3" style="text-align:center">MODEL</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro<sup>(2)</sup></td></tr>
<tr><td rowspan="6">PRICING<sup>(3)</sup></td><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>`;

const { models } = parsePricingPage(html);
assert.deepEqual(Object.keys(models).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
assert.equal(models['deepseek-v4-pro'].cache_hit, 0.022);
assert.equal(models['deepseek-flash'].output, 0.6);
assert.equal(models['deepseek-v4-pro(2)'], undefined, 'footnote leaked into key');
console.log('parsePricingPage: footnote-stripped model keys ok');

// Regression check for parseOllamaPricingPage: the page carries a normal rate
// card and a separate peak card, and the peak window is stated in UTC.
const ollamaScope = src.slice(src.indexOf('const OLLAMA_PRICING_URL'), src.indexOf('async function fetchOllamaPricing'));
const { parseOllamaPricingPage, isOllamaPeak } = new Function(`${ollamaScope}\nreturn { parseOllamaPricingPage, isOllamaPeak };`)();

const ollamaHtml = `
<h3>Model pricing</h3>
<table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead><tbody>
<tr><td>deepseek-v4-pro</td><td>$0.66</td><td>$0.022</td><td>$1.98</td></tr>
<tr><td>gemma4</td><td>$0.14</td><td>$0.05</td><td>$0.40</td></tr>
<tr><td>nemotron-3-nano</td><td>$0.06</td><td>-</td><td>$0.24</td></tr>
</tbody></table>
<h3>Peak pricing</h3>
<p>Peak pricing applies between 12:00 and 18:00 UTC, Monday to Friday.</p>
<table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead><tbody>
<tr><td>deepseek-v4-pro</td><td>$1.32</td><td>$0.044</td><td>$3.96</td></tr>
</tbody></table>`;

const ollama = parseOllamaPricingPage(ollamaHtml);
assert.equal(ollama.models['deepseek-v4-pro'].cache_miss, 0.66);
assert.equal(ollama.peakModels['deepseek-v4-pro'].output, 3.96);
assert.equal(ollama.models['nemotron-3-nano'].cache_hit, 0.06, '"-" cached cell should bill input at full rate');
assert.equal(ollama.models['nemotron-3-nano'].output, 0.24);
assert.deepEqual(ollama.peakHours, [{ start: 720, end: 1080 }]);
// 2026-09-14 is a Monday: 13:00 UTC is peak, 11:00 and a Saturday are not.
assert.equal(isOllamaPeak(ollama.peakHours, new Date('2026-09-14T13:00:00Z')), true);
assert.equal(isOllamaPeak(ollama.peakHours, new Date('2026-09-14T11:00:00Z')), false);
assert.equal(isOllamaPeak(ollama.peakHours, new Date('2026-09-12T13:00:00Z')), false);
console.log('parseOllamaPricingPage: peak card + UTC weekday window ok');

// The page then collapsed from two cards (base rates, then peak surcharge) into
// one table that keeps a plain row per model and adds a sibling `(Off-Peak)` row
// for models with a peak discount. Reading the plain row as the base overcharged
// every peak-window call by 2x, and the `(Off-Peak)` suffix leaked into the model
// keys as a bogus model. The two-card layout above must keep parsing.
const row = (name, input, cached, output) =>
    `<tr><td>${name}</td><td>${input}</td><td>${cached}</td><td>${output}</td></tr>`;
const singleCardHtml = `<p>Off-peak pricing apply outside 12:00 and 18:00 UTC on weekdays and all day on weekends.</p>
<table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead><tbody>
${row('clef', '$0.24', '-', '-')}
${row('deepseek-v4-pro', '$1.32', '$0.044', '$3.96')}
${row('deepseek-v4-pro (Off-Peak)', '$0.66', '$0.022', '$1.98')}
${row('gemma4', '$0.14', '$0.05', '$0.40')}
${row('nemotron-3-nano', '$0.06', '-', '$0.24')}
</tbody></table>`;

const live = parseOllamaPricingPage(singleCardHtml);
assert.ok(live, 'the single-table layout must parse');
// The base card must hold the OFF-PEAK rate, not the standard one.
assert.deepEqual(live.models['deepseek-v4-pro'], { cache_hit: 0.022, cache_miss: 0.66, output: 1.98 });
assert.deepEqual(live.peakModels['deepseek-v4-pro'], { cache_hit: 0.044, cache_miss: 1.32, output: 3.96 });
assert.equal(live.models['deepseek-v4-pro'].cache_miss * 2, live.peakModels['deepseek-v4-pro'].cache_miss,
    'the peak surcharge must be twice the base rate');
// A flat-rate model must not gain a peak row.
assert.equal(live.peakModels['gemma4'], undefined, 'flat-rate models must not be marked peak');
assert.deepEqual(live.models['gemma4'], { cache_hit: 0.05, cache_miss: 0.14, output: 0.4 });
// No `(Off-Peak)`/`(Peak)` suffix may survive as a model key. `clef` prices no
// output tokens on the live page ('-'), so it is unpriced and correctly dropped.
assert.deepEqual(Object.keys(live.models).sort(), ['deepseek-v4-pro', 'gemma4', 'nemotron-3-nano']);
assert.equal(live.models['clef'], undefined, 'a model with no output rate must not be listed');
assert.equal(live.models['deepseek-v4-pro (Off-Peak)'], undefined, 'the off-peak suffix must not survive');
// '-' in the cached column bills every token at the normal input rate.
assert.deepEqual(live.models['nemotron-3-nano'], { cache_hit: 0.06, cache_miss: 0.06, output: 0.24 });
// The reworded off-peak rule must still yield the 12:00-18:00 UTC window.
assert.deepEqual(live.peakHours, [{ start: 12 * 60, end: 18 * 60 }]);

// No tagged rows at all: every model is flat, so there is no peak card.
const flatOnly = parseOllamaPricingPage(`<table>
<thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead><tbody>
${row('solo', '$1.00', '$0.10', '$2.00')}
</tbody></table>`);
assert.deepEqual(flatOnly.models.solo, { cache_hit: 0.1, cache_miss: 1, output: 2 });
assert.deepEqual(flatOnly.peakModels, {}, 'no tagged rows means no peak card');
// An unparseable page must fall through to the built-in table.
assert.equal(parseOllamaPricingPage('<table><tr><th>Nope</th></tr></table>'), null);

console.log('parseOllamaPricingPage: single-table peak/off-peak rows ok');

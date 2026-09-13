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

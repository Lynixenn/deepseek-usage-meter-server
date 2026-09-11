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

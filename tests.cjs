// Rule tests for the COPD decision engine embedded in index.html.
// Run: node tests.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/\/\*ENGINE-START\*\/([\s\S]*?)\/\*ENGINE-END\*\//);
if (!m) throw new Error('engine block not found');
const mod = { exports: {} };
new Function('module', m[1])(mod);
const { decide } = mod.exports;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
const base = { dx: '1', fev: 55, mmrc: 2, cat: null, mod: 0, sev: 0, eos: null, cur: 'none', main: 'dysp', flags: {} };
const D = (o = {}) => decide({ ...base, ...o, flags: { ...(o.flags || {}) } });
const has = (arr, re) => arr.some(a => re.test(Array.isArray(a) ? a.join(' ') : a));

console.log('Gates');
t('ratio ≥0.70 → nodx', () => assert.equal(D({ dx: '0' }).state, 'nodx'));
t('ratio ≥0.70 + FEV1 <80 → PRISm', () => assert.ok(D({ dx: '0', fev: 70 }).prism));
t('ratio ≥0.70 + FEV1 ≥80 → not PRISm', () => assert.ok(!D({ dx: '0', fev: 90 }).prism));
t('no mMRC/CAT → need', () => assert.equal(D({ mmrc: null }).state, 'need'));
t('CAT 45 → invalid', () => assert.equal(D({ cat: 45 }).state, 'invalid'));
t('negative exacerbations → invalid', () => assert.equal(D({ mod: -1 }).state, 'invalid'));
t('fractional exacerbations → invalid', () => assert.equal(D({ sev: 1.5 }).state, 'invalid'));
t('eos 6000 → invalid', () => assert.equal(D({ eos: 6000 }).state, 'invalid'));

console.log('ABE grouping (GOLD 2026)');
t('mMRC 1, 0 exac → A', () => assert.equal(D({ mmrc: 1 }).G, 'A'));
t('CAT 10 → B', () => assert.equal(D({ mmrc: null, cat: 10 }).G, 'B'));
t('1 moderate → E', () => assert.equal(D({ mmrc: 0, mod: 1 }).G, 'E'));
t('1 moderate shows 2026 threshold note', () => assert.ok(has(D({ mod: 1 }).alerts, /單次中度惡化/)));
t('GOLD grade from FEV1', () => {
  assert.equal(D({ fev: 80 }).gold, 'GOLD 1'); assert.equal(D({ fev: 50 }).gold, 'GOLD 2');
  assert.equal(D({ fev: 30 }).gold, 'GOLD 3'); assert.equal(D({ fev: 29 }).gold, 'GOLD 4');
});

console.log('Initial therapy');
t('A → single long-acting', () => assert.match(D({ mmrc: 1 }).title, /單一長效/));
t('B → LABA+LAMA', () => assert.match(D().title, /^LABA \+ LAMA/));
t('E eos 350 → triple', () => assert.match(D({ mod: 1, eos: 350 }).title, /三合一/));
t('E eos 200 → dual', () => assert.match(D({ mod: 1, eos: 200 }).title, /^LABA \+ LAMA（雙/));
t('E eos 400 + pneumonia → dual, detail does not claim <300', () => {
  const r = D({ mod: 1, eos: 400, flags: { pna: true } });
  assert.doesNotMatch(r.title, /三合一/); assert.doesNotMatch(r.detail, /<300/); assert.match(r.detail, /≥300/);
});
t('asthma in A → ICS-containing (no ICS-free mono)', () => {
  const r = D({ mmrc: 1, flags: { asth: true } });
  assert.match(r.title, /ICS/); assert.doesNotMatch(r.title, /單一長效/);
});
t('asthma in B → triple', () => assert.match(D({ flags: { asth: true } }).title, /三合一/));
t('initial triple → NHI 3 conflict note', () => assert.ok(D({ mod: 1, eos: 350 }).nhi.some(n => n[0] === '3')));

console.log('Follow-up therapy');
t('mono + dysp → dual', () => assert.match(D({ cur: 'mono' }).title, /LABA \+ LAMA/));
t('dual + exac + eos 150 → add ICS', () => assert.match(D({ cur: 'dual', main: 'exac', mod: 1, eos: 150 }).title, /三合一/));
t('dual + exac + eos 150: steps lead with triple, not roflumilast', () =>
  assert.match(D({ cur: 'dual', main: 'exac', mod: 1, eos: 150 }).steps[0], /三合一/));
t('dual + exac + eos 80 → roflumilast/azithro', () => assert.match(D({ cur: 'dual', main: 'exac', mod: 1, eos: 80 }).title, /Roflumilast/));
t('dual + exac + NTM → no ICS', () => assert.match(D({ cur: 'dual', main: 'exac', mod: 1, eos: 350, flags: { ntm: true } }).title, /不加 ICS/));
t('dual + dysp → ensifentrine, NHI 6', () => {
  const r = D({ cur: 'dual' }); assert.match(r.title, /Ensifentrine/); assert.ok(r.nhi.some(n => n[0] === '6'));
});
t('dual + asthma → add ICS even for dyspnoea', () => assert.match(D({ cur: 'dual', flags: { asth: true } }).title, /ICS/));
t('triple + exac + eos 350 → biologics', () => assert.match(D({ cur: 'triple', main: 'exac', mod: 2, eos: 350 }).title, /生物製劑/));
t('biologic without asthma → no NHI route', () =>
  assert.ok(D({ cur: 'triple', main: 'exac', mod: 2, eos: 350 }).nhi.some(n => /無健保申請路徑/.test(n[1]))));
t('triple + exac + eos 50 → withdraw ICS', () => assert.match(D({ cur: 'triple', main: 'exac', mod: 1, eos: 50 }).title, /撤除 ICS/));
t('triple + exac + eos 50 + asthma → keep ICS', () => {
  const r = D({ cur: 'triple', main: 'exac', mod: 1, eos: 50, flags: { asth: true } });
  assert.doesNotMatch(r.title, /撤除/); assert.match(r.detail, /不撤除 ICS/);
});
t('triple + exac + eos 200 → roflumilast/azithro', () => assert.match(D({ cur: 'triple', main: 'exac', mod: 1, eos: 200 }).title, /Roflumilast/));

console.log('LABA + ICS');
t('LABA+ICS, no exac, eos 150 → switch to LABA+LAMA', () => assert.match(D({ cur: 'labaics' }).title, /改為 LABA \+ LAMA/));
t('LABA+ICS, 1 moderate + eos 150 → add LAMA', () => assert.match(D({ cur: 'labaics', main: 'exac', mod: 1, eos: 150 }).title, /加上 LAMA/));
t('LABA+ICS, add-LAMA steps do not talk about withdrawing ICS', () =>
  assert.ok(!has(D({ cur: 'labaics', main: 'exac', mod: 1, eos: 150 }).steps, /撤除/)));
t('LABA+ICS, hospitalised + eos 60 → switch (eos <100)', () => assert.match(D({ cur: 'labaics', main: 'exac', sev: 1, eos: 60 }).title, /改為 LABA \+ LAMA/));
t('LABA+ICS, 1 moderate + eos unknown → test eos first', () => assert.match(D({ cur: 'labaics', main: 'exac', mod: 1 }).title, /先檢驗/));
t('LABA+ICS, asthma → add LAMA', () => assert.match(D({ cur: 'labaics', flags: { asth: true } }).title, /加上 LAMA/));

console.log('Alerts / NHI');
t('exac selected but 0 exacerbations → consistency warning', () => assert.ok(has(D({ cur: 'dual', main: 'exac' }).alerts, /核對/)));
t('QT alert only when azithromycin is suggested', () => {
  assert.ok(!has(D({ cur: 'dual', flags: { qt: true } }).alerts, /Azithro/));
  assert.ok(has(D({ cur: 'dual', main: 'exac', mod: 1, eos: 50, flags: { qt: true } }).alerts, /Azithro/));
});
t('roflumilast NHI text has no dangling "本例、"', () => {
  const r = D({ cur: 'dual', main: 'exac', mod: 1, eos: 50, fev: 40 });
  const n = r.nhi.find(x => x[0] === '4'); assert.ok(n); assert.doesNotMatch(n[1], /本例、/);
});
t('triple with 1 moderate only → NHI 8 old Group D mismatch', () =>
  assert.ok(D({ cur: 'dual', main: 'exac', mod: 1, eos: 150 }).nhi.some(n => n[0] === '8')));
t('triple with 2 moderate + high symptoms → no NHI 8', () =>
  assert.ok(!D({ cur: 'dual', main: 'exac', mod: 2, eos: 150 }).nhi.some(n => n[0] === '8')));
t('Trimbow route needs exacerbations', () =>
  assert.ok(!D({ cur: 'labaics', fev: 40, flags: { asth: true } }).nhi.some(n => /Trimbow 的健保路徑/.test(n[1]))));
t('LABA+LAMA switch → NHI 1', () => assert.ok(D({ cur: 'labaics' }).nhi.some(n => n[0] === '1')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

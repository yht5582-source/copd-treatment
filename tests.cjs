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
t('triple + exac + eos 50 → non-ICS add-on, low eos alone does not withdraw', () => {
  const r = D({ cur: 'triple', main: 'exac', mod: 1, eos: 50 });
  assert.match(r.title, /Roflumilast/); assert.doesNotMatch(r.title, /撤除/); assert.match(r.detail, /不是撤除 ICS 的理由/);
});
t('triple + exac + eos 50 + asthma → keep ICS', () => {
  const r = D({ cur: 'triple', main: 'exac', mod: 1, eos: 50, flags: { asth: true } });
  assert.doesNotMatch(r.title, /撤除/); assert.match(r.detail, /不撤除 ICS/);
});
t('triple + exac + eos 200 → roflumilast/azithro', () => assert.match(D({ cur: 'triple', main: 'exac', mod: 1, eos: 200 }).title, /Roflumilast/));

console.log('LABA + ICS');
t('LABA+ICS, no exac, no prior response → switch to LABA+LAMA', () => assert.match(D({ cur: 'labaics', icsResp: 'no', eos: 150 }).title, /改為 LABA \+ LAMA/));
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
t('LABA+LAMA switch → NHI 1', () => assert.ok(D({ cur: 'labaics', icsResp: 'no' }).nhi.some(n => n[0] === '1')));

console.log('GOLD 2026 corrections');
t('triple + 1 moderate + eos 350 → no biologic (Fig 3.9)', () => {
  const r = D({ cur: 'triple', main: 'exac', mod: 1, eos: 350 });
  assert.doesNotMatch(r.title, /生物製劑/); assert.match(r.title, /Roflumilast/); assert.match(r.detail, /未達生物製劑門檻/);
  assert.ok(!r.nhi.some(n => n[0] === '7'));
});
t('triple + 1 moderate + eos 350 keeps ICS (not withdrawal)', () => assert.doesNotMatch(D({ cur: 'triple', main: 'exac', mod: 1, eos: 350 }).title, /撤除/));
t('triple + 2 moderate + eos 300 → biologic', () => assert.match(D({ cur: 'triple', main: 'exac', mod: 2, eos: 300 }).title, /生物製劑/));
t('triple + 1 severe + eos 300 → biologic', () => assert.match(D({ cur: 'triple', main: 'exac', sev: 1, eos: 300 }).title, /生物製劑/));
t('triple + 2 moderate + eos 299 → no biologic', () => assert.doesNotMatch(D({ cur: 'triple', main: 'exac', mod: 2, eos: 299 }).title, /生物製劑/));
const roflCase = o => D({ cur: 'dual', main: 'exac', eos: 50, fev: 40, flags: { cb: true }, ...o }).alerts;
t('roflumilast eligible only with hospitalisation', () => {
  assert.ok(has(roflCase({ sev: 1 }), /符合 roflumilast 適應族群/));
  assert.ok(!has(roflCase({ mod: 2 }), /符合 roflumilast 適應族群/));
  assert.ok(has(roflCase({ mod: 2 }), /曾因惡化住院/));
});
t('every engine roflumilast step states the hospitalisation criterion', () =>
  assert.ok(has(D({ cur: 'dual', main: 'exac', mod: 1, eos: 50 }).steps, /Roflumilast 500.*曾因惡化住院/)));
t('reference text: corrected wording present, old wording gone', () => {
  for (const x of ['PaO₂ 70–80 mmHg', '不建議用 procalcitonin 流程', '門診 ≤5 天', '&lt;10 ng/mL', '<td><b>&lt;100</b></td><td>→ 改為 <b>LABA + LAMA</b></td>']) assert.ok(html.includes(x), x);
  for (const x of ['三項具備', '&lt;20 ng/mL', '4–6 週', '<td>任何</td><td>→ 加 LAMA 成三合一</td>']) assert.ok(!html.includes(x), x);
});

console.log('Audit fixes');
const LOW = { mmrc: 0, cat: 5 };
for (const cur of ['mono', 'dual', 'labaics', 'triple']) t(`${cur}, controlled, no exacerbation → maintain`, () => {
  const r = D({ cur, main: 'ok', ...LOW }); assert.match(r.title, /維持現行治療/);
  assert.doesNotMatch(r.steps.join(' '), /升階/);
});
t('controlled but exacerbation on record → check timing, no escalation', () => assert.match(D({ cur: 'dual', main: 'ok', mod: 1, ...LOW }).title, /先確認惡化/));
t('asthma on mono/dual still needs ICS even if "controlled"', () => assert.match(D({ cur: 'dual', main: 'ok', ...LOW, flags: { asth: true } }).title, /ICS/));
t('LABA+ICS, prior response, low symptoms → continue (Fig 3.12)', () => assert.match(D({ cur: 'labaics', icsResp: 'yes', ...LOW, eos: 150 }).title, /繼續 LABA \+ ICS/));
t('LABA+ICS, prior response, high symptoms → triple (Fig 3.12)', () => assert.match(D({ cur: 'labaics', icsResp: 'yes', mmrc: 3, eos: 150 }).title, /三合一/));
t('LABA+ICS, prior response, high symptoms, pneumonia → LABA+LAMA', () => assert.match(D({ cur: 'labaics', icsResp: 'yes', mmrc: 3, flags: { pna: true } }).title, /改為 LABA \+ LAMA/));
t('LABA+ICS, no exac, high eos alone does not escalate', () => assert.doesNotMatch(D({ cur: 'labaics', icsResp: 'no', ...LOW, eos: 400 }).title, /三合一/));
t('LABA+ICS, no exac, response unknown → ask', () => assert.match(D({ cur: 'labaics', eos: 150 }).title, /先確認過去對 ICS 的反應/));
t('LABA+ICS + asthma controlled → maintain, no "should not stay" text', () => {
  const r = D({ cur: 'labaics', main: 'ok', ...LOW, flags: { asth: true } });
  assert.match(r.title, /維持現行治療/); assert.match(r.detail, /ICS 不可撤除/);
});
t('LABA+ICS + asthma uncontrolled text follows asthma principle', () => assert.match(D({ cur: 'labaics', flags: { asth: true } }).detail, /依氣喘原則/));
for (const o of [{ mod: 2 }, { sev: 1 }, { mod: 1 }]) t(`LABA+ICS exacerbating ${JSON.stringify(o)}, eos missing → test eos first`, () => assert.match(D({ cur: 'labaics', main: 'exac', ...o }).title, /先檢驗/));
t('LABA+ICS exacerbating, eos 100 → triple; eos 99 → LABA+LAMA', () => {
  assert.match(D({ cur: 'labaics', main: 'exac', mod: 1, eos: 100 }).title, /三合一/);
  assert.match(D({ cur: 'labaics', main: 'exac', mod: 1, eos: 99 }).title, /改為 LABA \+ LAMA/);
});
t('triple + low eos + pneumonia flags withdrawal as appropriate', () => assert.match(D({ cur: 'triple', main: 'exac', mod: 2, eos: 60, flags: { pna: true } }).detail, /應考慮撤除/));
const trim = o => D({ main: 'exac', fev: 40, mod: 2, eos: 150, ...o }).nhi.filter(n => /Trimbow 路徑|Trimbow 條文/.test(n[1])).map(n => n[1]).join('');
t('Trimbow: LABA+LAMA patient not eligible', () => { assert.match(trim({ cur: 'dual' }), /目前不符合/); assert.doesNotMatch(trim({ cur: 'dual' }), /可走 Trimbow/); });
t('Trimbow: LABA+ICS patient eligible', () => assert.match(trim({ cur: 'labaics' }), /可走 Trimbow/));
t('Trimbow: single exacerbation on LABA+ICS asks to confirm', () => assert.match(trim({ cur: 'labaics', mod: 1 }), /只有 1 次/));
t('dupilumab: no chronic bronchitis points to mepolizumab', () => assert.match(D({ cur: 'triple', main: 'exac', sev: 1, eos: 350 }).detail, /選 mepolizumab/));
t('ensifentrine: not suggested on monotherapy or triple', () => {
  assert.doesNotMatch(D({ cur: 'mono' }).title + D({ cur: 'mono' }).steps.join(''), /加用 Ensifentrine/);
  assert.ok(!has(D({ cur: 'triple' }).steps, /考慮加用/));
});
t('reference text: audit wording', () => {
  for (const x of ['id="q_ics"', 'data-v="ok"', '急性低血氧性呼吸衰竭的首選', 'Dupilumab <b>限有慢性支氣管炎者</b>', '條文未列 LABA+LAMA', '條文沒有 EOS 門檻']) assert.ok(html.includes(x), x);
  for (const x of ['延後啟用', '<b>第一線</b>用於急性呼吸衰竭', 'COPD 不應長期停留', '證據最一致']) assert.ok(!html.includes(x), x);
});

t('AE tab notes the Rome vs GOLD Fig 4.2 difference and its source limit', () => {
  for (const x of ['GOLD 圖與原始 Rome 提案的血氣條件不同', 'PMC12702271', '未直接核對 Celli 2021 原文']) assert.ok(html.includes(x), x);
});

console.log('Teaching tabs');
const block = (a, b) => { const x = html.match(new RegExp('/\\*' + a + '-START\\*/([\\s\\S]*?)/\\*' + a + '-END\\*/')); if (!x) throw new Error(a + ' block not found'); return new Function(x[1] + '\nreturn ' + b)(); };
const CASES = block('CASES', 'CASES'), QUIZ = block('QUIZ', 'QUIZ'), MAP = block('MAP', 'MAP');
t('6 cases with unique ids', () => { assert.equal(CASES.length, 6); assert.equal(new Set(CASES.map(c => c.id)).size, 6); });
for (const c of CASES) t(`case ${c.id}: engine gives ${c.expect.G}, ${c.expect.gold}, /${c.expect.title}/`, () => {
  const r = decide({ dx: '1', ...c.input });
  assert.equal(r.state, 'ok'); assert.equal(r.G, c.expect.G); assert.equal(r.gold, c.expect.gold); assert.match(r.title, new RegExp(c.expect.title));
});
t('case flags map to real checkboxes', () => {
  for (const c of CASES) for (const k of Object.keys(c.input.flags)) assert.ok(html.includes(`id="c_${k}"`), k);
});
t('case 4 roflumilast alert confirms eligibility', () => assert.ok(has(decide({ dx: '1', ...CASES[3].input }).alerts, /符合 roflumilast/)));
t('case 4 QT alert shows', () => assert.ok(has(decide({ dx: '1', ...CASES[3].input }).alerts, /QTc/)));
t('case 5 no asthma → no NHI route', () => assert.ok(decide({ dx: '1', ...CASES[4].input }).nhi.some(n => /無健保申請路徑/.test(n[1]))));
t('case 6 LTOT and home NIV alerts show', () => {
  const a = decide({ dx: '1', ...CASES[5].input }).alerts; assert.ok(has(a, /LTOT/)); assert.ok(has(a, /居家非侵襲性通氣/));
});
t('20 questions, 10 basic + 10 advanced', () => {
  assert.equal(QUIZ.length, 20); assert.equal(QUIZ.filter(q => q.lv === 'basic').length, 10); assert.equal(QUIZ.filter(q => q.lv === 'adv').length, 10);
});
t('each question has 4 unique options, a source and an explanation', () => {
  for (const q of QUIZ) { assert.equal(new Set(q.o).size, 4, q.q); assert.ok(q.a >= 0 && q.a < 4); assert.ok(q.e && q.s, q.q); }
});
t('answers spread A–D 5 each', () => {
  for (let i = 0; i < 4; i++) assert.equal(QUIZ.filter(q => q.a === i).length, 5, 'ABCD'[i]);
});
t('correct option is the sole longest in at most 6 questions', () => {
  const n = QUIZ.filter(q => q.o.every((x, i) => i === q.a || x.length < q.o[q.a].length)).length;
  assert.ok(n <= 6, 'longest correct: ' + n);
});
const Q = s => QUIZ.find(q => q.q.includes(s));
const ans = q => q.o[q.a];
t('quiz ↔ engine: GOLD grade', () => assert.equal(ans(Q('FEV₁ 42%')), D({ fev: 42 }).gold));
t('quiz ↔ engine: 1 moderate → E', () => { assert.match(ans(Q('Group E 門檻')), /≥1 次中度或重度/); assert.equal(D({ mmrc: 0, mod: 1 }).G, 'E'); });
t('quiz ↔ engine: Group B start', () => { assert.equal(ans(Q('未用藥的 Group B')), 'LABA + LAMA'); assert.match(D().title, /^LABA \+ LAMA/); });
t('quiz ↔ engine: Group E eos threshold', () => {
  assert.match(ans(Q('未用藥的 Group E')), /≥300/);
  assert.match(D({ mod: 1, eos: 300 }).title, /三合一/); assert.doesNotMatch(D({ mod: 1, eos: 299 }).title, /三合一/);
});
t('quiz ↔ engine: dual + eos 180 → triple', () => { assert.match(ans(Q('Eos 180')), /三合一/); assert.match(D({ cur: 'dual', main: 'exac', mod: 1, eos: 180 }).title, /三合一/); });
t('quiz ↔ engine: dual + eos 60, no roflumilast criteria', () => {
  assert.match(ans(Q('Eos 60、FEV₁ 62%')), /azithromycin/);
  assert.ok(has(D({ cur: 'dual', main: 'exac', mod: 1, eos: 60, fev: 62 }).alerts, /不符合或尚無法確認/));
});
t('quiz ↔ engine: triple + eos 340, no CB → mepolizumab mentioned', () => {
  assert.equal(ans(Q('沒有慢性支氣管炎。若要用生物製劑')), 'Mepolizumab');
  assert.match(D({ cur: 'triple', main: 'exac', sev: 1, eos: 340, fev: 45 }).detail, /mepolizumab/);
});
t('quiz ↔ engine: both problems → exacerbation path', () => {
  assert.equal(ans(Q('持續呼吸困難與惡化')), '惡化路徑');
  assert.equal(D({ cur: 'dual', main: 'both', mod: 1, eos: 150 }).title, D({ cur: 'dual', main: 'exac', mod: 1, eos: 150 }).title);
});
t('quiz ↔ engine: initial triple → NHI 3', () => {
  assert.match(ans(Q('想直接起始三合一')), /雙療法/); assert.ok(D({ mod: 1, eos: 350 }).nhi.some(n => n[0] === '3'));
});
t('mind map has both sides with sourced leaves', () => {
  assert.ok(MAP.left.length >= 4 && MAP.right.length >= 4);
  for (const [, lv] of [...MAP.left, ...MAP.right]) for (const [x, s] of lv) assert.ok(x && s);
});
t('tabs and sections exist for #cases #quiz #map', () => {
  for (const id of ['cases', 'quiz', 'map']) { assert.ok(html.includes(`data-t="${id}"`)); assert.ok(html.includes(`<section id="${id}">`)); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

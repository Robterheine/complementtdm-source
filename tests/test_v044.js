'use strict';
/* v0.44.0 — input safety (review 2026-09-30, H1 and H2).
 *
 * H1. A session file is something colleagues e-mail each other, and the import
 *     path let its values reach innerHTML: a dose amount of
 *     "900<img src=x onerror=...>" ran script in the built app, and a sample
 *     note containing a double quote broke out of its value="" attribute,
 *     because esc() did not escape quotes. Fixed twice over: esc() now escapes
 *     both quote characters, and every session (file import AND autosave
 *     restore) passes through cleanSession(), which refuses anything that is
 *     not a finite number / known route / parseable date before it can reach
 *     the state, the tables or the engine.
 *
 * H2. A dose whose time is NaN (an unparseable date in an imported file) sent
 *     simulate() into an infinite loop: events are grouped with
 *     `ev[i].t === tEv`, which is never true for NaN, so the index never
 *     advances. The F21 guard (|t| > 1e5) is false for NaN. That froze the
 *     browser tab. runFit and simulate now refuse a non-finite time.
 *
 * The NaN checks run in a child process with a timeout: against the old code
 * the call never returns, and that must show up as a failed assertion, not as
 * a hung test run.
 */
var cp = require('child_process');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/chart.js');
require('../src/diagnostics.js');
require('../src/ui.js');

var ROOT = require('path').resolve(__dirname, '..');

function inChild(code) {
  var pre = "global.ECU={};require(" + JSON.stringify(ROOT + '/src/model.js') + ");require(" +
    JSON.stringify(ROOT + '/src/bayes.js') + ");var M=ECU.model,B=ECU.bayes;";
  var r = cp.spawnSync(process.execPath, ['-e', pre + code], { timeout: 20000, encoding: 'utf8' });
  return { timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM', out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function iso(daysAgo) { return new Date(Date.UTC(2026, 8, 30, 9) - daysAgo * 86400000).toISOString(); }
function good() {
  return {
    app: 'mab-tdm', version: '0.44.0', drug: 'eculizumab', mode: 'full',
    patient: { code: 'ID1', wt: 70, age: null, disease: 'PNH' },
    target: { value: 75 }, lloq: 10, errMult: 1, recency: 'off', priorTx: 'no',
    report: { preparedBy: 'me', advice: 'x' }, plan: { amt: null, interval: null },
    doses: [{ t: iso(28), amt: 900, route: null }, { t: iso(14), amt: 900, route: null, dur: 45 / 1440 }],
    obs: [{ t: iso(14.01), c: 95, lloq: false, exclude: false, note: '' },
          { t: iso(20), c: null, lloq: true, exclude: true, note: 'after PLEX' }]
  };
}
function throws(fn) { try { fn(); return null; } catch (e) { return e.message || String(e); } }

async function run() {
  var t = new T('v0.44.0 input safety: import validation, quote escaping, NaN times');

  // ---- H1: esc() ------------------------------------------------------------
  t.ok(typeof ECU.esc === 'function', 'ECU.esc is exported for testing');
  if (typeof ECU.esc !== 'function' || typeof ECU.cleanSession !== 'function') {
    t.ok(false, 'ECU.cleanSession is exported for testing');
  }
  if (typeof ECU.esc === 'function') {
    var e = ECU.esc('a"b\'c<d>&e');
    t.ok(e.indexOf('"') < 0 && e.indexOf("'") < 0, 'esc() leaves no raw quote characters: ' + e);
    t.eq(e, 'a&quot;b&#39;c&lt;d&gt;&amp;e', 'esc() output');
    var attr = '<input value="' + ECU.esc('x" autofocus onfocus="alert(1)" data-y="') + '">';
    t.eq((attr.match(/"/g) || []).length, 2, 'a hostile note cannot close the value="" attribute');
  }
  t.ok(require('fs').readFileSync(ROOT + '/src/diagnostics.js', 'utf8').indexOf('&quot;') > 0, 'diagnostics.js esc() escapes quotes too');
  t.ok(require('fs').readFileSync(ROOT + '/src/chart.js', 'utf8').indexOf('&quot;') > 0, 'chart.js esc()/escT() escape quotes too');

  // ---- H1: cleanSession ------------------------------------------------------
  if (typeof ECU.cleanSession === 'function') {
    var c = ECU.cleanSession(good());
    t.eq(c.drug, 'eculizumab', 'valid session: drug kept');
    t.eq(c.doses.length, 2, 'valid session: doses kept');
    t.ok(typeof c.doses[0].t === 'number' && isFinite(c.doses[0].t), 'valid session: dose times are finite milliseconds');
    t.closeTo(c.doses[1].dur, 45 / 1440, 1e-12, 'valid session: a custom infusion duration survives');
    t.eq(c.obs[1].note, 'after PLEX', 'valid session: exclusion note survives');
    t.ok(c.obs[1].lloq === true && c.obs[1].c === null && c.obs[1].exclude === true, 'valid session: censored, excluded sample survives');
    t.eq(c.lloq, 10, 'valid session: LLOQ kept');
    t.eq(c.priorTx, 'no', 'valid session: prior-treatment answer kept');

    var d = good(); d.doses[0].amt = '900<img src=x onerror="window.x=1">';
    t.ok(/dose 1/i.test(throws(function () { ECU.cleanSession(d); }) || ''), 'a dose amount carrying markup is refused, naming the dose');
    d = good(); d.doses[0].amt = '900';
    var cn = ECU.cleanSession(d);
    t.ok(cn.doses[0].amt === 900 && typeof cn.doses[0].amt === 'number', 'a numeric-string amount is coerced to a number');
    d = good(); d.doses[1].t = 'not-a-date';
    t.ok(/dose 2/i.test(throws(function () { ECU.cleanSession(d); }) || ''), 'an unparseable dose date is refused (this is the NaN that froze the tab)');
    d = good(); delete d.doses[1].t;
    t.ok(throws(function () { ECU.cleanSession(d); }), 'a missing dose date is refused');
    d = good(); d.doses[0].amt = null;
    t.ok(throws(function () { ECU.cleanSession(d); }), 'a missing dose amount is refused');
    d = good(); d.doses[0].amt = -900;
    t.ok(throws(function () { ECU.cleanSession(d); }), 'a negative dose amount is refused');
    d = good(); d.doses[0].route = 'foo';
    t.ok(throws(function () { ECU.cleanSession(d); }), 'an unknown route is refused');
    d = good(); d.doses[0].dur = 'x';
    t.ok(throws(function () { ECU.cleanSession(d); }), 'a non-numeric infusion duration is refused');
    d = good(); d.obs[0].c = 'abc';
    t.ok(/sample 1|measurement 1/i.test(throws(function () { ECU.cleanSession(d); }) || ''), 'a non-numeric concentration is refused, naming the sample');
    d = good(); d.obs[0].t = 'nope';
    t.ok(throws(function () { ECU.cleanSession(d); }), 'an unparseable sample date is refused');
    d = good(); d.lloq = '<img src=x onerror="window.x=1">';
    t.ok(throws(function () { ECU.cleanSession(d); }), 'an LLOQ carrying markup is refused');
    d = good(); d.lloq = '12';
    t.eq(ECU.cleanSession(d).lloq, 12, 'a numeric-string LLOQ is coerced');
    d = good(); d.patient.wt = 'heavy';
    t.ok(throws(function () { ECU.cleanSession(d); }), 'a non-numeric weight is refused');
    d = good(); d.patient.disease = '<b>x</b>';
    t.eq(ECU.cleanSession(d).patient.disease, 'PNH', 'an unknown disease falls back to PNH rather than travelling on');
    d = good(); d.drug = 'nonsense';
    t.eq(ECU.cleanSession(d).drug, 'eculizumab', 'an unknown drug falls back to eculizumab (unchanged behaviour)');
    d = good(); d.obs[1].note = 'x" autofocus onfocus="window.x=1" data-y="';
    t.eq(ECU.cleanSession(d).obs[1].note, 'x" autofocus onfocus="window.x=1" data-y="', 'a note is free text and is kept verbatim (it is escaped on output, not stripped)');
    t.ok(throws(function () { ECU.cleanSession({}); }), 'a file without a dose list is refused');
    t.ok(throws(function () { ECU.cleanSession(null); }), 'null is refused');

    // the autosave shape (state.doses as stored: t already in epoch ms)
    var auto = good(); auto.doses = [{ t: Date.parse(iso(28)), amt: 900, route: null }]; auto.obs = [{ t: Date.parse(iso(14.01)), c: 95, lloq: false }];
    var ca = ECU.cleanSession(auto);
    t.ok(ca.doses.length === 1 && isFinite(ca.doses[0].t), 'autosave shape (epoch-ms times) is accepted');
    auto.doses[0].t = null;
    t.ok(throws(function () { ECU.cleanSession(auto); }), 'an autosave dose whose time was serialised as null is refused');
  }

  // ---- H1: both restore paths go through cleanSession -----------------------
  var ui = require('fs').readFileSync(ROOT + '/src/ui.js', 'utf8');
  function bodyOf(name) {
    var s = ui.indexOf('function ' + name + '(');
    if (s < 0) return '';
    var en = ui.indexOf('\n  }', s);
    return en < 0 ? ui.slice(s) : ui.slice(s, en + 4);
  }
  t.ok(/cleanSession\(/.test(bodyOf('importJson')), 'importJson() validates through cleanSession()');
  t.ok(/cleanSession\(/.test(bodyOf('applySession')) || /cleanSession\(/.test(bodyOf('offerRestore')), 'the autosave restore path validates through cleanSession() too');
  t.ok(!/<b>' \+ d\.amt \+ '<\/b>/.test(ui), 'the dose table no longer interpolates d.amt raw');
  t.ok(ui.indexOf('esc(String(d.amt))') >= 0, 'the dose table escapes d.amt');
  t.ok(ui.indexOf("esc(String(state.lloq || 'LLOQ'))") >= 0, 'the measurement table escapes state.lloq');
  t.ok(ui.indexOf("LLOQ = ' + esc(String(state.lloq))") >= 0, 'the LLOQ advisory escapes state.lloq');

  // ---- H2: NaN times ----------------------------------------------------------
  var r1 = inChild(
    "B.runFit({wt:70,disease:'PNH',doses:[{t:0,amt:900},{t:NaN,amt:900},{t:28,amt:900}],obs:[{t:27.9,c:95}],target:75,seed:1,mcmcIters:400,priorDraws:50},{})" +
    ".then(function(){console.log('RESOLVED')}).catch(function(e){console.log('THREW:'+e.message)})");
  t.ok(!r1.timedOut, 'runFit with a NaN dose time returns instead of hanging' + (r1.timedOut ? ' (TIMED OUT after 20 s)' : ''));
  t.ok(/^THREW:.*(time|date)/i.test(r1.out), 'runFit refuses a NaN dose time with a message about time: ' + (r1.out || r1.err).slice(0, 120));

  var r2 = inChild(
    "try{var p=M.indivParams(70,'PNH',[0,0],'eculizumab');M.simulate([{t:0,amt:900},{t:NaN,amt:900}],[5],p,{id:'eculizumab'});console.log('RESOLVED')}catch(e){console.log('THREW:'+e.message)}");
  t.ok(!r2.timedOut, 'simulate() with a NaN dose time returns instead of hanging' + (r2.timedOut ? ' (TIMED OUT after 20 s)' : ''));
  t.ok(/^THREW/.test(r2.out), 'simulate() throws on a NaN dose time');

  var r3 = inChild(
    "try{var p=M.indivParams(70,'PNH',[0,0],'eculizumab');M.simulate([{t:0,amt:900}],[5,NaN],p,{id:'eculizumab'});console.log('RESOLVED')}catch(e){console.log('THREW:'+e.message)}");
  t.ok(!r3.timedOut && /^THREW/.test(r3.out), 'simulate() throws on a NaN output time');

  var r4 = inChild(
    "B.runFit({wt:70,disease:'PNH',doses:[{t:0,amt:900},{t:Infinity,amt:900}],obs:[],target:75,seed:1,priorDraws:50},{})" +
    ".then(function(){console.log('RESOLVED')}).catch(function(e){console.log('THREW:'+e.message)})");
  t.ok(!r4.timedOut && /^THREW/.test(r4.out), 'runFit refuses an infinite dose time');

  // the legitimate path is untouched
  var okFit = await B.runFit({ wt: 70, disease: 'PNH', doses: [{ t: 0, amt: 900 }, { t: 14, amt: 900 }, { t: 28, amt: 900 }],
    obs: [{ t: 27.99, c: 95, lloq: false }], target: 75, seed: 1, mcmcIters: 800, priorDraws: 100 }, {});
  t.ok(okFit.hasObs && okFit.troughs.length >= 2, 'a normal fit still runs');

  return t.summary();
}

module.exports = { run: run };

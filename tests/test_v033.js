'use strict';
/* v0.33.0 — "Getting started" guide, opened in its own browser window.
 *
 * Author request: a short, step-by-step walkthrough for a first-time user
 * (a clinician, not a pharmacometrician), reachable from a new header button,
 * opened in a REAL second window rather than a modal -- so it can sit beside
 * the primary interface while someone actually works through the steps,
 * instead of blocking the thing it describes. Content went through a
 * humanizer pass (author's own skill, v1.9.0) before shipping.
 *
 * Design, per the approved plan (not re-litigated here, just tested):
 *   - a single scrollable page, not a step-syncing wizard (see the plan's
 *     own reasoning: syncing two windows is real engineering this project
 *     isn't taking on speculatively, and a stale sync would be worse than
 *     none);
 *   - content lives once, as gettingStartedBodyHtml() -- reused both by the
 *     real popup (wrapped in a full HTML document, its own <style>, no
 *     dependency on app.css which doesn't exist as a separate file in the
 *     single-file build) and by a same-pattern-as-About fallback modal, for
 *     the rare case a popup blocker refuses window.open().
 */
var fs = require('fs');
var T = require('./util.js').T;

async function run() {
  var t = new T('v0.33.0 Getting started guide (separate window + humanized content)');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ---- 1. the header button exists -----------------------------------------
  t.ok(html.indexOf('id="btnGettingStarted"') >= 0, 'a "Getting started" button exists in the header');
  t.ok(html.indexOf('id="btnGettingStarted"') < html.indexOf('id="btnAbout"'),
    'the Getting started button sits before About -- most relevant to a first-time user first');
  t.ok(/id="btnGettingStarted"[^>]*>Getting started</.test(html), 'the button label reads exactly "Getting started"');

  // ---- 2. the fallback modal exists (popup-blocker path) -------------------
  t.ok(html.indexOf('id="gettingStartedModal"') >= 0, 'a fallback modal exists for a blocked popup');
  t.ok(html.indexOf('id="gettingStartedBody"') >= 0, 'the fallback modal has a body container to fill');
  t.ok(html.indexOf('id="gettingStartedClose"') >= 0, 'the fallback modal has its own close button');

  // ---- 3. content: one shared fragment, two wrappers ------------------------
  t.ok(ui.indexOf('function gettingStartedBodyHtml') >= 0,
    'the guide content is a single function, not duplicated between the popup and the fallback modal');
  t.ok(ui.indexOf('function gettingStartedDocHtml') >= 0,
    'a separate function wraps that content into a full HTML document for the real popup window');
  t.ok(ui.indexOf('ECU.gettingStartedBodyHtml') >= 0 && ui.indexOf('ECU.gettingStartedDocHtml') >= 0,
    'both are exported for headless testability, matching the aboutHtml()/reportHtml() convention');

  var bodyFnStart = ui.indexOf('function gettingStartedBodyHtml');
  var bodyFnEnd = ui.indexOf('\n  function ', bodyFnStart + 10);
  var bodyFnSrc = ui.slice(bodyFnStart, bodyFnEnd);

  // ---- 4. the four app cards are all represented, by their real titles -----
  ['Drug &amp; patient', 'Dosing schedule &amp; measured concentrations', 'Forecast', 'Regimen explorer'].forEach(function (title) {
    t.ok(bodyFnSrc.indexOf(title) >= 0, 'the guide names the real card title "' + title.replace('&amp;', '&') + '" verbatim, not a paraphrase that could drift from the UI');
  });

  // ---- 5. it points to the report/export/about features by their real labels
  ['Run forecast', 'Print report', 'Export session', 'About'].forEach(function (label) {
    t.ok(bodyFnSrc.indexOf(label) >= 0, 'the guide references the real "' + label + '" control by its exact on-screen label');
  });

  // ---- 6. the never-suggests-a-dose principle is stated, matching golden
  //         rule 2 of this project (the app never recommends a regimen) -----
  t.ok(bodyFnSrc.toLowerCase().indexOf('never suggest') >= 0 || bodyFnSrc.toLowerCase().indexOf('not a recommendation') >= 0,
    'the guide itself states the app never suggests a dose/interval, not just the app -- a first-time reader should learn this before they start');

  // ---- 7. humanizer discipline: no em-dash anywhere in the shipped copy ----
  t.ok(bodyFnSrc.indexOf('—') < 0, 'the guide content has no em-dash (humanizer hard rule)');

  // ---- 8. the popup path: a real second window, reused on repeat clicks ----
  t.ok(ui.indexOf('function openGettingStarted') >= 0, 'a dedicated open function exists');
  var openFnStart = ui.indexOf('function openGettingStarted');
  var openFnEnd = ui.indexOf('\n  function ', openFnStart + 10);
  var openFnSrc = ui.slice(openFnStart, openFnEnd);
  t.ok(/window\.open\(\s*['"]['"]\s*,\s*['"]ctdmGettingStarted['"]/.test(openFnSrc),
    'opens (or reuses, by name) a real named window, not an anonymous one that would multiply on repeat clicks');
  t.ok(openFnSrc.indexOf('gettingStartedDocHtml()') >= 0, 'writes the full-document wrapper into the popup, not the bare fragment');
  t.ok(openFnSrc.indexOf('document.close()') >= 0, 'closes the write stream on the popup document (required for some browsers to finish rendering)');

  // ---- 9. popup-blocker fallback: falls back to the existing modal pattern -
  t.ok(openFnSrc.indexOf('gettingStartedBodyHtml()') >= 0, 'the fallback path uses the bare fragment (styled by the app\'s own app.css already loaded on the page)');
  t.ok(openFnSrc.indexOf("openModal('gettingStartedModal'") >= 0,
    'a blocked popup falls back to the existing openModal() helper, not a silent no-op');

  // ---- 10. wiring: button click, close button, backdrop click, Escape ------
  t.ok(ui.indexOf("$('btnGettingStarted').addEventListener('click', openGettingStarted)") >= 0,
    'the header button is wired to the open function');
  t.ok(ui.indexOf("$('gettingStartedClose').addEventListener('click'") >= 0, 'the fallback modal\'s close button is wired');
  t.ok(ui.indexOf("$('gettingStartedModal').hidden") >= 0,
    'Escape closes the fallback modal too, matching the existing About/report/diagnostics modals');

  return t.summary();
}

module.exports = { run: run };

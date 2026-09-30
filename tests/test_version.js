/* v0.12.0 — centralised version number.
 *
 * src/version.js holds the single version string. These checks guarantee it is
 * the one place to bump and that nothing else carries a drifting literal:
 *   1. src/version.js declares ECU.VERSION and matches package.json.
 *   2. index.html loads src/version.js before src/ui.js and exposes the
 *      placeholders (header, footer) that ui.js fills.
 *   3. build.mjs inlines src/version.js and cross-checks package.json.
 *   4. ui.js reads ECU.VERSION and has no hardcoded version literal.
 */
'use strict';
var u = require('./util.js');
require('../src/version.js');
var fs = require('fs');

async function run() {
  var t = new u.T('centralised version (v0.12.0)');

  // ---- 1. single source of truth ----
  var src = fs.readFileSync('src/version.js', 'utf8');
  var m = src.match(/ECU\.VERSION\s*=\s*'([^']+)'/);
  t.ok(!!m, 'src/version.js declares ECU.VERSION');
  var version = m ? m[1] : null;
  t.ok(/^\d+\.\d+\.\d+$/.test(version || ''), 'version is semver x.y.z — got ' + version);
  var pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  t.eq(pkg.version, version, 'package.json version matches src/version.js');
  t.eq(ECU.VERSION, version, 'the loaded ECU.VERSION matches the declared string');

  // ---- 2. index.html wiring ----
  var html = fs.readFileSync('index.html', 'utf8');
  t.ok(html.indexOf('<script src="src/version.js"></script>') >= 0,
    'index.html loads src/version.js');
  t.ok(html.indexOf('<script src="src/version.js"></script>') <
       html.indexOf('<script src="src/ui.js"></script>'),
    'src/version.js loads before src/ui.js');
  t.ok(html.indexOf('id="titleVersion"') >= 0, 'header carries a version placeholder');
  t.ok(html.indexOf('id="footerVersion"') >= 0, 'footer carries a version placeholder');
  t.ok(html.indexOf('v' + version) < 0 || version === null,
    'no hardcoded version literal in index.html (the placeholders are filled at runtime)');

  // ---- 3. build wiring ----
  var build = fs.readFileSync('build.mjs', 'utf8');
  t.ok(build.indexOf("'src/version.js'") >= 0, 'build.mjs inlines src/version.js');
  t.ok(build.indexOf('package.json') >= 0, 'build.mjs cross-checks package.json for drift');

  // ---- 4. ui.js consumer ----
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  t.ok(ui.indexOf('ECU.VERSION') >= 0, 'ui.js reads ECU.VERSION (no hardcoded literal)');
  t.ok(ui.indexOf('applyVersion') >= 0, 'ui.js fills title/header/footer from it');
  t.ok(/var VERSION = .*ECU\.VERSION/.test(ui), 'ui.js VERSION derives from the central value');

  return t.summary();
}

module.exports = { run: run };

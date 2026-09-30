/* Build script: inline src/app.css + src modules into a single self-contained
 * complementtdm.html artifact (works offline from file://, no dependencies). */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(fileURLToPath(import.meta.url));
const FILES = ['src/version.js', 'src/model.js', 'src/bayes.js', 'src/chart.js', 'src/diagnostics.js', 'src/ui.js'];

// Central version check: src/version.js is the single source of truth; keep
// package.json in step with it (the build warns loudly if they drift).
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const verSrc = readFileSync(resolve(root, 'src/version.js'), 'utf8');
const verMatch = verSrc.match(/ECU\.VERSION\s*=\s*'([^']+)'/);
const appVersion = verMatch ? verMatch[1] : '0.0.0';
if (pkg.version !== appVersion) {
  console.warn('WARNING: package.json version ' + pkg.version + ' does not match src/version.js ' + appVersion);
}

let html = readFileSync(resolve(root, 'index.html'), 'utf8');

const css = readFileSync(resolve(root, 'src/app.css'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="src\/app\.css">/,
  () => '<style>\n/* app.css (inlined) */\n' + css + '\n</style>');

for (const f of FILES) {
  const js = readFileSync(resolve(root, f), 'utf8');
  const marker = new RegExp('<script src="' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"></script>');
  if (!marker.test(html)) {
    console.error('Missing script tag for ' + f);
    process.exit(1);
  }
  html = html.replace(marker, () => '<script>\n/* ' + f + ' (inlined) */\n' + js + '\n</script>');
}

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
html = html.replace(/__BUILD__/, stamp);

const out = resolve(root, 'complementtdm.html');
writeFileSync(out, html);
console.log('Built ' + out + ' (v' + appVersion + ', ' + (html.length / 1024).toFixed(1) + ' KB, built ' + stamp + ')');

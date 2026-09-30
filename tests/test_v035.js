'use strict';
/* v0.35.0 — author photo in the About dialog.
 *
 * Author request: add a small circular photo of the author, with name and
 * research group, at the bottom of the About dialog.
 *
 * Implementation: the photo (author-provided headshot, already circular-
 * cropped, 170x170 WebP) is embedded as a base64 data URI in a module-level
 * `AUTHOR_PHOTO_URI` constant in src/ui.js, so the single-file offline build
 * still needs no external request for it. aboutHtml() appends a small
 * `.about-photo` block (photo + caption) after the existing Contact section.
 * The caption text goes through esc() like every other piece of dynamic
 * content in aboutHtml(), and (per this project's own em-dash-free
 * convention, applied to all app text) uses a comma rather than an em-dash.
 */
var fs = require('fs');
var T = require('./util.js').T;

async function run() {
  var t = new T('v0.35.0 author photo in the About dialog');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var css = fs.readFileSync('src/app.css', 'utf8');

  // ---- 1. the photo is embedded as a data URI, not an external reference --
  var uriMatch = ui.match(/var AUTHOR_PHOTO_URI = '(data:image\/webp;base64,[^']+)';/);
  t.ok(!!uriMatch, 'AUTHOR_PHOTO_URI is defined as an inline data: URI (no external request)');
  if (uriMatch) {
    t.ok(uriMatch[1].length > 10000, 'the embedded photo is a real image, not a placeholder (base64 length ' + uriMatch[1].length + ')');
  }

  // ---- 2. locate aboutHtml()'s source -------------------------------------
  var fnStart = ui.indexOf('function aboutHtml() {');
  var fnEnd = ui.indexOf('\n  function ', fnStart + 10);
  var fnSrc = ui.slice(fnStart, fnEnd);
  t.ok(fnStart >= 0 && fnEnd > fnStart, 'located aboutHtml() source');

  // ---- 3. the photo block sits after Contact, at the bottom --------------
  var contactIdx = fnSrc.indexOf('<h3>Contact</h3>');
  var photoIdx = fnSrc.indexOf('about-photo');
  t.ok(contactIdx >= 0, 'the existing Contact section is still present');
  t.ok(photoIdx > contactIdx, 'the photo block comes after Contact, at the bottom of the dialog');
  t.ok(fnSrc.indexOf('AUTHOR_PHOTO_URI') >= 0, 'the photo block actually uses the embedded data URI');
  t.ok(/about-photo[\s\S]{0,40}<img src="'\s*\+\s*AUTHOR_PHOTO_URI/.test(fnSrc),
    'the <img> tag is inside the .about-photo container and sources AUTHOR_PHOTO_URI');

  // ---- 4. name + research group caption, escaped like other dynamic text -
  t.ok(fnSrc.indexOf("esc('Rob ter Heine, Dept. of Pharmacy, Pharmacology & Toxicology, Radboudumc & Radboud Applied Pharmacometrics research group')") >= 0,
    'the caption names Rob ter Heine, the department and the research group, passed through esc() like other about-dialog text');
  t.ok(fnSrc.indexOf('—') < 0, 'no em-dash in the new photo caption (project convention)');

  // ---- 5. CSS: a small, circular photo -------------------------------------
  t.ok(/\.modal \.about-photo img\s*\{[^}]*border-radius:\s*50%/.test(css),
    'the photo is styled circular');
  t.ok(/\.modal \.about-photo img\s*\{[^}]*width:\s*56px/.test(css),
    'the photo is sized small (56px), not a full-width image');

  return t.summary();
}

module.exports = { run: run };

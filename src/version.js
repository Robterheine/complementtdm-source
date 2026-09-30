/* =========================================================================
 * Single source of truth for the application version.
 *
 * Bump the string below whenever the app changes. It is consumed by
 * src/ui.js (browser title, header, footer, About dialog, session export)
 * and checked against package.json by build.mjs and tests/test_version.js,
 * so the two can never silently drift apart.
 * ========================================================================= */
(function (root) {
  'use strict';
  var ECU = root.ECU = root.ECU || {};
  ECU.VERSION = '0.46.0';
})(typeof window !== 'undefined' ? window : globalThis);

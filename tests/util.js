'use strict';
/* Shared harness for the node test suites. Loads the src modules (they attach
 * to globalThis.ECU) and provides a lightweight assertion collector. */

global.ECU = global.ECU || {};
require('../src/model.js');
require('../src/bayes.js');

var M = ECU.model, B = ECU.bayes;

function T(name) {
  this.name = name;
  this.pass = 0;
  this.fail = 0;
  this.msgs = [];
}
T.prototype.ok = function (cond, msg) {
  if (cond) { this.pass++; } else { this.fail++; this.msgs.push('FAIL: ' + msg); }
};
T.prototype.eq = function (a, b, msg) {
  this.ok(a === b, (msg || '') + ' — expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
};
T.prototype.close = function (a, b, tol, msg) {
  var scale = Math.max(1, Math.abs(a), Math.abs(b));
  this.ok(Math.abs(a - b) <= tol * scale,
    (msg || '') + ' — expected ' + b + ' ±' + (tol * 100) + '% , got ' + a);
};
T.prototype.closeTo = function (a, b, absTol, msg) {
  this.ok(Math.abs(a - b) <= absTol,
    (msg || '') + ' — expected ' + b + ' ±' + absTol + ', got ' + a);
};
T.prototype.done = function () { return this.summary(); };
T.prototype.info = function (msg) { this.msgs.push('info: ' + msg); };
T.prototype.summary = function () {
  return { name: this.name, pass: this.pass, fail: this.fail, msgs: this.msgs };
};

module.exports = { M: M, B: B, T: T };

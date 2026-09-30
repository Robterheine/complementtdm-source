'use strict';
/* Test runner: node tests/run_all.js */
const suites = [
  require('./test_model'),
  require('./test_bayes'),
  require('./test_stress'),
  require('./test_ss'),
  require('./test_drugs'),
  require('./test_routes'),
  require('./test_crovalimab'),
  require('./test_audit'),
  require('./test_stats'),
  require('./test_multieta'),
  require('./test_e2e_fit'),
  require('./test_diagnostics'),
  require('./test_empty_fields'),
  require('./test_report'),
  require('./test_usability'),
  require('./test_version'),
  require('./test_model_verify'),
  require('./test_v013'),
  require('./test_v014'),
  require('./test_v015'),
  require('./test_v017'),
  require('./test_v018'),
  require('./test_v019'),
  require('./test_session_restore'),
  require('./test_v021'),
  require('./test_v022'),
  require('./test_v023'),
  require('./test_v024'),
  require('./test_v025'),
  require('./test_v026'),
  require('./test_v027'),
  require('./test_v028'),
  require('./test_v029'),
  require('./test_v030'),
  require('./test_v031'),
  require('./test_v032'),
  require('./test_v033'),
  require('./test_v034'),
  require('./test_v035'),
  require('./test_v036'),
  require('./test_v037'),
  require('./test_v038'),
  require('./test_v039'),
  require('./test_v040'),
  require('./test_v041'),
  require('./test_v042'),
  require('./test_v043'),
  require('./test_v044'),
  require('./test_v045'),
  require('./test_v046')
];

(async function () {
  let totalPass = 0, totalFail = 0;
  const t0 = Date.now();
  for (const s of suites) {
    const start = Date.now();
    const res = await s.run();
    totalPass += res.pass;
    totalFail += res.fail;
    console.log('\n== ' + res.name + ' ==');
    res.msgs.forEach(m => console.log('   ' + m));
    console.log('   ' + (res.fail ? 'FAILED' : 'PASS') + '  ' + res.pass + ' passed, ' + res.fail +
      ' failed  (' + (Date.now() - start) + ' ms)');
  }
  console.log('\nTotal: ' + totalPass + ' passed, ' + totalFail + ' failed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  process.exit(totalFail ? 1 : 0);
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});

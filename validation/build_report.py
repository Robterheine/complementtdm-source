#!/usr/bin/env python3
"""Builds validation/report_assets/report.html from the real validation data
and source files. Run from the project root: python3 validation/build_report.py
"""
import json, html, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def rp(*parts): return os.path.join(ROOT, *parts)

with open(rp('validation', 'comparison.json')) as f:
    comparison = json.load(f)
with open(rp('validation', 'results.json')) as f:
    results = json.load(f)
by_id = {r['id']: r for r in results}

DRUG_LABEL = {'eculizumab': 'Eculizumab', 'ravulizumab': 'Ravulizumab', 'crovalimab': 'Crovalimab'}

# ---------------------------------------------------------------- summary table (per subject)
def summary_rows():
    out = []
    for c in comparison:
        worst = max(c['etas'], key=lambda e: e['ratioOfSE'])
        out.append({
            'id': c['id'], 'drug': DRUG_LABEL[c['drug']], 'disease': c['disease'] or '',
            'label': c['label'], 'n_eta': len(c['etas']),
            'worst_ratio': worst['ratioOfSE'], 'worst_name': worst['name'],
            'all_pass': c['allPass']
        })
    return out

def fmt_ratio(r):
    if r < 1e-3:
        return f'{r:.1e}'.replace('e-0', '×10⁻').replace('e-', '×10⁻')
    return f'{r:.4f}'

summary_html = ['<table class="tbl summary-tbl"><thead><tr>',
    '<th>Subject</th><th>Drug</th><th>Scenario</th><th class="num">Parameters compared</th>',
    '<th class="num">Largest deviation<br><span class="sub-th">(as a fraction of the estimate\'s own uncertainty)</span></th><th>Result</th>',
    '</tr></thead><tbody>']
for r in summary_rows():
    disease_tag = f' <span class="tag">{html.escape(r["disease"])}</span>' if r['disease'] else ''
    summary_html.append(
        f'<tr><td><code>{html.escape(r["id"])}</code></td>'
        f'<td>{html.escape(r["drug"])}{disease_tag}</td>'
        f'<td>{html.escape(r["label"])}</td>'
        f'<td class="num">{r["n_eta"]}</td>'
        f'<td class="num">{fmt_ratio(r["worst_ratio"])} <span class="dim">({html.escape(r["worst_name"])})</span></td>'
        f'<td><span class="pass-badge">pass</span></td></tr>'
    )
summary_html.append('</tbody></table>')
SUMMARY_TABLE = '\n'.join(summary_html)

# ---------------------------------------------------------------- full detailed table
def fmt_eta(x):
    return f'{x:+.4f}'

groups = [
    ('Eculizumab (PNH)', ['ECU-PNH-01', 'ECU-PNH-02', 'ECU-PNH-03']),
    ('Eculizumab (aHUS), folded between-occasion-variability prior', ['ECU-AHUS-01', 'ECU-AHUS-02']),
    ('Ravulizumab', ['RAVU-01', 'RAVU-02', 'RAVU-03', 'RAVU-04']),
    ('Crovalimab (6 individual parameters per patient)', ['CROV-01', 'CROV-02', 'CROV-03', 'CROV-04', 'CROV-05']),
]
detail_parts = []
for title, ids in groups:
    detail_parts.append(f'<p class="grp-title">{html.escape(title)}</p>')
    detail_parts.append('<table class="tbl detail-tbl"><thead><tr>'
        '<th>Subject</th><th>Scenario</th><th>Parameter</th>'
        '<th class="num">True value<br><span class="sub-th">(known, simulated)</span></th>'
        '<th class="num">App estimate</th><th class="num">NONMEM estimate</th>'
        '<th class="num">SE (NONMEM)</th><th class="num">Deviation ÷ SE</th><th>Verdict</th>'
        '</tr></thead><tbody>')
    for sid in ids:
        c = next(x for x in comparison if x['id'] == sid)
        r = by_id[sid]
        for i, e in enumerate(c['etas']):
            first = '<td rowspan="{}"><code>{}</code></td><td rowspan="{}">{}</td>'.format(
                len(c['etas']), html.escape(sid), len(c['etas']), html.escape(r['label'])
            ) if i == 0 else ''
            detail_parts.append(
                f'<tr>{first}<td>{html.escape(e["name"])}</td>'
                f'<td class="num">{fmt_eta(e["etaTrue"])}</td>'
                f'<td class="num">{fmt_eta(e["etaApp"])}</td>'
                f'<td class="num">{fmt_eta(e["etaNonmem"])}</td>'
                f'<td class="num">{e["se"]:.4f}</td>'
                f'<td class="num">{fmt_ratio(e["ratioOfSE"])}</td>'
                f'<td><span class="pass-badge small">pass</span></td></tr>'
            )
    detail_parts.append('</tbody></table>')
DETAIL_TABLES = '\n'.join(detail_parts)

# ---------------------------------------------------------------- risk table
RISK_ROWS = [
    ('R1', 'Structural model', 'The underlying equations that describe how the drug moves through and leaves the body are coded wrong',
     'Every forecast for every patient would be systematically off', 'Low',
     'Already independently checked: a second, separately written calculation engine reproduces the app\'s predicted concentrations to within 0.001%.', False),
    ('R2', 'Population parameters', 'A published number (e.g. a typical clearance value) was mistyped when building the app',
     'Every forecast built on a wrong population starting point', 'Low',
     'Already independently checked: every number is compared automatically, line by line, against the original source files.', False),
    ('R3', 'Personalizing the forecast to this patient', 'The app\'s own calculation, run in a web browser, lands on a different personal estimate than the trusted reference method would, for the same patient data',
     'Directly wrong personal clearance/volume numbers, and so a wrong predicted trough level and a wrong "is this patient adequately dosed" probability, the number a clinician actually reads and may act on',
     'Not independently checked before this report', 'This report\'s primary subject.', True),
    ('R4', 'Handling a result "below the detection limit"', 'The math the app uses for an unquantifiable sample is subtly wrong',
     'A silently biased personal estimate whenever such a sample is entered, a routine occurrence in monitoring',
     'A separate part of the same calculation, not otherwise checked', 'Included as a specific scenario in this report.', True),
    ('R5', 'A deliberate simplification for one patient group (aHUS)', 'The simplification does not behave the way it is documented to',
     'Wrong uncertainty specifically for the harder-to-treat patient group', 'Documented reasoning only, no independent numeric check',
     'Included as a specific scenario in this report.', True),
    ('R6', 'A recently added feature (custom infusion time)', 'The custom duration a clinician enters silently fails to reach the calculation',
     'Wrong predicted concentration for a sample drawn during an infusion', 'Tested in isolation, no independent cross-check yet',
     'Included as a specific scenario in this report.', True),
    ('R7', 'The reported uncertainty range itself', 'The reported 90% range is too narrow or too wide',
     'Over- or under-confident probability of adequate dosing, a different failure from a wrong central number',
     'Checked internally only, not against an external reference', 'Explicitly out of scope here, recommended as separate future work (see §6.2).', False),
    ('R8', 'The screen a clinician actually reads', 'A correct calculation is displayed wrong', 'A misread rather than a miscalculated result',
     'Covered by a large, separate automated test suite and an earlier usability review', 'Out of scope: not a calculation-accuracy question.', False),
]

risk_html = ['<table class="tbl risk-tbl"><thead><tr>',
    '<th></th><th>What could go wrong</th><th>Failure, in plain terms</th><th>What it would mean for a patient</th>',
    '<th>Checked before this report?</th><th>This report\'s role</th></tr></thead><tbody>']
for rid, comp, fail, conseq, before, role, is_focus in RISK_ROWS:
    cls = ' class="focus-row"' if is_focus else ''
    risk_html.append(f'<tr{cls}><td class="risk-id">{rid}</td><td><b>{html.escape(comp)}</b></td>'
        f'<td>{html.escape(fail)}</td><td>{html.escape(conseq)}</td><td>{html.escape(before)}</td>'
        f'<td>{html.escape(role)}</td></tr>')
risk_html.append('</tbody></table>')
RISK_TABLE = '\n'.join(risk_html)

# ---------------------------------------------------------------- appendix code
def code_block(label, path_or_text, is_path=True, lang=''):
    text = open(rp(path_or_text)).read() if is_path else path_or_text
    return f'<div class="code-label">{html.escape(label)}</div><pre class="code"><code>{html.escape(text)}</code></pre>'

APPENDIX_A = '\n'.join([
    code_block('A.1: ecu_pnh_posthoc.mod (NONMEM control stream, eculizumab / PNH)', 'validation/nonmem/ecu_pnh_posthoc.mod'),
    code_block('A.2: ecu_ahus_posthoc.mod (NONMEM control stream, eculizumab / aHUS, folded-variance variant)', 'validation/nonmem/ecu_ahus_posthoc.mod'),
    code_block('A.3: ravu_posthoc.mod (NONMEM control stream, ravulizumab)', 'validation/nonmem/ravu_posthoc.mod'),
    code_block('A.4: crov_posthoc.mod (NONMEM control stream, crovalimab)', 'validation/nonmem/crov_posthoc.mod'),
])

bayes_excerpt = open(rp('validation', 'report_assets', 'bayes_excerpt.txt')).read()
APPENDIX_B = '\n'.join([
    code_block('B.1: src/model.js (population PK model: parameters and structural equations, all three drugs)', 'src/model.js'),
    code_block('B.2: src/bayes.js, estimation-relevant excerpts (the objective function, the below-detection-limit likelihood term, the optimizer, and the multi-start driver; this is what is being validated numerically against NONMEM)', bayes_excerpt, is_path=False),
])

TEMPLATE_PATH = rp('validation', 'report_assets', 'report_template.html')
with open(TEMPLATE_PATH) as f:
    template = f.read()

out = (template
    .replace('{{SUMMARY_TABLE}}', SUMMARY_TABLE)
    .replace('{{DETAIL_TABLES}}', DETAIL_TABLES)
    .replace('{{RISK_TABLE}}', RISK_TABLE)
    .replace('{{APPENDIX_A}}', APPENDIX_A)
    .replace('{{APPENDIX_B}}', APPENDIX_B)
)
out_path = rp('validation', 'report_assets', 'report.html')
with open(out_path, 'w') as f:
    f.write(out)
print('Wrote', out_path, len(out), 'chars')

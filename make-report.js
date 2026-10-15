/**
 * Builds the application report (docs/index.html, docs/data.json, docs/report.md)
 * from one or more run logs written by `node auto-apply-runner.js naukri --live > log`.
 *
 *   node make-report.js naukri-live.attempt1.log naukri-live.attempt2.log naukri-live.log
 *
 * Privacy: phone numbers and emails are masked, and salary answers (CTC / compensation)
 * are replaced with "[redacted]" before anything is written, so the public page is safe.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'docs');
const files = process.argv.slice(2);
if (!files.length) {
  console.log('usage: node make-report.js <log> [log...]');
  process.exit(1);
}

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mask = (s) => String(s || '')
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/(\+?\d[\d\s-]{8,}\d)/g, '[phone]');
const isSalary = (q) => /ctc|salary|compensation|pay\b|lpa|lakh/i.test(q);

const jobs = [];
let current = null;
const LINE = /^\[([^\]]+)\] \[naukri\]\s+(.*)$/;

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, time, body] = m;
    let t;

    if ((t = body.match(/^▶ Applying: (.+?) \| (https?:\S+)/))) {
      current = { time, title: t[1], url: t[2], company: companyFromUrl(t[2]), kind: 'naukri', outcome: 'pending', reason: '', qa: [], verified: null, flags: [] };
      jobs.push(current);
    } else if ((t = body.match(/^🔗 EXTERNAL \| (.+?) \| (https?:\S+)/))) {
      current = { time, title: t[1], url: t[2], company: companyFromUrl(t[2]), kind: 'external', outcome: 'external-queued', reason: 'Apply on company site (followed to employer form)', qa: [], verified: null, flags: [] };
      jobs.push(current);
    } else if ((t = body.match(/^🔗 external: (.+)$/))) {
      // the runner works the external queue later; attach to the matching queued job
      const q = [...jobs].reverse().find((j) => j.kind === 'external' && j.title === t[1].trim());
      if (q) q.outcome = 'external-working';
    } else if (!current) {
      continue;
    } else if (/^✅ applied/.test(body)) {
      current.outcome = 'applied';
    } else if (/^✔ verified/.test(body)) {
      current.verified = 'verified';
    } else if (/NOT in .* applied list/.test(body)) {
      current.verified = 'missing';
      current.outcome = 'failed';
      current.reason = 'submission did not register in the applied list';
    } else if (/verification unavailable/.test(body)) {
      current.verified = 'unverified';
    } else if (/could not confirm success/.test(body)) {
      current.outcome = 'unconfirmed';
      current.reason = 'apply clicked, success message not seen on page (checked against applied list separately)';
    } else if (/no Apply button found/.test(body)) {
      current.outcome = 'skipped';
      current.reason = 'no Apply button on page';
    } else if (/already applied/.test(body)) {
      current.outcome = 'skipped';
      current.reason = 'already applied earlier';
    } else if (/too many turns/.test(body)) {
      current.outcome = 'failed';
      current.reason = 'chatbot asked too many questions, finished manually';
    } else if (/no options and no input found/.test(body)) {
      current.outcome = 'failed';
      current.reason = 'chatbot question with no answer field';
    } else if (/^🤖 Q: "(.*)"$/.test(body)) {
      current.qa.push({ q: body.match(/^🤖 Q: "(.*)"$/)[1], a: null, generic: false });
    } else if ((t = body.match(/^✍ A: "(.*)"$/))) {
      const last = current.qa[current.qa.length - 1];
      if (last && last.a === null) last.a = t[1];
      else current.qa.push({ q: '(question not captured)', a: t[1], generic: false });
    } else if ((t = body.match(/^☑ picked option: "(.*)"$/))) {
      const last = current.qa[current.qa.length - 1];
      if (last && last.a === null) last.a = '☑ ' + t[1];
    } else if (/no answer-bank match/.test(body)) {
      const last = current.qa[current.qa.length - 1];
      if (last) last.generic = true;
      current.flags.push('answered with generic line (no bank match)');
    } else if (/^⚠ /.test(body) || /^external.*fail|error/i.test(body)) {
      current.flags.push(body.replace(/^⚠ /, '').slice(0, 160));
    }
  }
}

// the job URL does not separate title from company reliably, so the link is shown instead
function companyFromUrl() {
  return 'see link';
}

// manual confirmations (checked on Naukri's applied history) override the log
const CONFIRMED = path.join(__dirname, 'confirmed.json');
if (fs.existsSync(CONFIRMED)) {
  for (const c of JSON.parse(fs.readFileSync(CONFIRMED, 'utf8'))) {
    const j = jobs.find((x) => x.url === c.url);
    if (j) { j.outcome = 'applied'; j.verified = 'verified'; j.reason = c.status; }
  }
}

// privacy pass
for (const j of jobs) {
  j.qa = j.qa.map((x) => ({
    q: mask(x.q),
    a: x.a === null ? '(no answer recorded)' : (isSalary(x.q) ? '[redacted]' : mask(x.a)),
    generic: x.generic,
  }));
  j.reason = mask(j.reason);
  j.flags = j.flags.map(mask);
}

const counts = jobs.reduce((c, j) => { c[j.outcome] = (c[j.outcome] || 0) + 1; return c; }, {});
const verifiedCount = jobs.filter((j) => j.verified === 'verified').length;
const unansweredCount = jobs.reduce((n, j) => n + j.qa.filter((x) => x.generic).length, 0);
const generated = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify({ generated, counts, verified: verifiedCount, unanswered: unansweredCount, jobs }, null, 2));

// markdown report
const md = [];
md.push('# Naukri application report', '', `Generated ${generated} (IST)`, '');
md.push(`Attempts: **${jobs.length}** · applied: **${counts.applied || 0}** · verified on Naukri: **${verifiedCount}** · unconfirmed: **${counts.unconfirmed || 0}** · external (company site): **${(counts['external-queued'] || 0) + (counts['external-working'] || 0)}** · skipped: **${counts.skipped || 0}** · failed: **${counts.failed || 0}** · generic answers: **${unansweredCount}**`, '');
md.push('| # | Time | Job | Company | Outcome | Verified | Reason | Link |', '|---|---|---|---|---|---|---|---|');
jobs.forEach((j, i) => md.push(`| ${i + 1} | ${j.time} | ${j.title.replace(/\|/g, '/')} | ${j.company} | ${j.outcome} | ${j.verified || '—'} | ${j.reason || '—'} | ${j.url} |`));
md.push('', '## Questions and answers', '');
jobs.filter((j) => j.qa.length).forEach((j) => {
  md.push(`### ${j.title} (${j.company})`);
  j.qa.forEach((x) => md.push(`- **Q:** ${x.q}  \n  **A:** ${x.a}${x.generic ? ' _(no bank match, generic line used)_' : ''}`));
  md.push('');
});
fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md.join('\n'));

// html page
const badge = (o) => {
  const color = { applied: '#1a7f37', verified: '#1a7f37', external: '#0969da', 'external-queued': '#0969da', 'external-working': '#0969da', unconfirmed: '#9a6700', skipped: '#57606a', failed: '#cf222e', pending: '#57606a' }[o] || '#57606a';
  return `<span class="badge" style="background:${color}">${esc(o)}</span>`;
};
const rows = jobs.map((j, i) => `
  <tr>
    <td>${i + 1}</td>
    <td class="t">${esc(j.time.replace(/ (am|pm)/, ' $1'))}</td>
    <td><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></td>
    <td>${esc(j.company)}</td>
    <td>${badge(j.outcome)}${j.verified ? ' ' + badge(j.verified) : ''}</td>
    <td>${esc(j.reason) || '—'}${j.flags.length ? '<div class="flag">' + j.flags.map(esc).join('<br>') + '</div>' : ''}</td>
    <td>${j.qa.length ? `<details><summary>${j.qa.length} Q&amp;A</summary><ul>${j.qa.map((x) => `<li><b>${esc(x.q)}</b><br>${esc(x.a)}${x.generic ? ' <em>(generic)</em>' : ''}</li>`).join('')}</ul></details>` : '—'}</td>
  </tr>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Naukri application report</title>
<style>
:root{--bg:#f6f8fa;--fg:#1f2328;--muted:#57606a;--card:#fff;--line:#d0d7de}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--line:#30363d}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.stat b{display:block;font-size:20px}
.table-wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:900px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--card);font-size:12px;color:var(--muted)}
td.t{white-space:nowrap;color:var(--muted)}
a{color:#0969da;word-break:break-word}
.badge{display:inline-block;color:#fff;border-radius:999px;padding:1px 8px;font-size:11px;margin-right:4px}
.flag{color:#9a6700;font-size:12px;margin-top:4px}
details summary{cursor:pointer;color:#0969da} details ul{margin:6px 0 0 16px;padding:0} details li{margin-bottom:6px}
</style></head>
<body><main>
<h1>Naukri application report</h1>
<div class="sub">Generated ${esc(generated)} IST · personal contact details and salary answers are masked</div>
<div class="stats">
  <div class="stat"><b>${jobs.length}</b>attempts</div>
  <div class="stat"><b>${counts.applied || 0}</b>applied</div>
  <div class="stat"><b>${verifiedCount}</b>verified on Naukri</div>
  <div class="stat"><b>${counts.unconfirmed || 0}</b>unconfirmed</div>
  <div class="stat"><b>${(counts['external-queued'] || 0) + (counts['external-working'] || 0)}</b>company-site</div>
  <div class="stat"><b>${counts.skipped || 0}</b>skipped</div>
  <div class="stat"><b>${counts.failed || 0}</b>failed</div>
  <div class="stat"><b>${unansweredCount}</b>generic answers</div>
</div>
<div class="table-wrap"><table>
<thead><tr><th>#</th><th>Time</th><th>Job</th><th>Company</th><th>Outcome</th><th>Reason / flags</th><th>Questions</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No attempts yet.</td></tr>'}</tbody>
</table></div>
</main></body></html>`;
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);

console.log(`wrote docs/index.html — ${jobs.length} attempts, ${counts.applied || 0} applied, ${verifiedCount} verified`);

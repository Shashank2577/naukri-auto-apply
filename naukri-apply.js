/**
 * Naukri apply — plain Playwright, no AI.
 *
 *   node naukri-apply.js --debug            one job: click Apply, save screenshots + page dump, verify
 *   node naukri-apply.js --live --limit 50  apply to up to N matching jobs
 *
 * Every job writes one line to results.jsonl with: outcome, verified (against Naukri's
 * applied history), the chatbot questions seen and the answer given, and a screenshot path.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { CV, resumePath } = require('./config');

const ARGS = process.argv.slice(2);
const LIVE = ARGS.includes('--live');
const DEBUG = ARGS.includes('--debug');
const LIMIT_AT = ARGS.indexOf('--limit');
const LIMIT = LIMIT_AT >= 0 ? Number(ARGS[LIMIT_AT + 1]) : (DEBUG ? 1 : 50);
const DIR = __dirname;
const PROFILE = path.join(DIR, '.naukri-apply-profile');
const RESULTS = path.join(DIR, 'results.jsonl');
const SHOTS = path.join(DIR, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const SEARCHES = [
  'learning-and-development-manager', 'learning-and-development-head', 'training-manager', 'training-head',
  'capacity-building-manager', 'capacity-building-head', 'knowledge-management-manager', 'knowledge-management-head',
  'skill-development-manager', 'skilling-head', 'csr-manager', 'csr-head', 'program-director-skill-development',
  'monitoring-and-evaluation-manager', 'livelihood-program-manager', 'business-development-manager-government',
  'government-partnerships-manager', 'senior-consultant-skill-development', 'program-manager-skilling',
  'training-and-development-manager',
].map((s) => `https://www.naukri.com/${s}-jobs?experience=16`);

const KEYWORDS = /capacity|learning|l&d|training|trainer|skill|livelihood|csr|knowledge|curriculum|employability|upskill|reskill|workforce|vocational|institutional|program|programme|monitoring|m&e|impact|government|business development|proposal|consultant/i;
const SENIOR = /\b(head|director|lead|manager|consultant|specialist|advisor|vice president|vp)\b/i;
const BLOCK = /intern|trainee|fresher|junior|assistant|software|developer|engineer|technology|\bit\b|data|cloud|devops|product manager|sales|telecaller|bpo|insurance|loan|debt|banking|bank|finance|credit|investment|driver|teacher|tutor|nurse|medical|pharma|hospital|real estate|recruiter|content writer|coordinator|customer|warehouse|plant|factory|production|operations/i;

const QA = [
  [/notice|join|start/i, 'Immediate'],
  [/current .{0,20}(ctc|salary|compensation)/i, '[redacted]'],
  [/expected|desired .{0,20}(ctc|salary|compensation)/i, '[redacted]'],
  [/years? of (work |total |relevant )?experience|total experience|how many years/i, CV.yearsNumber],
  [/remote|wfh|work from home/i, 'Yes'],
  [/reloc|willing to (move|relocate)|on-?site|hybrid/i, 'Yes'],
  [/visa|sponsor|work authori[sz]ation|eligible to work|right to work/i, 'Yes'],
  [/current (location|city)|based (in|out of)|where are you/i, CV.location],
  [/current (company|employer)|organi[sz]ation/i, CV.company],
  [/linkedin/i, CV.linkedin],
  [/why (do you|are you).*(interest|join|want)/i, `I have 16 years in capacity building, learning and knowledge management across government, CSR and industry. This role matches that experience directly.`],
];

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('en-IN')}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);

function writeResult(r) {
  fs.appendFileSync(RESULTS, JSON.stringify(r) + '\n');
}

async function collectJobs(page) {
  const jobs = new Map();
  for (const url of SEARCHES) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3000);
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="job-listings-"]')].map((a) => ({
        title: (a.innerText || a.getAttribute('title') || '').trim().split('\n')[0],
        href: a.href,
      })));
    for (const j of found) {
      if (!j.title || jobs.has(j.href)) continue;
      const t = j.title;
      if (!(KEYWORDS.test(t) || SENIOR.test(t))) continue;
      if (BLOCK.test(t)) continue;
      jobs.set(j.href, { title: t, url: j.href, search: url });
    }
    log(`search ${url.split('/').pop()}: ${jobs.size} matching jobs so far`);
  }
  return [...jobs.values()];
}

// The visible "Apply" control on a job page (not "Apply on company site", not "Applied").
async function applyControl(page) {
  const loc = page.locator('button, a, [role="button"]').filter({ hasText: /^Apply$/ });
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function pageState(page) {
  return page.evaluate(() => {
    const vis = (e) => e.offsetParent !== null;
    const buttons = [...document.querySelectorAll('button, a')].filter(vis)
      .map((b) => b.innerText.trim()).filter(Boolean).slice(0, 25);
    const toast = [...document.querySelectorAll('[class*="toast" i],[class*="success" i],[class*="applied" i],[class*="popup" i]')]
      .filter(vis).map((e) => e.innerText.trim()).filter(Boolean).slice(0, 5);
    const drawer = document.querySelector('[class*="chatbot" i],[class*="drawer" i]');
    return { url: location.href, buttons, toast, drawer: !!drawer, drawerText: drawer ? drawer.innerText.slice(0, 600) : '' };
  });
}

// The apply drawer: bot questions above a "Type message here..." box, and a Save button
// that only enables after every question is answered. No AI: answers come from QA only.
const DOMAIN = /learning|training|trainer|capacity|knowledge|skill|csr|monitoring|m&e|program|livelihood|government|nsqf|ncvet|pmkvy|stakeholder|facilitat|performance|hr\b|talent|curriculum|l&d|institution|partnership|business development|consult|people|leadership|coach/i;
const UI_LINES = /^(type message here\.\.\.|save|send|close|\d+)$/i;

// Reads the right-hand drawer: question text, whether it has a text box, and its radio options.
async function drawer(page) {
  return page.evaluate(() => {
    const el0 = document.elementFromPoint(1040, 600);
    if (!el0) return null;
    let box = el0, best = null;
    for (let i = 0; i < 12 && box; i++, box = box.parentElement) {
      const r = box.getBoundingClientRect();
      if (r.x >= 780 && r.width <= 520 && r.height >= 600) best = box;
    }
    if (!best) return null;
    const lines = best.innerText.split('\n').map((x) => x.trim()).filter(Boolean)
      .filter((l) => !/^(save|send|close|type message here\.\.\.)$/i.test(l) && !/thank you for showing interest|answer all the recruiter/i.test(l));
    const hasBox = [...best.querySelectorAll('[contenteditable="true"]')].some((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0);
    const qi = lines.findIndex((l) => /\?$/.test(l));
    return { hasBox, lines, question: hasBox ? (lines.filter((l) => /\?$/.test(l)).pop() || lines[lines.length - 1] || '') : (qi >= 0 ? lines[qi] : lines[0] || ''), options: hasBox ? [] : (qi >= 0 ? lines.slice(qi + 1) : lines.slice(1)) };
  });
}

const OPTION_RULES = [
  [/notice period/i, /15 days/i],
  [/relocat|willing to|comfortable|open to|ready to|available|can you/i, /^yes$/i],
];

function answerFor(q) {
  if (!q) return null;
  for (const [re, val] of QA) if (re.test(q)) return val;
  if (/years?|experience|how many/i.test(q) && DOMAIN.test(q)) return CV.yearsNumber;
  return null;
}

async function answerChatbot(page, questions) {
  let lastQ = '';
  for (let turn = 0; turn < 14; turn++) {
    const d = await drawer(page);
    if (!d || !d.question || d.question === lastQ) break;
    lastQ = d.question;
    if (d.hasBox) {
      const answer = answerFor(d.question);
      questions.push({ q: d.question, a: answer });
      if (answer === null) return 'unanswered: ' + d.question.slice(0, 140);
      const box = page.locator('[contenteditable="true"]').last();
      if (!(await box.click({ timeout: 4000 }).then(() => true).catch(() => false))) break;
      await page.keyboard.type(String(answer), { delay: 80 });
      await sleep(500);
      await page.keyboard.press('Enter');
    } else {
      // option question: pick by rule, else a "Yes", else skip when allowed
      const rule = OPTION_RULES.find(([re]) => re.test(d.question));
      let pick = rule ? d.options.find((o) => rule[1].test(o)) : null;
      if (!pick && /^(yes|no)$/i.test(d.options[0] || '')) pick = d.options.find((o) => /^yes$/i.test(o));
      if (!pick) pick = d.options.find((o) => /skip this question/i.test(o)) || null;
      questions.push({ q: d.question, a: pick, options: d.options });
      if (!pick) return 'unanswered option question: ' + d.question.slice(0, 140);
      const opt = page.getByText(pick, { exact: true }).last();
      if (!(await opt.click({ timeout: 4000 }).then(() => true).catch(() => false))) return 'option click failed: ' + pick;
    }
    await sleep(2500);
  }
  // the drawer's Save lives in the right-hand panel; the job card has its own Save behind the overlay
  const pos = await page.evaluate(() => {
    // not necessarily a <button>: take the widest element reading exactly "Save" on the right panel
    const hits = [...document.querySelectorAll('button, div, a, span')]
      .filter((e) => e.offsetParent && (e.innerText || '').trim() === 'Save')
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter((o) => o.r.x > 780 && o.r.width > 100)
      .sort((a, b) => b.r.width - a.r.width);
    const o = hits[0];
    return o ? { x: o.r.x + o.r.width / 2, y: o.r.y + o.r.height / 2, disabled: !!o.e.disabled || /disabled/i.test(o.e.className.toString()) } : null;
  });
  if (!pos) return 'no Save button';
  if (pos.disabled) return 'Save still disabled';
  await page.mouse.click(pos.x, pos.y);
  await sleep(5000);
  return 'done';
}

async function verifyOnHistory(ctx, jobId) {
  const p = await ctx.newPage();
  try {
    await p.goto('https://www.naukri.com/myapply/historypage', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const html = await p.content();
    return jobId && html.includes(jobId) ? 'verified' : 'missing';
  } finally {
    await p.close();
  }
}

async function applyOne(ctx, job) {
  const jobId = (job.url.match(/-(\d{9,})(?:\?|$)/) || [])[1] || '';
  const page = await ctx.newPage();
  const shot = path.join(SHOTS, `${slug(job.title)}-${Date.now()}`);
  const res = { time: new Date().toISOString(), title: job.title, url: job.url, jobId, outcome: '', verified: '', questions: [], note: '', screenshot: shot + '.png' };
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    const ext = await page.locator('button, a').filter({ hasText: /apply on company site/i }).count();
    if (ext && !(await applyControl(page))) { res.outcome = 'external'; return res; }
    const btn = await applyControl(page);
    if (!btn) { res.outcome = 'no_apply_button'; await page.screenshot({ path: res.screenshot }); return res; }

    const before = await pageState(page);
    await btn.click();
    log(`  clicked Apply: ${job.title}`);
    await sleep(6000);
    const after = await pageState(page);
    if (await drawer(page)) {
      res.note = await answerChatbot(page, res.questions);
    }
    await page.screenshot({ path: res.screenshot, fullPage: false });
    const dump = { before, after: await pageState(page) };
    fs.writeFileSync(shot + '.json', JSON.stringify(dump, null, 2));
    res.outcome = res.note && res.note !== 'done' ? `stopped: ${res.note}` : (res.note === 'done' ? 'submitted' : 'clicked');
  } catch (e) {
    res.outcome = 'error';
    res.note = String(e.message || e).split('\n')[0].slice(0, 200);
  } finally {
    await page.close().catch(() => {});
  }
  return res;
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const listPage = ctx.pages()[0] || await ctx.newPage();
  const jobs = await collectJobs(listPage);
  log(`collected ${jobs.length} matching jobs`);
  fs.writeFileSync(path.join(DIR, 'jobs-found.json'), JSON.stringify(jobs, null, 2));

  let done = 0;
  for (const job of jobs.slice(0, LIMIT)) {
    if (!LIVE && !DEBUG) break;
    log(`[${done + 1}] ${job.title}`);
    const r = await applyOne(ctx, job);
    if ((r.outcome === 'submitted' || r.outcome === 'clicked') && LIVE) {
      r.verified = await verifyOnHistory(ctx, r.jobId);
    }
    log(`  -> ${r.outcome}${r.verified ? ' | ' + r.verified : ''}${r.note ? ' | ' + r.note.slice(0, 120) : ''}`);
    writeResult(r);
    done++;
    if (LIVE && done < LIMIT) await sleep(rnd(45000, 120000));
  }
  log(`finished: ${done} processed`);
  await ctx.close();
})().catch((e) => { console.error('fatal:', e); process.exit(1); });

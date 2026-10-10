const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(__dirname);
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(text) {
  const code = [];
  text = text.replace(/`([^`]+)`/g, (_, value) => `@@CODE${code.push(value) - 1}@@`);
  return escape(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${escape(code[i])}</code>`);
}
function markdown(text) {
  const lines = text.trim().split(/\r?\n/), output = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^#{1,3} /.test(line)) {
      const depth = line.match(/^#+/)[0].length;
      output.push(`<h${Math.min(depth + 1, 4)}>${inline(line.replace(/^#+ /, ''))}</h${Math.min(depth + 1, 4)}>`); i++; continue;
    }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      const cells = s => s.trim().slice(1, -1).split('|').map(v => v.trim());
      const headers = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(`<tr>${cells(lines[i++]).map((v, j) => `<td data-label="${escape(headers[j])}">${inline(v)}</td>`).join('')}</tr>`);
      }
      output.push(`<table><thead><tr>${headers.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`); continue;
    }
    if (/^(\d+\. |[-*] )/.test(line)) {
      const ordered = /^\d/.test(line), items = [];
      while (i < lines.length && /^(\d+\. |[-*] )/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^(\d+\. |[-*] )/, ''))}</li>`);
      output.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3} |\||\d+\. |[-*] )/.test(lines[i])) paragraph.push(lines[i++]);
    output.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return output.join('\n');
}
const report = fs.readFileSync(path.join(root, 'final-report.md'), 'utf8').replace(/^# .+\r?\n/, '');
const plan = fs.readFileSync(path.join(root, 'development-plan.md'), 'utf8').replace(/^# .+\r?\n/, '');
const sections = plan.split(/^## /m);
const planBody = `<p class="muted">${inline(sections.shift().trim())}</p>` + sections.map((section, i) => {
  const split = section.indexOf('\n');
  return `<details${i === 0 ? ' open' : ''}><summary>${inline(section.slice(0, split))}</summary><div class="detail-body">${markdown(section.slice(split + 1))}</div></details>`;
}).join('\n');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#102a43"><title>Argus · Decision Ledger closeout</title>
<style>
:root{color-scheme:light;--ink:#183047;--muted:#536779;--line:#dbe4ec;--paper:#fff;--accent:#126b61}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:82px}body{margin:0;background:#f1f5f8;color:var(--ink);font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}header{background:#102a43;color:white;padding:36px 20px 30px}header>div,main,nav>div{max-width:1000px;margin:auto}.eyebrow{font-size:.76rem;letter-spacing:.12em;text-transform:uppercase;color:#a6d8d0;font-weight:700}h1{font-size:clamp(1.85rem,6vw,3rem);line-height:1.15;letter-spacing:-.025em;margin:12px 0}header p{color:#d1dfe9;max-width:680px;margin-bottom:0}nav{position:sticky;top:0;z-index:2;background:rgba(255,255,255,.97);border-bottom:1px solid var(--line)}nav>div{display:flex;gap:8px;padding:10px 16px}nav a{display:block;padding:10px 14px;border-radius:10px;text-decoration:none;color:var(--ink);font-weight:650;font-size:.95rem;min-height:44px}nav a:first-child{background:#e8f3f0;color:#07584e}main{padding:24px 16px 48px}section{scroll-margin-top:82px}h2{font-size:1.65rem;line-height:1.3;margin:28px 0 18px}h3{font-size:1.2rem;line-height:1.4}h4{font-size:1.1rem}p{margin:0 0 20px}li{margin:10px 0}ol,ul{padding-left:24px}.panel{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:20px}.decision{border-left:5px solid var(--accent)}.decision strong{color:#07584e}.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:20px 0}.stat{background:white;border:1px solid var(--line);padding:16px;border-radius:12px}.stat b{display:block;font-size:1.9rem;line-height:1.2}.stat span{display:block;font-size:.87rem;color:var(--muted);margin-top:6px}.muted{color:var(--muted);font-size:.92rem}code{font-size:.86em;background:#eef2f5;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}details{background:white;border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}summary{padding:18px 20px;cursor:pointer;font-weight:650;min-height:56px;line-height:1.4}details[open] summary{border-bottom:1px solid var(--line);background:#f7fafb}.detail-body{padding:20px}.detail-body>:last-child{margin-bottom:0}table{border-collapse:collapse;width:100%;font-size:.93rem;margin:20px 0}th,td{text-align:left;vertical-align:top;padding:14px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{background:#edf3f6}footer{border-top:1px solid var(--line);padding-top:24px;color:var(--muted);font-size:.86rem}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 20px}button{font:inherit;font-size:.9rem;background:#fff;color:var(--ink);border:1px solid #b6c6d3;border-radius:10px;padding:10px 14px;min-height:44px;cursor:pointer}.limits{background:#fff8eb;border-color:#e6d5b4}.limits p{margin:0}@media(min-width:760px){main{padding:28px 24px 60px}.stats{grid-template-columns:repeat(4,1fr)}.panel{padding:30px}header{padding:48px 24px}}@media(max-width:759px){thead{display:none}table,tbody,tr,td{display:block}tr{border:1px solid var(--line);border-radius:12px;margin:14px 0;overflow:hidden}td{padding:12px 14px;border-bottom:1px solid #edf1f4}td:last-child{border-bottom:0}td::before{content:attr(data-label);display:block;color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:5px}.detail-body{padding:16px}td:first-child{background:#f4f8fa}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{nav,.actions{display:none}body{background:white}header{background:white;color:black}header p,.eyebrow{color:#444}details,.panel{break-inside:avoid}}
</style></head><body>
<header><div><div class="eyebrow">Argus · Experiment closed · 9 October 2026</div><h1>Decision Ledger:<br>what we proved, what comes next</h1><p>A reviewed development direction replaces open-ended shadow collection. New enforcing consumers still require their own acceptance evidence.</p></div></header>
<nav aria-label="Page sections"><div><a href="#report">Report</a><a href="#plan">Development plan</a></div></nav>
<main><div class="panel decision"><strong>Proceed with ledger and advisory development.</strong><p style="margin:8px 0 0">Defer enforcing pipeline consumers. Reject automatic authority and model-derived process termination.</p></div>
<div class="stats" aria-label="Experiment totals"><div class="stat"><b>16</b><span>Source workloads</span></div><div class="stat"><b>22</b><span>Selected assessments</span></div><div class="stat"><b>0</b><span>Pending selected items</span></div><div class="stat"><b>660</b><span>Source hashes unchanged</span></div></div>
<section id="report"><h2>Experiment report</h2><article class="panel">${markdown(report)}</article></section>
<section id="plan"><h2>Development plan</h2><p class="muted">Tap a section to read its design, release gates, and rollback requirements. Tables become cards on a phone.</p><div class="actions"><button type="button" id="expand">Expand all sections</button><button type="button" id="collapse">Collapse all sections</button></div>${planBody}</section>
<footer>Final evidence reconciled after 08:30 Europe/Stockholm. Source: the staged closeout report and independently reviewed development plan. Application code was not changed.</footer></main>
<script>document.getElementById('expand').addEventListener('click',()=>document.querySelectorAll('details').forEach(d=>d.open=true));document.getElementById('collapse').addEventListener('click',()=>document.querySelectorAll('details').forEach(d=>d.open=false));</script></body></html>`;
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('Built mobile report and plan page.');

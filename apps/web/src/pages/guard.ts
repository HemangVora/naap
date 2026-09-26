// /guard — Deploy Guard, a pre-deployment sandbox. Ask an agent for a contract (or tap a preset), edit the Solidity,
// then "Deploy & audit": the server compiles it, deploys it to an isolated Base fork, attacks it from a stranger's
// wallet and reverts. The report names the exact flaw and, when proven, the tx hash and what was drained.
// Every piece of model/user text (source, findings, exploit lines, hashes, compile errors) goes through esc().
import './guard.css';
import { GUARD_LIMITS, liveGuardApi, type GuardApi, type GuardFinding, type GuardPreset, type GuardReport, type Severity } from '../guard';
import { el, esc } from '../dom';
import { isMock } from '../feed';
import { brandHeader } from '../brand';

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const bytes = (s: string) => new TextEncoder().encode(s).length;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const CHAIN: Record<number, string> = { 8453: 'Base fork', 84532: 'Base Sepolia fork', 31337: 'local fork' };

export async function mountGuard(root: HTMLElement) {
  document.body.classList.add('phone-body');
  const mock = isMock();
  const q = mock ? '?mock=1' : '';
  const api: GuardApi = mock ? (await import('../guard-mock')).mockGuardApi() : liveGuardApi;

  const page = el('div', { class: 'phone gd' });
  const head = el('header', {}, brandHeader('deploy guard · pre-deployment sandbox'));
  if (mock) head.append(el('span', { class: 'pill mock', text: '?mock=1' }));
  page.append(
    head,
    el('h2', { html: 'Deploy <span>Guard</span>' }),
    el('p', {
      class: 'lead',
      text: 'Ask an AI agent for a smart contract. The guard compiles it, deploys it to an isolated Base fork, and attacks it from a stranger’s wallet, so you see the flaw before mainnet does. Nothing leaves the sandbox.',
    }),
  );

  // ── 1. the request ──
  const prompt = el('textarea', {
    name: 'prompt',
    maxlength: GUARD_LIMITS.promptMax,
    rows: 3,
    placeholder: 'e.g. a vault where users deposit USDC and the owner can withdraw the pooled funds',
    'aria-label': 'Describe the contract',
  });
  const promptCount = el('span', { class: 'gd-count' });
  const chips = el('div', { class: 'gd-chips', role: 'group', 'aria-label': 'Preset contracts' });
  const chipsNote = el('span', { class: 'gd-chips-note', text: 'loading presets…' });
  chips.append(chipsNote);
  const write = el('button', { type: 'button', class: 'gd-write', text: 'Write with AI' });
  const perr = el('div', { class: 'err', role: 'alert' });
  perr.hidden = true;

  // ── 2. the contract ──
  const source = el('textarea', {
    name: 'source',
    maxlength: GUARD_LIMITS.sourceMaxBytes,
    rows: 14,
    wrap: 'off',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    placeholder: '// Tap a preset, write one with AI, or paste your own Solidity (^0.8.24, single file, no imports).',
    'aria-label': 'Contract source (Solidity)',
  });
  const sourceMeta = el('span', { class: 'gd-count' });
  const origin = el('div', { class: 'hint gd-origin' });
  const audit = el('button', { type: 'button', class: 'primary gd-audit', text: 'Deploy & audit' });
  const aerr = el('div', { class: 'err', role: 'alert' });
  aerr.hidden = true;

  // ── 3. the report ──
  const out = el('section', { class: 'gd-out', 'aria-live': 'polite', 'aria-label': 'Audit report' });
  out.hidden = true;

  page.append(
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'gd-label', for: 'gd-prompt' }, el('span', { text: '1 · What should the contract do?' }), promptCount),
      prompt,
      el('div', { class: 'gd-row' }, el('span', { class: 'hint', text: 'Or tap a preset:' })),
      chips,
      write,
      perr,
    ),
    el(
      'div',
      { class: 'field' },
      el('label', { class: 'gd-label', for: 'gd-source' }, el('span', { text: '2 · The contract' }), sourceMeta),
      origin,
      source,
      audit,
      aerr,
    ),
    out,
    el('div', { class: 'back', html: `<a href="/${q}">← back to NaAP</a> · <a href="/world${q}">the world</a>` }),
  );
  prompt.id = 'gd-prompt';
  source.id = 'gd-source';
  root.append(page);

  // A draft or preset that lands after a newer one was chosen must not overwrite it.
  let sourceSeq = 0;
  let auditing = false;
  let drafting = false;
  let lastReport: GuardReport | null = null;
  /** The exact text last sent to audit (not the server's echo, which may be normalised). */
  let auditedSrc = '';
  let activePreset: string | null = null;

  const show = (box: HTMLElement, msg: string) => ((box.textContent = msg), (box.hidden = false));

  function syncMeta() {
    promptCount.textContent = `${prompt.value.length} / ${GUARD_LIMITS.promptMax}`;
    const n = bytes(source.value);
    sourceMeta.textContent = source.value ? `${kb(n)} / ${kb(GUARD_LIMITS.sourceMaxBytes)}` : '';
    sourceMeta.classList.toggle('over', n > GUARD_LIMITS.sourceMaxBytes);
    write.disabled = drafting || auditing;
    audit.disabled = auditing || drafting || !source.value.trim();
    for (const c of chips.querySelectorAll<HTMLButtonElement>('button')) {
      c.setAttribute('aria-pressed', String(c.dataset.id === activePreset));
      c.disabled = auditing;
    }
    // A report for code that has since been edited is marked stale rather than silently shown as current.
    out.classList.toggle('stale', !!lastReport && auditedSrc !== source.value);
  }

  function setSource(src: string, from: string) {
    sourceSeq++;
    source.value = src;
    origin.textContent = from;
    lastReport = null;
    auditedSrc = '';
    out.hidden = true;
    out.innerHTML = '';
    aerr.hidden = true;
    syncMeta();
  }

  prompt.oninput = () => {
    perr.hidden = true;
    syncMeta();
  };
  source.oninput = () => {
    aerr.hidden = true;
    activePreset = null;
    origin.textContent = source.value.trim() ? 'Your edit. The audit checks exactly this code.' : '';
    syncMeta();
  };

  // presets
  api
    .presets()
    .then(({ presets }) => {
      chipsNote.remove();
      if (!presets.length) return void chips.append(el('span', { class: 'gd-chips-note', text: 'no presets on this server' }));
      for (const p of presets) chips.append(presetChip(p));
      syncMeta();
    })
    .catch((e: Error) => (chipsNote.textContent = `presets unavailable (${e.message})`));

  function presetChip(p: GuardPreset) {
    const b = el('button', { type: 'button', class: `gd-chip${/safe|access/i.test(p.id + p.title) ? ' ok' : ''}`, text: p.title, title: p.prompt });
    b.dataset.id = p.id;
    b.onclick = () => {
      prompt.value = p.prompt.slice(0, GUARD_LIMITS.promptMax);
      perr.hidden = true;
      activePreset = p.id;
      setSource(p.source, `Preset: ${p.title}. Edit it freely before you audit.`);
    };
    return b;
  }

  // Write with AI
  write.onclick = async () => {
    const p = prompt.value.trim();
    if (!p) return (prompt.focus(), show(perr, 'Describe the contract first, or tap a preset.'));
    perr.hidden = true;
    drafting = true;
    const seq = ++sourceSeq;
    write.textContent = 'Agent is writing the contract…';
    write.classList.add('busy');
    syncMeta();
    try {
      const { source: src, name, preset } = await api.draft(p);
      if (seq !== sourceSeq) return; // a preset was picked meanwhile
      activePreset = null;
      setSource(
        src,
        preset
          ? `The model couldn’t write that one — here’s the closest preset: ${name || 'a contract'}. Edit it freely, then audit.`
          : `The agent wrote ${name || 'a contract'} for your request. Review it, edit it, then audit.`,
      );
      source.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      show(perr, `Could not write it. ${(e as Error).message}`);
    } finally {
      drafting = false;
      write.textContent = 'Write with AI';
      write.classList.remove('busy');
      syncMeta();
    }
  };

  // Deploy & audit
  audit.onclick = async () => {
    const src = source.value;
    if (!src.trim()) return (source.focus(), show(aerr, 'Nothing to audit yet. Tap a preset or write one with AI.'));
    const n = bytes(src);
    if (n > GUARD_LIMITS.sourceMaxBytes) return show(aerr, `The contract is ${kb(n)}; the sandbox takes at most ${kb(GUARD_LIMITS.sourceMaxBytes)}.`);
    aerr.hidden = true;
    auditing = true;
    audit.textContent = 'Deploying & attacking…';
    out.hidden = false;
    out.classList.remove('stale');
    out.innerHTML =
      '<div class="gd-pending"><b>Sandbox run in progress</b><ol><li>compile with solc ^0.8.24</li><li>deploy to an isolated Base fork</li><li>attack it from a stranger’s wallet</li><li>revert the fork, leave no trace</li></ol></div>';
    syncMeta();
    try {
      const { report } = await api.audit(src);
      lastReport = report;
      auditedSrc = src;
      renderReport(report);
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      out.hidden = !lastReport;
      if (lastReport) renderReport(lastReport);
      else out.innerHTML = '';
      show(aerr, `Could not audit it. ${(e as Error).message}`);
    } finally {
      auditing = false;
      audit.textContent = 'Deploy & audit';
      syncMeta();
    }
  };

  function renderReport(r: GuardReport) {
    out.hidden = false;
    const findings = [...r.findings].sort((a, b) => Number(!!b.confirmed) - Number(!!a.confirmed) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const proven = findings.filter((f) => f.confirmed);
    const serious = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    /** Findings whose attacker call ran on the fork and reverted (the engine downgrades them to "Unconfirmed: …"). */
    const blocked = findings.filter((f) => f.title.startsWith('Unconfirmed:'));
    const drained = proven.reduce((s, f) => s + (f.confirmed?.stolenUsd ?? 0), 0);
    const time = new Date(r.auditedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let headline: string;
    let sub: string;
    if (r.verdict === 'COMPILE_ERROR') {
      headline = 'Did not compile';
      sub = 'Nothing was deployed. Fix the error below and audit again.';
    } else if (r.verdict === 'VULNERABLE') {
      headline = 'Vulnerable';
      sub = proven.length
        ? `${proven.length} flaw${proven.length === 1 ? '' : 's'} proven on the fork${drained ? `, ${usd(drained)} drained by a stranger` : ''}. Do not ship this.`
        : `${serious.length} flaw${serious.length === 1 ? '' : 's'} found by the static scan. Do not ship this.`;
    } else {
      headline = 'Safe';
      const notes = findings.length ? ` ${findings.length} note${findings.length === 1 ? '' : 's'} below to review.` : '';
      sub = !r.address
        ? `Static scan only: it found none of the flaw classes it checks. The contract was not deployed, so nothing was attacked.${notes}`
        : blocked.length
          ? `${blocked.length} attack call${blocked.length === 1 ? '' : 's'} reverted on the fork.${notes}`
          : findings.length
            ? `Deployed to the sandbox; nothing the guard tried got through.${notes}`
            : 'Deployed to the sandbox. The scan found none of the flaw classes it checks, so there was nothing to attack.';
    }

    const where = r.address
      ? `<div class="gd-sandbox"><span class="k">sandbox</span><code>${esc(r.address)}</code><span class="m">${esc(r.chainId ? CHAIN[r.chainId] ?? `chain ${r.chainId}` : 'fork')} · reverted after the audit</span></div>`
      : r.verdict === 'COMPILE_ERROR'
        ? ''
        : '<div class="gd-sandbox"><span class="k">sandbox</span><span class="m">not deployed · static scan only</span></div>';

    out.innerHTML =
      `<div class="gd-verdict ${esc(r.verdict)}">` +
      `<div class="kick"><span>${esc(r.contractName || 'Contract')}</span><span>audited ${esc(time)}</span></div>` +
      `<div class="v">${esc(headline)}</div><p>${esc(sub)}</p>${where}</div>` +
      '<div class="gd-stale-note">You edited the contract since this report. Audit again to check the new code.</div>' +
      (r.compileError ? `<pre class="gd-compile">${esc(r.compileError)}</pre>` : '') +
      (findings.length ? `<ol class="gd-findings">${findings.map(findingCard).join('')}</ol>` : '');
    out.classList.toggle('stale', auditedSrc !== source.value);
  }
}

function findingCard(f: GuardFinding) {
  const c = f.confirmed;
  const loc = f.where || f.line ? `<div class="loc">${f.where ? `<code>${esc(f.where)}</code>` : ''}${f.line ? `<span>line ${esc(f.line)}</span>` : ''}</div>` : '';
  const owner = c?.ownerAfter ? `<div class="own"><span>owner</span><code>${esc(c.ownerBefore ?? '?')}</code><span>→</span><code>${esc(c.ownerAfter)}</code></div>` : '';
  const proof = c
    ? `<div class="proof"><div class="ph"><b>PROVEN ON-CHAIN</b>${c.stolenUsd ? `<span class="drained">${esc(usd(c.stolenUsd))} drained</span>` : ''}</div>` +
      `<p>${esc(c.exploit)}</p>${owner}<div class="tx"><span>tx</span><code>${esc(c.txHash)}</code></div></div>`
    : '';
  return (
    `<li class="gd-finding ${esc(f.severity)}${c ? ' confirmed' : ''}">` +
    `<div class="top"><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span><b>${esc(f.title)}</b></div>` +
    `${loc}<p class="detail">${esc(f.detail)}</p>${proof}</li>`
  );
}

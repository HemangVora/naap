// /tracks/new — the track builder (phone-first). Pick 1–8 obstacles from the incident library, tune them, reorder, POST /api/tracks.
// The new track appears in the world (track.created) and becomes selectable on /join ("Pick a track").
import type { BarrierId, Obfuscation, TrackObstacle, TrackSpec } from '../types';
import { BARRIER_INCIDENT, BARRIER_STORY, DEFAULT_AMOUNT, DEFAULT_OBFUSCATION, OBFUSCATABLE } from '../types';
import { el, esc } from '../dom';
import { isMock } from '../feed';
import { brandHeader } from '../brand';

const LIMITS = { nameMax: 32, authorMax: 24, minObstacles: 1, maxObstacles: 8, maxAmountUsd: 1000 };
const LIBRARY: BarrierId[] = ['legit', 'grok-morse', 'freysa', 'x402-swap', 'over-limit'];
const OBF: { v: Obfuscation; label: string }[] = [
  { v: 'none', label: 'plain' },
  { v: 'morse', label: 'Morse' },
  { v: 'base64', label: 'base64' },
  { v: 'hex', label: 'hex' },
];
const AMOUNT_HINT: Record<BarrierId, string> = {
  legit: 'toll price',
  'grok-morse': 'wallet drain',
  freysa: 'prize "payout"',
  'x402-swap': 'x402 price',
  'over-limit': 'owner’s purchase',
};

/** Small line icons, one per obstacle type (same shapes as the world props). */
export function obstacleIcon(t: BarrierId, size = 28) {
  const p: Record<BarrierId, string> = {
    legit: '<rect x="5" y="9" width="10" height="13" rx="1"/><path d="M3 9h14M10 4v5M18 22V12h7"/><circle cx="10" cy="15" r="2"/>',
    'grok-morse': '<rect x="3" y="5" width="22" height="13" rx="1.5"/><path d="M7 11h1M10 11h4M16 11h1M19 11h2M9 22l2-4M19 22l-2-4"/>',
    freysa: '<rect x="8" y="3" width="12" height="21" rx="1"/><path d="M10 12h8v6h-8zM10 12l4 3 4-3"/><circle cx="14" cy="6.5" r="1.2"/>',
    'x402-swap': '<path d="M14 3l6 2v4c0 3-3 5-6 6-3-1-6-3-6-6V5z"/><path d="M5 22h13M9 18l-4 4 4 4"/>',
    'over-limit': '<rect x="3" y="7" width="22" height="14" rx="2"/><path d="M3 12h22M7 17h5"/><path d="M20 3v4M18 5h4"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p[t]}</svg>`;
}

const TONE: Record<BarrierId, string> = { legit: 'green', 'grok-morse': 'vermilion', freysa: 'vermilion', 'x402-swap': 'vermilion', 'over-limit': 'amber' };

export function mountTrackBuilder(root: HTMLElement) {
  document.body.classList.add('phone-body');
  const mock = isMock();
  const q = mock ? '?mock=1' : '';
  const obstacles: TrackObstacle[] = [{ type: 'x402-swap' }, { type: 'grok-morse', obfuscation: 'morse' }];

  const page = el('div', { class: 'phone tb' });
  page.append(
    el('header', {}, brandHeader('build a crash-test track')),
    el('h2', { html: 'Build a <span>track</span>' }),
    el('p', { class: 'lead', text: 'Line up the incidents you think will fool an agent. Every car that picks your track drives it twice: bare, then behind Sekisho.' }),
  );

  const form = el('form', { class: 'form', novalidate: true });
  const name = el('input', { name: 'name', maxlength: LIMITS.nameMax, placeholder: 'e.g. Degen Gauntlet', autocomplete: 'off', autocapitalize: 'words' });
  const author = el('input', { name: 'author', maxlength: LIMITS.authorMax, placeholder: 'your name or handle', autocomplete: 'nickname' });
  try {
    author.value = localStorage.getItem('naap:author') ?? '';
  } catch {
    /* private mode */
  }

  // library
  const lib = el('div', { class: 'tb-lib' });
  for (const t of LIBRARY) {
    const card = el('button', { type: 'button', class: `tb-card ${TONE[t]}`, 'aria-label': `Add ${BARRIER_INCIDENT[t]}` });
    card.innerHTML = `<span class="ic">${obstacleIcon(t)}</span><span class="tx"><b>${esc(BARRIER_INCIDENT[t])}</b><small>${esc(BARRIER_STORY[t])}</small></span><span class="add">+ Add</span>`;
    card.onclick = () => {
      if (obstacles.length >= LIMITS.maxObstacles) return showErr(`A track holds at most ${LIMITS.maxObstacles} obstacles.`);
      obstacles.push({ type: t, ...(DEFAULT_OBFUSCATION[t] ? { obfuscation: DEFAULT_OBFUSCATION[t] } : {}) });
      render();
      list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    lib.append(card);
  }

  const preview = el('div', { class: 'tb-preview', 'aria-label': 'Track preview' });
  const count = el('span', { class: 'tb-count' });
  const list = el('ol', { class: 'tb-list' });
  const err = el('div', { class: 'err' });
  err.hidden = true;
  const submit = el('button', { class: 'primary', type: 'submit', text: 'Open the track' });
  const done = el('div', { class: 'tb-done' });
  done.hidden = true;

  form.append(
    field('Track name', name),
    field('Built by', author, 'Shown on the gantry: “<name> · by <you>”.'),
    el('div', { class: 'field' }, el('label', { text: 'Incident library' }), el('div', { class: 'hint', text: 'Tap to add. Repeats are allowed.' }), lib),
    el('div', { class: 'field' }, el('label', {}, 'Your track ', count), preview, list),
    err,
    submit,
  );
  page.append(form, done, el('div', { class: 'back', html: `<a href="/world${q}">← back to the world</a>` }));
  root.append(page);

  function showErr(msg: string) {
    err.textContent = msg;
    err.hidden = false;
  }

  function render() {
    err.hidden = true;
    count.textContent = `${obstacles.length} / ${LIMITS.maxObstacles}`;
    preview.innerHTML =
      `<span class="flag start">START</span>` +
      obstacles.map((o, i) => `<span class="stop ${TONE[o.type]}" title="${esc(BARRIER_INCIDENT[o.type])}">${obstacleIcon(o.type, 20)}<i>${i + 1}</i></span>`).join('<span class="road"></span>') +
      `<span class="flag end">FINISH</span>`;
    list.innerHTML = '';
    obstacles.forEach((o, i) => {
      const row = el('li', { class: `tb-row ${TONE[o.type]}` });
      const head = el('div', { class: 'tb-head', html: `<span class="n">${i + 1}</span><span class="ic">${obstacleIcon(o.type, 24)}</span><b>${esc(BARRIER_INCIDENT[o.type])}</b>` });
      const ctl = el('div', { class: 'tb-ctl' });
      const up = el('button', { type: 'button', 'aria-label': 'Move up', text: '↑', disabled: i === 0 });
      const down = el('button', { type: 'button', 'aria-label': 'Move down', text: '↓', disabled: i === obstacles.length - 1 });
      const rm = el('button', { type: 'button', 'aria-label': 'Remove', text: '×', class: 'rm' });
      up.onclick = () => {
        [obstacles[i - 1], obstacles[i]] = [obstacles[i], obstacles[i - 1]];
        render();
      };
      down.onclick = () => {
        [obstacles[i + 1], obstacles[i]] = [obstacles[i], obstacles[i + 1]];
        render();
      };
      rm.onclick = () => {
        obstacles.splice(i, 1);
        render();
      };
      ctl.append(up, down, rm);
      head.append(ctl);
      row.append(head);

      const knobs = el('div', { class: 'tb-knobs' });
      if (OBFUSCATABLE.includes(o.type)) {
        const seg = el('div', { class: 'tb-seg', role: 'radiogroup', 'aria-label': 'Obfuscation' });
        const cur = o.obfuscation ?? DEFAULT_OBFUSCATION[o.type] ?? 'none';
        for (const opt of OBF) {
          const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === opt.v), text: opt.label });
          b.onclick = () => {
            o.obfuscation = opt.v;
            render();
          };
          seg.append(b);
        }
        knobs.append(el('div', { class: 'k' }, el('span', { text: 'disguise' }), seg));
      }
      const amt = el('input', { type: 'number', inputmode: 'decimal', min: '0.01', max: String(LIMITS.maxAmountUsd), step: '0.01', value: String(o.amountUsd ?? DEFAULT_AMOUNT[o.type]), 'aria-label': 'Amount in USD' });
      amt.onchange = () => {
        const v = Number(amt.value);
        if (Number.isFinite(v) && v > 0 && v <= LIMITS.maxAmountUsd) o.amountUsd = Math.round(v * 100) / 100;
        else {
          amt.value = String(o.amountUsd ?? DEFAULT_AMOUNT[o.type]);
          showErr(`Amounts are $0.01 – $${LIMITS.maxAmountUsd}.`);
        }
      };
      knobs.append(el('div', { class: 'k' }, el('span', { text: AMOUNT_HINT[o.type] }), el('label', { class: 'usd' }, el('span', { text: '$' }), amt)));
      row.append(knobs);
      list.append(row);
    });
    if (!obstacles.length) list.append(el('li', { class: 'tb-empty', text: 'Empty track. Add at least one incident from the library.' }));
    submit.disabled = !obstacles.length;
  }
  render();

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const n = name.value.trim();
    const a = author.value.trim();
    if (!n) return (name.focus(), showErr('Give the track a name.'));
    if (!a) return (author.focus(), showErr('Who built it? Add your name.'));
    if (!obstacles.length) return showErr('Add at least one incident.');
    submit.disabled = true;
    submit.textContent = 'Opening the track…';
    try {
      try {
        localStorage.setItem('naap:author', a);
      } catch {
        /* private mode */
      }
      const body = { name: n, author: a, obstacles: obstacles.map((o) => ({ type: o.type, ...(o.obfuscation && OBFUSCATABLE.includes(o.type) ? { obfuscation: o.obfuscation } : {}), ...(o.amountUsd !== undefined ? { amountUsd: o.amountUsd } : {}) })) };
      let track: TrackSpec;
      if (mock) {
        await new Promise((r) => setTimeout(r, 500));
        track = { id: n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-track', createdAt: Date.now(), ...body };
      } else {
        const res = await fetch('/api/tracks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const data = (await res.json().catch(() => ({}))) as { track?: TrackSpec; error?: string };
        if (!res.ok || !data.track) throw new Error(data.error || `Server said ${res.status}`);
        track = data.track;
      }
      form.hidden = true;
      done.hidden = false;
      done.innerHTML =
        `<div class="tb-ok"><div class="k">TRACK OPEN</div><div class="nm">${esc(track.name)}</div><div class="by">by ${esc(track.author)} · ${track.obstacles.length} obstacle${track.obstacles.length === 1 ? '' : 's'}</div>` +
        `<div class="tb-preview">${track.obstacles.map((o, i) => `<span class="stop ${TONE[o.type]}">${obstacleIcon(o.type, 20)}<i>${i + 1}</i></span>`).join('<span class="road"></span>')}</div></div>` +
        `<a class="primary" href="/join?track=${encodeURIComponent(track.id)}${mock ? '&mock=1' : ''}">Send a car down it</a>` +
        `<a class="secondary" href="/world${q}">See it in the world →</a>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      showErr(`Could not open the track. ${(e as Error).message}`);
      submit.disabled = false;
      submit.textContent = 'Open the track';
    }
  };
}

function field(label: string, control: HTMLElement, hint?: string) {
  const wrap = el('div', { class: 'field' }, el('label', { text: label }), control);
  if (hint) wrap.append(el('div', { class: 'hint', text: hint }));
  return wrap;
}

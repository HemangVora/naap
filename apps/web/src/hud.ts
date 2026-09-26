import QRCode from 'qrcode';
import type { Store, CarState } from './store';
import { CONTROL_TONE, ETHERSCAN_TX, fmtUsd, BARRIER_SHORT } from './types';
import { el, esc, starsText } from './dom';

const KIND: Record<string, string> = { built: 'built', webhook: 'webhook', openai: 'openai' };

export function createHud(root: HTMLElement, store: Store, opts: { mock: boolean }) {
  const hud = el('div', { class: 'hud' });

  // top
  const wordmark = el('div', { class: 'wordmark' }, el('div', { class: 'roundel' }), el('div', {}, el('h1', { text: 'CRUMPLE' }), el('small', { text: 'crash-test hall × sekisho 関所' })));
  const headline = el('div', { class: 'headline' });
  const pills = el('div', { class: 'pills' });
  const top = el('div', { class: 'hud-top' }, wordmark, headline, pills);

  // rails
  const board = el('div', { class: 'board' });
  const left = el('div', { class: 'rail' }, el('div', { class: 'rail-title', text: 'LEADERBOARD · NCAP STARS' }), board);
  const feed = el('div', { class: 'feed' });
  const right = el('div', { class: 'rail' }, el('div', { class: 'rail-title', text: 'SEKISHO VERDICTS' }), feed);
  const mid = el('div');

  // bottom
  const legend = el('div', {
    class: 'legend',
    html: `<span><i style="background:var(--vermilion)"></i>bare lane · crash wall</span><span><i style="background:var(--green)"></i>airbag lane · sekisho gate</span><span><i style="background:var(--amber)"></i>step-up · World ID</span>`,
  });
  const qrCanvas = el('canvas');
  const joinUrl = `${location.origin}/join`;
  QRCode.toCanvas(qrCanvas, joinUrl, { margin: 1, width: 232, color: { dark: '#0d0e11', light: '#f2efe8' } }).catch(console.warn);
  const qr = el('div', { class: 'qr-card' }, qrCanvas, el('div', { class: 'cta', html: `Scan to crash-test your agent<small>${esc(joinUrl.replace(/^https?:\/\//, ''))}</small>` }));
  const bottom = el('div', { class: 'hud-bottom' }, legend, qr);

  hud.append(top, left, mid, right, bottom);
  root.append(hud);

  // owner step-up card (World QR + code)
  const stepCard = el('div', { class: 'stepup-card' });
  stepCard.style.display = 'none';
  root.append(stepCard);
  let stepQrFor = '';
  let stepCanvas: HTMLCanvasElement | null = null;

  let raf = 0;
  const render = () => {
    raf = 0;
    const s = store.state;

    // headline
    const h = s.headline;
    if (h.cars === 0) {
      const n = s.cars.size;
      headline.innerHTML = n ? `<span><b>${n}</b> car${n === 1 ? '' : 's'} on the track · first results incoming</span>` : `<span>Waiting for the first car</span>`;
    } else {
      headline.innerHTML =
        `<span>Bare agents crashed <b class="red">${Math.round(h.bareCrashRate * 100)}%</b></span>` +
        `<span class="sep">·</span><span>avg <b class="red">−${esc(fmtUsd(h.avgBareLossUsd))}</b></span>` +
        `<span class="sep">·</span><span>with Sekisho <b class="green">${h.airbagCrashes}</b> crashes</span>` +
        `<span class="sep">·</span><span>${h.cars} car${h.cars === 1 ? '' : 's'}</span>`;
    }

    // pills
    pills.innerHTML = '';
    pills.append(el('span', { class: `pill ${s.connected ? 'live' : ''}`, text: s.connected ? (opts.mock ? 'mock feed' : 'live') : 'reconnecting…' }));
    if (opts.mock) pills.append(el('span', { class: 'pill mock', text: '?mock=1' }));
    for (const who of s.offline) pills.append(el('span', { class: 'pill off', text: `${who} offline` }));

    // leaderboard
    const cars = store.carsByOrder();
    board.innerHTML = cars
      .slice(-8)
      .map((c) => boardRow(c, s.queue.includes(c.car.id)))
      .join('');

    // verdict feed (newest at top): one card per barrier, paced by the store
    feed.innerHTML = s.cards
      .slice(-5)
      .reverse()
      .map((v) => {
        const car = s.cars.get(v.carId);
        const blocked = v.failed.length > 0 && v.outcome !== 'PAID';
        const tone = v.outcome === 'CRASH' ? 'crash' : v.outcome === 'PAID' ? (v.variant === 'bare' ? 'warn' : 'paid') : 'safe';
        const head =
          v.outcome === 'CRASH' ? `CRASH −${fmtUsd(v.lossUsd)}` : v.outcome === 'PAID' ? (v.variant === 'bare' ? 'PAID · no checks' : 'PAID') : v.outcome === 'FALSE_BLOCK' ? 'FALSE BLOCK' : 'REFUSED';
        const chips = blocked
          ? v.failed.map((k) => `<span class="ctl-chip" style="--c:var(--${CONTROL_TONE[k.control] ?? 'vermilion'})">${esc(k.control)}</span>`).join('')
          : '';
        const passed = v.variant === 'airbag' && v.passed > 0 ? `<span class="passed">${v.passed} check${v.passed === 1 ? '' : 's'} passed</span>` : '';
        return `<div class="verdict ${tone}"><div class="vh"><span class="vo">${head}</span><span class="who">${esc(car?.car.name ?? v.carId)} · ${v.variant === 'airbag' ? 'Sekisho' : 'bare'} · ${esc(BARRIER_SHORT[v.barrierId])}</span></div><div class="vr">${esc(v.reason)}</div>${chips || passed ? `<div class="vc">${chips}${passed}</div>` : ''}</div>`;
      })
      .join('');

    // owner step-up card
    const owner = cars.find((c) => c.car.isOwnerCar && c.stepUp);
    const su = owner?.stepUp;
    const show = su && (!su.result || Date.now() - (su.startedAt + (su.expiresAt * 1000 - su.startedAt)) < 4000 || Date.now() < su.startedAt + 4000);
    if (su && show) {
      const status = su.result?.status;
      stepCard.className = `stepup-card ${status === 'APPROVED' ? 'approved' : status ? 'expired' : ''}`;
      stepCard.style.display = '';
      if (stepQrFor !== (su.verificationUri ?? '')) {
        stepQrFor = su.verificationUri ?? '';
        stepCanvas = el('canvas');
        if (stepQrFor) QRCode.toCanvas(stepCanvas, stepQrFor, { margin: 0, width: 216, color: { dark: '#0d0e11', light: '#ffffff' } }).catch(console.warn);
      }
      const left = Math.max(0, Math.round((su.expiresAt * 1000 - Date.now()) / 1000));
      stepCard.innerHTML = '';
      if (stepCanvas && stepQrFor) stepCard.append(stepCanvas);
      stepCard.append(
        el('div', { class: 't', text: status === 'APPROVED' ? 'Owner approved via World ID' : status === 'EXPIRED' ? 'Step-up expired' : status === 'DENIED' ? 'Owner denied' : 'Owner step-up · World ID' }),
        el('div', { class: 's', text: su.result?.detail ?? su.summary }),
        su.userCode && !status ? el('div', { class: 'code', text: su.userCode }) : el('div', { class: 's', text: `${esc(owner!.car.name)} · ${BARRIER_SHORT[su.barrierId]}` }),
        !status ? el('div', { class: 'ring', html: `<b>${left}s</b> left to approve on the owner phone` }) : el('div', { class: 'ring', text: status === 'APPROVED' ? 'Gate opens · $40 paid to weather.crumple.eth' : 'Gate arm down · payment refused' }),
      );
    } else stepCard.style.display = 'none';
  };

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(render);
  };
  const unsub = store.subscribe(schedule);
  const ticker = window.setInterval(() => {
    if (store.carsByOrder().some((c) => c.stepUp && !c.stepUp.result)) schedule();
  }, 500);

  return {
    destroy() {
      unsub();
      window.clearInterval(ticker);
      hud.remove();
      stepCard.remove();
    },
  };
}

function boardRow(c: CarState, queued: boolean) {
  const r = c.rating;
  const bareLoss = c.lanes.bare.finished?.lossUsd ?? Object.values(c.lanes.bare.results).reduce((a, x) => a + (x?.lossUsd ?? 0), 0);
  const stars = r
    ? `<span class="bare">${starsText(r.bare.stars)}</span><span class="arrow">→</span><span class="air">${starsText(r.airbag.stars)}</span>`
    : queued
      ? `<span class="pending">at the start line</span>`
      : `<span class="pending">${liveStars(c)}</span>`;
  const ens = c.onchain
    ? `<span>${esc(c.car.ensName)}</span><a href="${ETHERSCAN_TX}${esc(c.onchain.txHash)}" target="_blank" rel="noopener">✓ on ENS</a>`
    : r
      ? `<span>${esc(c.car.ensName)}</span><span class="writing">writing rating…</span>`
      : `<span>${esc(c.car.ensName)}</span>`;
  return `<div class="board-row" style="--c:${esc(c.car.color)}">
    <div class="name">${esc(c.car.name)}${c.car.isOwnerCar ? '<span class="owner">OWNER</span>' : ''}<span class="kind">${esc(KIND[c.car.kind] ?? c.car.kind)}${c.car.model ? ' · ' + esc(c.car.model.replace('claude-', '').replace(/-\d{8}$/, '')) : ''}</span></div>
    <div class="loss">${bareLoss > 0 ? '−' + esc(fmtUsd(bareLoss)) : ''}</div>
    <div class="stars">${stars}</div>
    <div class="ens">${ens}</div>
  </div>`;
}

function liveStars(c: CarState) {
  const b = c.lanes.bare;
  const a = c.lanes.airbag;
  const cell = (l: typeof b) =>
    (['legit', 'grok-morse', 'freysa', 'x402-swap', 'over-limit'] as const)
      .map((id) => {
        const r = l.results[id];
        if (!r) return l.current === id ? '·' : '&nbsp;';
        return r.outcome === 'CRASH' ? '<span class="bare">✗</span>' : r.outcome === 'FALSE_BLOCK' ? '<span style="color:var(--amber)">!</span>' : '<span class="air">✓</span>';
      })
      .join('');
  return `bare ${cell(b)}<span class="arrow">→</span>airbag ${cell(a)}`;
}

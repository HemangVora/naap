import QRCode from 'qrcode';
import type { BarrierResult, Variant } from '../types';
import { BARRIERS, BARRIER_SHORT, CONTROL_TONE, ETHERSCAN_TX, fmtUsd } from '../types';
import { Store, type CarState } from '../store';
import { connectFeed, isMock } from '../feed';
import { el, esc, starsText } from '../dom';
import { brandHeader } from '../brand';

const KIND_LABEL: Record<string, string> = { built: 'built here', webhook: 'webhook · boundary mode', openai: 'OpenAI-compatible · boundary mode', mcp: 'your agent · MCP' };

export function mountCar(root: HTMLElement, carId: string) {
  document.body.classList.add('phone-body');
  const store = new Store();
  const mock = isMock();
  const page = el('div', { class: 'phone' });
  root.append(page);

  let qrFor = '';
  let qrCanvas: HTMLCanvasElement | null = null;

  const render = () => {
    const s = store.state;
    let c = s.cars.get(carId);
    if (!c && mock) c = store.carsByOrder()[0]; // `/car/anything?mock=1` follows the first scripted car
    page.innerHTML = '';
    page.append(el('header', {}, brandHeader('live car status')));

    if (!c) {
      page.append(
        el('h2', { text: s.connected ? 'Waiting for your car' : 'Connecting…' }),
        el('p', { class: 'lead', text: s.connected ? `No events yet for “${carId}”. It appears here as soon as the server announces it.` : 'Opening the live feed.' }),
        el('a', { class: 'back', href: '/join', text: '← build another car' }),
      );
      return;
    }

    const car = c.car;
    page.append(
      el('div', { class: 'car-head', style: `--c:${esc(car.color)}` }, el('div', { class: 'dot' }), el('div', {}, el('h2', { text: car.name }), el('div', { class: 'ens', text: car.ensName }), el('div', { class: 'ens', text: KIND_LABEL[car.kind] ?? car.kind }))),
      el('div', { class: 'status-line', html: statusLine(c, s.queue.includes(car.id), s.connected, mock) }),
    );

    // step-up card for the owner car
    if (car.isOwnerCar && c.stepUp) {
      const su = c.stepUp;
      const status = su.result?.status;
      const card = el('div', { class: `stepup-phone ${status === 'APPROVED' ? 'approved' : status ? 'expired' : ''}` });
      card.append(el('div', { class: 't', text: status === 'APPROVED' ? 'Approved via World ID' : status === 'EXPIRED' ? 'Step-up expired' : status === 'DENIED' ? 'Denied' : 'Approve on World ID' }));
      card.append(el('div', { class: 's', text: su.result?.detail ?? su.summary }));
      if (!status && su.verificationUri) {
        if (qrFor !== su.verificationUri) {
          qrFor = su.verificationUri;
          qrCanvas = el('canvas');
          QRCode.toCanvas(qrCanvas, qrFor, { margin: 0, width: 288, color: { dark: '#0d0e11', light: '#ffffff' } }).catch(console.warn);
        }
        if (qrCanvas) card.append(qrCanvas);
        if (su.userCode) card.append(el('div', { class: 'code', text: su.userCode }));
        card.append(el('a', { class: 'primary', href: su.verificationUri, target: '_blank', rel: 'noopener', text: 'Open World App' }));
        card.append(el('div', { class: 'left', text: `${Math.max(0, Math.round((su.expiresAt * 1000 - Date.now()) / 1000))}s left` }));
      }
      page.append(card);
    }

    // bare × airbag × 5 barriers
    const grid = el('div', { class: 'grid' });
    grid.append(el('div', { class: 'h' }), el('div', { class: 'h bare', text: 'BARE' }), el('div', { class: 'h air', text: 'AIRBAG 関' }));
    for (const b of BARRIERS) {
      grid.append(el('div', { class: 'b', text: BARRIER_SHORT[b] }));
      for (const v of ['bare', 'airbag'] as Variant[]) grid.append(cell(c, v, b));
    }
    page.append(grid);

    // rating + ENS
    if (c.rating) {
      const r = c.rating;
      page.append(
        el('div', { class: 'rating-card' },
          el('div', { class: 'bare' }, el('div', { class: 'l', text: 'BARE' }), el('div', { class: 's', text: starsText(r.bare.stars) }), el('div', { class: 'm', text: `${r.bare.crashes} crash${r.bare.crashes === 1 ? '' : 'es'} · lost ${fmtUsd(r.bare.lossUsd)}` })),
          el('div', { class: 'air' }, el('div', { class: 'l', text: 'WITH SEKISHO' }), el('div', { class: 's', text: starsText(r.airbag.stars) }), el('div', { class: 'm', text: `${r.airbag.crashes} crash${r.airbag.crashes === 1 ? '' : 'es'} · lost ${fmtUsd(r.airbag.lossUsd)}` })),
        ),
      );
    }
    const ens = el('div', { class: 'ens-card' });
    ens.append(el('div', { class: 'name', text: car.ensName }));
    if (c.onchain) ens.append(el('div', { html: `<a href="${ETHERSCAN_TX}${esc(c.onchain.txHash)}" target="_blank" rel="noopener">✓ rating written on ENS (Sepolia)</a>` }));
    else if (c.rating) ens.append(el('div', { class: 'st', text: 'Rating being written to ENS text records…' }));
    else ens.append(el('div', { class: 'st', text: 'Mandate lives here: payees, per-tx cap $5, daily cap 10%. The agent cannot edit it.' }));
    page.append(ens);
    page.append(el('a', { class: 'back', href: '/join', text: '← send another car' }));
  };

  let raf = 0;
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  };
  store.subscribe(schedule);
  window.setInterval(() => {
    const c = store.state.cars.get(carId);
    if (c?.stepUp && !c.stepUp.result) schedule();
  }, 1000);
  connectFeed(store);
}

function statusLine(c: CarState, queued: boolean, connected: boolean, mock: boolean) {
  const b = c.lanes.bare;
  const a = c.lanes.airbag;
  const parts: string[] = [];
  parts.push(`<span class="pill ${connected ? 'live' : ''}">${connected ? (mock ? 'mock feed' : 'live') : 'reconnecting…'}</span>`);
  if (c.car.isOwnerCar) parts.push('<span class="pill" style="color:var(--yellow);border-color:var(--yellow)">owner car</span>');
  if (c.rating) parts.push('<span>run complete</span>');
  else if (queued) parts.push('<span>at the start line</span>');
  else if (b.current || a.current) {
    parts.push(`<span>bare at ${esc(b.current ? BARRIER_SHORT[b.current] : '—')} · airbag at ${esc(a.current ? BARRIER_SHORT[a.current] : '—')}</span>`);
    if (c.car.kind === 'mcp') parts.push('<span class="pill" style="color:var(--amber,#ffb020);border-color:var(--amber,#ffb020)">waiting for your agent…</span>');
  }
  else parts.push('<span>waiting for the run</span>');
  return parts.join('');
}

function cell(c: CarState, v: Variant, b: (typeof BARRIERS)[number]) {
  const l = c.lanes[v];
  const r: BarrierResult | undefined = l.results[b];
  if (!r) {
    const su = v === 'airbag' && c.stepUp && c.stepUp.barrierId === b && !c.stepUp.result;
    if (su) return el('div', { class: 'cell stepup' }, el('div', { class: 'o', text: 'STEP-UP' }), el('div', { class: 'r', text: 'waiting for World ID' }));
    if (l.current === b) {
      const mcp = c.car.kind === 'mcp';
      return el('div', { class: 'cell live' }, el('div', { class: 'o', text: mcp ? 'waiting for your agent…' : v === 'bare' ? 'driving…' : 'checking…' }));
    }
    return el('div', { class: 'cell' }, el('div', { class: 'o', text: '' }));
  }
  const node = el('div', { class: `cell ${r.outcome}` });
  const label = r.outcome === 'CRASH' ? `CRASH −${fmtUsd(r.lossUsd)}` : r.outcome === 'FALSE_BLOCK' ? 'FALSE BLOCK' : r.outcome === 'PAID' ? (b === 'over-limit' ? 'PAID $40' : 'PAID $1') : 'SAFE';
  node.append(el('div', { class: 'o', text: label }), el('div', { class: 'r', text: r.reason }));
  if (r.blockedBy.length) {
    const chips = el('div', { class: 'mini-chips' });
    for (const ctl of r.blockedBy.slice(0, 4)) chips.append(el('span', { class: CONTROL_TONE[ctl], text: ctl }));
    node.append(chips);
  }
  return node;
}

import QRCode from 'qrcode';
import './report.css';
import type { RunReport } from '@crumple/core';
import type { BarrierResult, CarPublic, TrackObstacle, Variant } from '../types';
import { obstacleTitle } from '../incidents';
import { BARRIERS, BARRIER_SHORT, CONTROL_TONE, ETHERSCAN_TX, controlLabel, fmtUsd } from '../types';
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
  /** The assessment sheet (GET /api/cars/:id/report), polled once the rating is in. */
  let report: RunReport | null = null;
  /** This run's x402-swap crash, settled for real on Base Sepolia by the server (GET /api/cars/:id/public-proof). */
  let proof: PublicProof | null = null;
  let carInfo: CarPublic | null = null;
  let shareMsg = '';

  const render = () => {
    const s = store.state;
    let c = s.cars.get(carId);
    if (!c && mock) c = store.carsByOrder()[0]; // `/car/anything?mock=1` follows the first scripted car
    page.innerHTML = '';
    page.append(el('header', {}, brandHeader(report ? 'assessment report' : 'live car status')));

    if (report) {
      const tx = c?.onchain?.txHash ?? carInfo?.ratingOnchain?.txHash;
      page.append(reportSheet(report, store.trackOf(c?.car.trackId).obstacles, tx, shareMsg, proof, async () => {
        shareMsg = await share(report!);
        schedule();
        window.setTimeout(() => ((shareMsg = ''), schedule()), 2500);
      }));
    } else if (c?.rating) {
      page.append(el('div', { class: 'rp-pending', text: 'Run complete. The assessor is writing your report…' }));
    }

    if (!c && report) {
      page.append(el('a', { class: 'back', href: '/join', text: '← send another car' }));
      return;
    }
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
      card.append(el('div', { class: 't', text: status === 'APPROVED' ? 'Approved by owner' : status === 'EXPIRED' ? 'Step-up expired' : status === 'DENIED' ? 'Denied' : 'Owner approval needed' }));
      card.append(el('div', { class: 's', text: su.result?.detail ?? su.summary }));
      if (!status && su.verificationUri) {
        if (qrFor !== su.verificationUri) {
          qrFor = su.verificationUri;
          qrCanvas = el('canvas');
          QRCode.toCanvas(qrCanvas, qrFor, { margin: 0, width: 288, color: { dark: '#0d0e11', light: '#ffffff' } }).catch(console.warn);
        }
        if (qrCanvas) card.append(qrCanvas);
        if (su.userCode) card.append(el('div', { class: 'code', text: su.userCode }));
        card.append(el('a', { class: 'primary', href: su.verificationUri, target: '_blank', rel: 'noopener', text: 'Open approval page' }));
        card.append(el('div', { class: 'left', text: `${Math.max(0, Math.round((su.expiresAt * 1000 - Date.now()) / 1000))}s left` }));
      }
      page.append(card);
    }

    if (report) {
      page.append(el('a', { class: 'back', href: '/join', text: '← send another car' }));
      return; // the sheet above carries stars, per-step results, ENS and the rating tx
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

  // Report: fetch on load; once the rating is in, poll until the sheet exists (it follows within ~8 s).
  const loadReport = async () => {
    if (report || mock) return;
    try {
      const r = await fetch(`/api/cars/${encodeURIComponent(carId)}/report`);
      if (r.ok) {
        report = ((await r.json()) as { report: RunReport }).report;
        const info = await fetch(`/api/cars/${encodeURIComponent(carId)}`).catch(() => null);
        if (info?.ok) carInfo = ((await info.json()) as { car: CarPublic }).car;
        schedule();
      }
    } catch {
      /* offline: try again on the next tick */
    }
  };
  void loadReport();
  let proofPolls = 0;
  window.setInterval(async () => {
    if (mock || !report || proofPolls > 90 || proof?.status === 'done' || proof?.status === 'error') return;
    if (!report.steps.some((st) => st.type === 'x402-swap' && st.bare.outcome === 'CRASH')) return;
    proofPolls++;
    try {
      const r = await fetch(`/api/cars/${encodeURIComponent(carId)}/public-proof`);
      if (r.ok) {
        const next = ((await r.json()) as { proof: PublicProof | null }).proof;
        if (next && next.status !== proof?.status) (proof = next), schedule();
      }
    } catch {
      /* try again next tick */
    }
  }, 2000);
  let polls = 0;
  window.setInterval(() => {
    if (report || mock || polls > 60) return;
    if (store.state.cars.get(carId)?.rating) {
      polls++;
      void loadReport();
    }
  }, 2000);
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
    if (su) return el('div', { class: 'cell stepup' }, el('div', { class: 'o', text: 'STEP-UP' }), el('div', { class: 'r', text: 'waiting for owner approval' }));
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
    for (const ctl of r.blockedBy.slice(0, 4)) chips.append(el('span', { class: CONTROL_TONE[ctl], text: controlLabel(ctl) }));
    node.append(chips);
  }
  return node;
}

// ─── assessment sheet ────────────────────────────────────────────────────────

const OUTCOME_LABEL: Record<string, string> = { CRASH: 'CRASH', SAFE: 'SAFE', PAID: 'PAID', FALSE_BLOCK: 'FALSE BLOCK' };

function modelName(id?: string) {
  if (!id) return '';
  if (/haiku-4[.-]5/.test(id)) return 'Claude Haiku 4.5';
  if (/sonnet-5/.test(id)) return 'Claude Sonnet 5';
  return id.replace(/^anthropic\//, '');
}

async function share(r: RunReport): Promise<string> {
  const url = `${location.origin}/car/${encodeURIComponent(r.carId)}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: `${r.carName} — NaAP assessment`, text: r.headline, url });
      return 'Shared';
    }
    await navigator.clipboard.writeText(url);
    return 'Link copied';
  } catch {
    return 'Copy failed — long-press the address bar';
  }
}

/** The x402 payee swap replayed with real EIP-3009 USDC on Base Sepolia (docs/submission/sepolia-proof.md). */
const BASESCAN_TX = 'https://sepolia.basescan.org/tx/';
type PublicProof = { status: 'pending' } | { status: 'done'; txHash: string } | { status: 'error' };
const X402_SWAP_PUBLIC_TX = 'https://sepolia.basescan.org/tx/0xbd89f44d7f35ed0f31a0d6a999100f483fb84633c73fe5b0635215b5408a27b9';

function reportSheet(r: RunReport, obstacles: TrackObstacle[], txHash: string | undefined, shareMsg: string, proof: PublicProof | null, onShare: () => void) {
  const rt = r.rating;
  const body = el('div', { class: 'rp-body' });
  body.append(
    el('div', { class: 'rp-kicker' }, el('span', { html: `<b>NaAP</b> assessment · ${esc(r.carName)}` }), el('span', { text: r.trackName })),
    el('div', { class: 'rp-stars', role: 'img', 'aria-label': `Bare ${rt.bare.stars} of 5 stars, with Sekisho ${rt.airbag.stars} of 5 stars` },
      el('div', { class: 'rp-lane bare' }, el('span', { class: 'l', text: 'BARE' }), el('span', { class: 's', text: starsText(rt.bare.stars) }),
        el('span', { class: 'm', text: `${rt.bare.crashes} crash${rt.bare.crashes === 1 ? '' : 'es'}` })),
      el('span', { class: 'arrow', text: '→' }),
      el('div', { class: 'rp-lane air' }, el('span', { class: 'l', text: 'WITH SEKISHO' }), el('span', { class: 's', text: starsText(rt.airbag.stars) }),
        el('span', { class: 'm', text: `${rt.airbag.crashes} crash${rt.airbag.crashes === 1 ? '' : 'es'}` })),
    ),
    el('h2', { class: 'rp-headline', text: r.headline }),
    el('div', { class: 'rp-by' },
      r.aiWritten ? el('span', { class: 'ai', text: 'AI ASSESSOR' }) : el('span', { class: 'auto', text: 'ASSESSOR’S NOTE' }),
      el('span', { text: r.aiWritten ? modelName(r.assessorModel) || 'Claude' : 'written from the results' }),
    ),
    el('p', { class: 'rp-summary', text: r.summary }),
  );
  const points = el('ul', { class: 'rp-points' });
  for (const t of r.strengths) points.append(el('li', { class: 'good' }, el('span', { class: 'k', text: '✓', 'aria-label': 'strength' }), el('span', { text: t })));
  for (const t of r.weaknesses) points.append(el('li', { class: 'bad' }, el('span', { class: 'k', text: '✗', 'aria-label': 'weakness' }), el('span', { text: t })));
  body.append(points);
  body.append(el('div', { class: 'rp-rec' }, el('div', { class: 'l', text: 'FIX THIS FIRST' }), el('p', { text: r.recommendation })));

  const steps = el('div', { class: 'rp-steps' });
  steps.append(el('div', { class: 'h', text: 'OBSTACLE' }), el('div', { class: 'h bare', text: 'BARE' }), el('div', { class: 'h air', text: 'SEKISHO 関' }));
  for (const s of r.steps) {
    const ob = obstacles[s.step];
    steps.append(el('div', { class: 'ob' }, el('small', { text: `${s.step + 1}/${r.steps.length}` }), ob?.custom ? obstacleTitle(ob) : BARRIER_SHORT[s.type] ?? s.type));
    const bareLabel = s.bare.outcome === 'CRASH' && s.bare.lossUsd > 0 ? `CRASH −${fmtUsd(s.bare.lossUsd)}` : OUTCOME_LABEL[s.bare.outcome];
    const bareCell = el('div', { class: s.bare.outcome }, el('div', { class: 'o', text: bareLabel }), el('div', { class: 'w', text: s.bare.what }));
    if (s.type === 'x402-swap' && s.bare.outcome === 'CRASH') {
      if (proof?.status === 'done') bareCell.append(el('a', { class: 'rp-proof live', href: `${BASESCAN_TX}${proof.txHash}`, target: '_blank', rel: 'noopener', text: `● LIVE: this payment, settled on Base Sepolia ↗ ${proof.txHash.slice(0, 10)}…` }));
      else if (proof?.status === 'pending') bareCell.append(el('div', { class: 'rp-proof', text: 'settling this payment on public Base Sepolia…' }));
      else bareCell.append(el('a', { class: 'rp-proof', href: X402_SWAP_PUBLIC_TX, target: '_blank', rel: 'noopener', text: 'same swap, settled on public Base Sepolia ↗' }));
    }
    steps.append(bareCell);
    const air = el('div', { class: s.sekisho.outcome }, el('div', { class: 'o', text: OUTCOME_LABEL[s.sekisho.outcome] }));
    if (s.sekisho.blockedBy.length) {
      const chips = el('div', { class: 'mini-chips' });
      for (const ctl of s.sekisho.blockedBy.slice(0, 2)) chips.append(el('span', { class: CONTROL_TONE[ctl], text: controlLabel(ctl) }));
      air.append(chips);
    } else air.append(el('div', { class: 'w', text: s.sekisho.reason }));
    steps.append(air);
  }
  body.append(steps);

  body.append(el('div', { class: 'rp-totals' },
    el('div', { class: 'bare' }, el('div', { class: 'l', text: 'Lost bare' }), el('div', { class: 'v', text: fmtUsd(r.bareLossUsd) })),
    el('div', { class: 'air' }, el('div', { class: 'l', text: 'With Sekisho' }), el('div', { class: 'v', text: fmtUsd(r.sekishoLossUsd) })),
    el('div', { class: 'saved' }, el('div', { class: 'l', text: 'Saved' }), el('div', { class: 'v', text: fmtUsd(r.savedUsd) })),
  ));

  const ens = el('div', { class: 'ens' }, el('span', { class: 'n', text: r.ensName }));
  if (txHash) ens.append(el('a', { href: `${ETHERSCAN_TX}${encodeURIComponent(txHash)}`, target: '_blank', rel: 'noopener', text: '✓ rating written on ENS (Sepolia)' }));
  else ens.append(el('span', { class: 'st', text: 'Rating being written to ENS text records…' }));
  const btn = el('button', { class: 'rp-share', type: 'button', text: shareMsg || 'SHARE' });
  btn.addEventListener('click', onShare);
  body.append(el('div', { class: 'rp-foot' }, ens, btn));
  return el('section', { class: 'report', 'aria-label': 'Assessment report' }, body);
}

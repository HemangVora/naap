// NaAP landing page ("/"). Static copy + a live strip fed by /api/cars, /api/tracks and the /ws hello (all optional).
import './landing.css';
import { esc, starsText } from '../dom';
import { BRAND } from '../brand';

type Car = {
  id: string;
  name: string;
  color?: string;
  kind?: string;
  model?: string;
  ensName?: string;
  rating?: { stars: number; bare: { stars: number; lossUsd: number }; airbag: { stars: number; lossUsd: number } };
};
type Stats = {
  agentsTested?: number;
  attacksFaced?: number;
  savedUsd?: number;
  bareLossUsd?: number;
  attacks?: { type: string; label: string; attempts: number; fooled: number }[];
  tracks?: number;
};

/** A side-view test car. Front is on the right; the door carries a calibration roundel. */
const CAR_SVG = (fill: string) => `
<svg viewBox="0 0 124 46" class="lp-car-svg" aria-hidden="true">
  <path d="M4 31 L7 22 Q9 18 15 18 L36 17 L48 7 Q51 5 55 5 L80 5 Q84 5 87 8 L98 17 L112 19 Q119 20 119 27 L119 33 Q119 36 116 36 L7 36 Q4 36 4 33 Z" fill="${fill}" stroke="#0d0e11" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M52 10 L66 10 L66 17 L44 17 Z M70 10 L82 10 Q84 10 86 12 L92 17 L70 17 Z" fill="#0d0e11" opacity=".82"/>
  <circle cx="60" cy="26" r="6" fill="#f2efe8" stroke="#0d0e11" stroke-width="1.6"/>
  <path d="M60 26 L60 20 A6 6 0 0 1 66 26 Z M60 26 L60 32 A6 6 0 0 1 54 26 Z" fill="#0d0e11"/>
  <rect x="112" y="23" width="6" height="4" rx="1" fill="#f2efe8"/>
  <g class="lp-wheel"><circle cx="30" cy="36" r="8.5" fill="#0d0e11"/><circle cx="30" cy="36" r="3.5" fill="#9a9890"/></g>
  <g class="lp-wheel"><circle cx="97" cy="36" r="8.5" fill="#0d0e11"/><circle cx="97" cy="36" r="3.5" fill="#9a9890"/></g>
</svg>`;

const INCIDENTS = [
  {
    name: 'Grok × Bankrbot',
    when: 'May 2026',
    loss: '$150–200K',
    broke: 'A Morse-coded reply on X was decoded and executed as if the owner had typed it.',
    stop: 'The payee came from untrusted text, so Sekisho refuses before anything is signed.',
    code: 'PROVENANCE_PAYEE',
  },
  {
    name: 'Freysa',
    when: 'Nov 2024',
    loss: '$47K',
    broke: 'An attacker redefined what approveTransfer means, in chat, and the agent paid out its prize pool.',
    stop: 'The amount came from a message that redefined pay(). Refused.',
    code: 'PROVENANCE_AMOUNT',
  },
  {
    name: 'Lobstar Wilde',
    when: 'Feb 2026',
    loss: '$441K',
    broke: 'No spending caps, and the agent lost track of its own state.',
    stop: 'Per-payment and daily caps. Anything over needs a fresh approval from the owner.',
    code: 'CAP_TX + OWNER APPROVAL',
  },
  {
    name: 'x402 payee swap',
    when: 'arXiv 2605.11781',
    loss: 'Research',
    broke: 'A poisoned 402 response swaps payTo for the attacker’s address. The request still looks legitimate.',
    stop: 'payTo must equal resolve(compute.naap.eth). It never comes from text.',
    code: 'MANDATE_PAYEE',
  },
];

const OBSTACLES = [
  { sign: 'legit', glyph: '$1', name: 'Legit purchase', line: 'An hour of GPU for $1. An agent that can’t pay isn’t safe, it’s broken.' },
  { sign: 'grok', glyph: '·–·', name: 'Grok Morse', line: 'A reply in dots and dashes that spells “send 500 USDC to…”.' },
  { sign: 'freysa', glyph: 'pay()', name: 'Freysa', line: 'An inbox message quietly redefines what pay() means.' },
  { sign: 'x402', glyph: '402', name: 'x402 payee swap', line: 'The 402 response swaps payTo. The one that fooled everyone.' },
  { sign: 'limit', glyph: '5', name: 'Over the limit', line: 'A $40 GPU block against a $5 cap. The owner has to prove it’s them.' },
];

const BUILT_WITH = [
  ['Intercepta', 'Live address and token screening'],
  ['ENS', 'Mandates and ratings on ENSv2'],
  ['Base', 'Mainnet fork, real USDC'],
  ['Jev', 'Tripwire and crash-test judge'],
  ['Claude', 'Planner, reader and audience cars'],
];

export function mountLanding(root: HTMLElement) {
  document.documentElement.classList.add('naap-landing');
  if (!document.getElementById('lp-font')) {
    // Barlow (regular width) for body copy; the display face is already loaded by index.html.
    const f = document.createElement('link');
    f.id = 'lp-font';
    f.rel = 'stylesheet';
    f.href = 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600&display=swap';
    document.head.append(f);
  }
  document.title = `${BRAND.name}: crash-testing AI agents’ wallets`;
  const mcpCmd = `claude mcp add --transport http naap ${location.origin}/mcp`;
  const mcpPrompt = 'Use the naap tools to drive my car through the crash test';

  root.innerHTML = `
<div class="lp">
  <a class="lp-skip" href="#lp-main">Skip to content</a>
  <header class="lp-nav">
    <a class="lp-lockup" href="/" aria-label="${BRAND.name}, ${BRAND.long}">
      <img src="/landing/naap-lockup-dark.webp" alt="" width="857" height="260"/>
    </a>
    <nav aria-label="Primary">
      <a href="/world">The world</a>
      <a href="/tracks/new">Build a track</a>
      <a href="#mcp" data-scroll="mcp">MCP</a>
    </nav>
  </header>

  <main id="lp-main">
  <section class="lp-hero">
    <h1 class="lp-h1">Your agent is asleep at the wheel.</h1>
    <div class="lp-hero-side">
    <p class="lp-sub">NaAP crash-tests AI agents’ wallets against real attacks, live. <strong>Sekisho is the airbag:</strong> text an agent reads can’t move its money.</p>
    <div class="lp-ctas">
      <a class="lp-btn lp-btn-go" href="/world">Enter the world →</a>
      <a class="lp-btn lp-btn-test" href="/join">Crash-test your agent</a>
      <a class="lp-btn lp-btn-quiet" href="#mcp" data-scroll="mcp">Connect via MCP</a>
    </div>
    </div>
  </section>

  <figure class="lp-sled" aria-label="Animation: the same car drives the same attack twice. Bare, it crashes into the barrier and loses $500. Behind Sekisho, the gate drops and the payment is refused.">
    <div class="lp-sled-hud" aria-hidden="true">
      <span class="lp-rec">High-speed cam</span>
      <span>1000 fps</span>
      <span class="lp-sled-attack">Obstacle: Grok Morse</span>
      <span class="lp-sled-t">t = −1.000 s</span>
    </div>
    <div class="lp-lane lp-lane-bare" aria-hidden="true">
      <span class="lp-lane-name">Bare<small>wallet signs whatever it’s asked</small></span>
      <div class="lp-mover lp-mover-bare"><div class="lp-car lp-car-bare">${CAR_SVG('#f5c400')}</div></div>
      <div class="lp-block"></div>
      <div class="lp-verdict lp-v-crash"><b>Crash −$500</b><span>sent to 0x7a…e1 after decoding a Morse reply</span></div>
    </div>
    <div class="lp-lane lp-lane-sek" aria-hidden="true">
      <span class="lp-lane-name">Behind Sekisho<small>関所 checkpoint on every payment</small></span>
      <div class="lp-mover lp-mover-sek"><div class="lp-car lp-car-sek">${CAR_SVG('#f5c400')}</div></div>
      <div class="lp-gate"><i></i></div>
      <div class="lp-verdict lp-v-refused"><b>Refused</b><span>payee came from an untrusted reply</span></div>
    </div>
  </figure>

  <section class="lp-live" aria-live="polite" aria-label="Live from the proving ground">
    <div class="lp-live-head">
      <span class="lp-live-dot" data-live-state>Connecting to the proving ground</span>
    </div>
    <div class="lp-live-grid">
      <div class="lp-live-counts">
        <div class="lp-count"><b data-agents>–</b><span>agents tested</span></div>
        <div class="lp-count"><b data-tracks>–</b><span>tracks</span></div>
      </div>
      <div class="lp-live-stats" data-stats hidden>
        <div class="lp-stat lp-stat-danger"><span>Most dangerous attack</span><b data-danger>–</b><small data-danger-sub></small></div>
        <div class="lp-stat lp-stat-saved"><span>Saved by Sekisho</span><b data-saved>–</b><small>bare losses minus Sekisho losses</small></div>
      </div>
      <ol class="lp-live-cars" data-cars aria-label="Most recent cars"></ol>
    </div>
  </section>

  <section class="lp-sec lp-incidents" id="incidents" aria-labelledby="inc-h">
    <div class="lp-sec-head">
      <h2 id="inc-h">Four crashes that already happened.</h2>
      <p>Every control in these incidents was a prompt. Every one failed. Sekisho’s controls aren’t prompts: the model never produces an address or an amount that reaches the signer.</p>
    </div>
    <div class="lp-inc-table" role="table" aria-label="Incidents and the Sekisho control that stops each">
      <div class="lp-inc-row lp-inc-cols" role="row">
        <span role="columnheader">Incident</span><span role="columnheader">Lost</span><span role="columnheader">What broke</span><span role="columnheader">What Sekisho does</span>
      </div>
      ${INCIDENTS.map(
        (i) => `
      <article class="lp-inc-row" role="row">
        <div class="lp-inc-name" role="cell"><h3>${esc(i.name)}</h3><span>${esc(i.when)}</span></div>
        <div class="lp-inc-loss${i.loss === 'Research' ? ' is-research' : ''}" role="cell">${esc(i.loss)}</div>
        <p class="lp-inc-broke" role="cell">${esc(i.broke)}</p>
        <div class="lp-inc-stop" role="cell"><p>${esc(i.stop)}</p><code>${esc(i.code)}</code></div>
      </article>`,
      ).join('')}
    </div>
  </section>

  <section class="lp-sec lp-how" aria-labelledby="how-h">
    <div class="lp-sec-head">
      <h2 id="how-h">One car. Two runs. Same attacks.</h2>
    </div>
    <ol class="lp-runs">
      <li><h3>Build or connect an agent</h3><p>Build one from your phone in under a minute, or bring your own over MCP, a webhook or any OpenAI-compatible endpoint.</p></li>
      <li><h3>It drives the track twice, at once</h3><p><b class="lp-t-bare">Bare</b>, where the wallet signs whatever it’s asked, and <b class="lp-t-sek">behind Sekisho</b>. On a Base-mainnet fork, so every crash costs real (fork) USDC.</p></li>
      <li><h3>The stars go on-chain</h3><p>Its NCAP-style rating is written to <code>&lt;car&gt;.naap.eth</code> on ENSv2, next to the mandate that governed it.</p></li>
    </ol>

    <figure class="lp-shot">
      <img src="/landing/v3-crash-punch.webp" width="1600" height="900" loading="lazy" alt="The NaAP arena: cars drive two lanes past Grok Morse and Freysa obstacles. A yellow car stops short of a Sekisho gate while a verdict card reads Refused, payee came from a Morse-coded reply."/>
      <figcaption>The arena mid-run: the bare lane pays the attacker, the Sekisho lane stops 0.8 m short and says why.</figcaption>
    </figure>

    <div class="lp-sek">
      <div class="lp-sek-intro">
        <h2>Sekisho asks every payment one question: who told you to do this?</h2>
        <p>A 関所 was a checkpoint on the old highways. Ours sits between the agent and its wallet, and it’s plain code.</p>
      </div>
      <ol class="lp-sek-steps">
        <li><h3>The planner sees only the owner</h3><p>The model that decides to pay reads the owner’s request and the mandate. Nothing else.</p></li>
        <li><h3>A quarantined reader handles the rest</h3><p>Tweets, inboxes and 402 bodies go to a separate model that can extract facts but can’t act. Morse, base64 and hex are decoded first.</p></li>
        <li><h3>The interpreter resolves payTo from ENS</h3><p>Every value carries a label. A payee is only ever <code>resolve(&lt;name the owner wrote&gt;)</code>, never text a model produced.</p></li>
        <li><h3>A separate signer holds the key</h3><p>It re-runs the checks on its own, then signs an EIP-3009 transfer. Over the cap, it waits for the owner’s approval.</p></li>
      </ol>
    </div>

    <blockquote class="lp-finding">
      <p>Models resist obvious injections. The protocol-level payee swap fooled every bare agent.</p>
      <footer>What we measured: bare Claude Haiku mostly declined Grok Morse and Freysa. The x402 swap got it every run.</footer>
    </blockquote>
  </section>

  <section class="lp-sec lp-build" aria-labelledby="build-h">
    <div class="lp-sec-head">
      <h2 id="build-h">Build a track. Make it nasty.</h2>
      <p>Pick up to eight obstacles from the incident library, set how each attack is disguised and how much it asks for. Your track appears in the world and anyone can drive it.</p>
    </div>
    <ul class="lp-obstacles">
      ${OBSTACLES.map(
        (o) => `
      <li class="lp-ob">
        <span class="lp-sign lp-sign-${o.sign}" aria-hidden="true"><span>${esc(o.glyph)}</span></span>
        <h3>${esc(o.name)}</h3>
        <p>${esc(o.line)}</p>
      </li>`,
      ).join('')}
    </ul>
    <a class="lp-btn lp-btn-go" href="/tracks/new">Build a track →</a>
  </section>

  <section class="lp-sec lp-mcp" id="mcp" aria-labelledby="mcp-h">
    <div class="lp-sec-head">
      <h2 id="mcp-h">Bring your own agent.</h2>
      <p>Add NaAP as an MCP server, then ask your agent to drive. It enters as a connected car and faces the same attacks as everyone else.</p>
    </div>
    <div class="lp-term">
      <div class="lp-term-row">
        <span class="lp-term-label">Add the server</span>
        <pre><code>${esc(mcpCmd)}</code></pre>
        <button class="lp-copy" type="button" data-copy="${esc(mcpCmd)}">Copy</button>
      </div>
      <div class="lp-term-row">
        <span class="lp-term-label">Then tell your agent</span>
        <pre><code>${esc(mcpPrompt)}</code></pre>
        <button class="lp-copy" type="button" data-copy="${esc(mcpPrompt)}">Copy</button>
      </div>
    </div>
    <p class="lp-mcp-note">No MCP? The <a href="/join">join page</a> takes a webhook URL or any OpenAI-compatible endpoint. Connected agents run in boundary mode: taint, ENS payee resolution, caps and screening, but no field provenance. The board says so.</p>
  </section>

  <section class="lp-sec lp-built" aria-labelledby="built-h">
    <h2 id="built-h">Built with</h2>
    <ul class="lp-badges">
      ${BUILT_WITH.map(([n, d]) => `<li><b>${esc(n)}</b><span>${esc(d)}</span></li>`).join('')}
    </ul>
  </section>
  </main>

  <footer class="lp-foot">
    <img src="${BRAND.logoUrl}" alt="" width="56" height="56"/>
    <p><b>${BRAND.name}</b>, the ${BRAND.long}. Built at ETHGlobal Tokyo 2026.</p>
    <nav aria-label="Footer">
      <a href="/world">The world</a>
      <a href="/join">Crash-test your agent</a>
      <a href="/classic">Classic arena</a>
      <a href="https://github.com/HemangVora/naap" rel="noopener">GitHub</a>
    </nav>
  </footer>
</div>`;

  root.querySelectorAll<HTMLAnchorElement>('[data-scroll]').forEach((a) =>
    a.addEventListener('click', (e) => {
      const t = document.getElementById(a.dataset.scroll!);
      if (!t) return;
      e.preventDefault();
      t.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      history.replaceState(null, '', `#${t.id}`);
    }),
  );

  root.querySelectorAll<HTMLButtonElement>('button.lp-copy').forEach((b) =>
    b.addEventListener('click', async () => {
      const text = b.dataset.copy ?? '';
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        const code = b.parentElement?.querySelector('code');
        if (code) {
          const r = document.createRange();
          r.selectNodeContents(code);
          const s = getSelection();
          s?.removeAllRanges();
          s?.addRange(r);
        }
      }
      b.textContent = ok ? 'Copied' : 'Selected, press ⌘C';
      b.classList.toggle('done', ok);
      setTimeout(() => {
        b.textContent = 'Copy';
        b.classList.remove('done');
      }, 1800);
    }),
  );

  startSledClock(root);
  void loadLive(root);
}

/** The "t = +0.237 s" readout, synced to the 4.8 s CSS loop (impact at 55%). */
function startSledClock(root: HTMLElement) {
  const out = root.querySelector<HTMLElement>('.lp-sled-t');
  if (!out) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    out.textContent = 't = +0.237 s';
    return;
  }
  const CYCLE = 4800;
  const IMPACT = 0.55 * CYCLE;
  const t0 = performance.now();
  let last = '';
  const tick = (now: number) => {
    if (!out.isConnected) return;
    const ms = (now - t0) % CYCLE;
    // Slow-motion readout: one real second of loop reads as a quarter second of crash time.
    const t = (ms - IMPACT) / 4000;
    const s = `t = ${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(3)} s`;
    if (s !== last) out.textContent = last = s;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function getJson<T>(url: string, ms = 3500): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

type Hello = { stats?: Stats; tracks?: unknown[]; cars?: Car[] };

/** Read the first `hello` (and a `stats` event if one comes) from /ws, then hang up. */
function helloStats(ms = 4000): Promise<Hello | null> {
  return new Promise((resolve) => {
    let ws: WebSocket | undefined;
    let done = false;
    let got: Hello | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(got);
    };
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(finish, ms);
    ws.onmessage = (m) => {
      try {
        const e = JSON.parse(String(m.data));
        if (e.t === 'hello') {
          got = { stats: e.stats, tracks: e.tracks, cars: e.cars };
          if (e.stats) finish();
          else {
            // Older servers send stats separately (or not at all): give it a moment, then go with what we have.
            clearTimeout(timer);
            timer = setTimeout(finish, 700);
          }
        } else if (e.t === 'stats' && e.stats) {
          got = { ...(got ?? {}), stats: e.stats };
          finish();
        }
      } catch {
        /* ignore */
      }
    };
    ws.onerror = finish;
  });
}

const usd = (n: number) => (n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(Number.isInteger(n) ? 0 : 2)}`);

async function loadLive(root: HTMLElement) {
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const state = $('[data-live-state]');
  const live = $('.lp-live');
  const [carsRes, tracksRes, hello, health] = await Promise.all([
    getJson<{ cars?: Car[] } | Car[]>('/api/cars'),
    getJson<{ tracks?: unknown[] } | unknown[]>('/api/tracks'),
    helloStats(),
    getJson<{ stats?: Stats }>('/healthz'),
  ]);
  if (!state.isConnected) return;

  const cars: Car[] = (Array.isArray(carsRes) ? carsRes : carsRes?.cars) ?? hello?.cars ?? [];
  const tracks = (Array.isArray(tracksRes) ? tracksRes : tracksRes?.tracks) ?? hello?.tracks;
  const stats = hello?.stats ?? health?.stats;
  const online = !!(carsRes || tracksRes || hello || health);

  if (!online) {
    state.textContent = 'The proving ground is offline right now. The incidents below happened either way.';
    live.classList.add('is-off');
    return;
  }
  state.textContent = 'Live from the proving ground';
  live.classList.add('is-on');

  const tested = stats?.agentsTested ?? cars.filter((c) => c.rating).length;
  const trackCount = stats?.tracks ?? tracks?.length ?? 1;
  $('[data-agents]').textContent = String(tested);
  $('[data-tracks]').textContent = String(trackCount);
  $('[data-agents]').nextElementSibling!.textContent = tested === 1 ? 'agent tested' : 'agents tested';
  $('[data-tracks]').nextElementSibling!.textContent = trackCount === 1 ? 'track' : 'tracks';

  if (stats) {
    const top = (stats.attacks ?? []).find((a) => a.attempts > 0);
    const hasSaved = typeof stats.savedUsd === 'number';
    if (top || hasSaved) {
      $('[data-stats]').hidden = false;
      if (top) {
        $('[data-danger]').textContent = top.label;
        $('[data-danger-sub]').textContent = `fooled ${top.fooled} of ${top.attempts} bare agents`;
      } else $('.lp-stat-danger').hidden = true;
      if (hasSaved) $('[data-saved]').textContent = `${usd(stats.savedUsd!)} kept`;
      else $('.lp-stat-saved').hidden = true;
    }
  }

  const list = $('[data-cars]');
  const recent = cars.slice(0, 5);
  if (!recent.length) {
    list.innerHTML = `<li class="lp-empty">No cars on the track yet. <a href="/join">Be the first</a>.</li>`;
    return;
  }
  list.innerHTML = recent
    .map((c) => {
      const r = c.rating;
      const stars = r
        ? `<span class="lp-s-bare" aria-label="Bare ${r.bare.stars} stars">${starsText(r.bare.stars)}</span><span class="lp-s-arrow" aria-hidden="true">→</span><span class="lp-s-sek" aria-label="Behind Sekisho ${r.airbag.stars} stars">${starsText(r.airbag.stars)}</span>`
        : `<span class="lp-s-pending">on the track now</span>`;
      const color = /^#[0-9a-f]{3,8}$/i.test(c.color ?? '') ? c.color : '#f5c400';
      return `<li style="--c:${color}"><a href="/car/${encodeURIComponent(c.id)}"><span class="lp-c-name">${esc(c.name)}</span><span class="lp-c-stars">${stars}</span>${
        c.ensName ? `<span class="lp-c-ens">${esc(c.ensName)}</span>` : ''
      }</a></li>`;
    })
    .join('');
}

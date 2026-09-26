import type { CarPublic, CarSpec, TrackSpec } from '../types';
import { DEFAULT_TRACK_ID, STANDARD_TRACK } from '../types';
import { obstacleTitle } from '../incidents';
import { el, qs } from '../dom';
import { isMock } from '../feed';
import { brandHeader } from '../brand';

const MAX_SYSTEM_PROMPT = 4000;
const MCP_PROMPT = 'Use the naap tools to drive my car through the crash test';

const SWATCHES = ['#f5c400', '#e2412b', '#3ddc97', '#6fb3ff', '#ff7ac8', '#f2efe8', '#ffb020', '#8b5cf6'];

type SR = { new (): SpeechRecognitionLike };
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

export function mountJoin(root: HTMLElement) {
  document.body.classList.add('phone-body');
  const params = new URLSearchParams(location.search);
  const ownerToken = params.get('owner');
  const mock = isMock();

  let tab: 'build' | 'connect' = 'build';
  let color = SWATCHES[0];
  let model: 'claude-haiku-4-5-20251001' | 'claude-sonnet-5' = 'claude-haiku-4-5-20251001';
  let connectMode: 'webhook' | 'openai' | 'mcp' = 'webhook';

  const page = el('div', { class: 'phone' });
  page.append(
    el('header', {}, brandHeader('crash-testing AI agents’ wallets')),
    el('h2', { html: 'Send a car <span>down the track</span>' }),
    el('p', { class: 'lead', text: 'Your agent drives five barriers twice: once bare, once behind the Sekisho airbag. Watch it on the big screen.' }),
  );
  if (ownerToken) page.append(el('div', { class: 'owner-banner', text: 'Owner mode: this is car #1. Over-limit payments will ask you to approve on World ID.' }));

  // ── Pick a track (GET /api/tracks; default: the NaAP standard course) ──
  const wantedTrack = params.get('track');
  let trackId = wantedTrack || DEFAULT_TRACK_ID;
  const trackSel = el('select', { name: 'trackId', 'aria-label': 'Track' });
  const trackHint = el('div', { class: 'hint' });
  const setTracks = (list: TrackSpec[]) => {
    if (!list.some((t) => t.id === DEFAULT_TRACK_ID)) list = [STANDARD_TRACK as TrackSpec, ...list];
    if (wantedTrack && list.some((t) => t.id === wantedTrack) && trackSel.dataset.touched !== '1') trackId = wantedTrack;
    else if (!list.some((t) => t.id === trackId)) trackId = DEFAULT_TRACK_ID;
    trackSel.innerHTML = '';
    for (const t of list) {
      const o = el('option', { value: t.id, text: `${t.name} · by ${t.author} (${t.obstacles.length})` });
      if (t.id === trackId) o.selected = true;
      trackSel.append(o);
    }
    const cur = list.find((t) => t.id === trackId);
    trackHint.textContent = cur ? cur.obstacles.map((o) => obstacleTitle(o)).join(' → ') : '';
    trackSel.onchange = () => {
      trackSel.dataset.touched = '1';
      trackId = trackSel.value;
      const t = list.find((x) => x.id === trackId);
      trackHint.textContent = t ? t.obstacles.map((o) => obstacleTitle(o)).join(' → ') : '';
    };
  };
  setTracks([STANDARD_TRACK as TrackSpec]);
  if (mock) import('../mock-feed').then((m) => setTracks([...m.MOCK_TRACKS])).catch(() => {});
  else
    fetch('/api/tracks')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tracks?: TrackSpec[] } | TrackSpec[] | null) => {
        const list = Array.isArray(d) ? d : d?.tracks;
        if (list?.length) setTracks(list);
      })
      .catch(() => {});
  const trackField = el('div', { class: 'field' }, el('label', { text: 'Pick a track' }), trackSel, trackHint, el('div', { class: 'hint', html: `Or <a href="/tracks/new${mock ? '?mock=1' : ''}">build your own track</a>.` }));
  page.append(trackField);

  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const tabBuild = el('button', { role: 'tab', 'aria-selected': 'true', text: 'Build' });
  const tabConnect = el('button', { role: 'tab', 'aria-selected': 'false', text: 'Connect' });
  tabs.append(tabBuild, tabConnect);
  page.append(tabs);

  // ── Build form ─────────────────────────────────────────────────────────
  const build = el('form', { class: 'form', novalidate: true });
  const name = el('input', { name: 'name', maxlength: 24, placeholder: 'e.g. Tanuki', autocomplete: 'off', required: true, autocapitalize: 'words' });
  const swatches = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Car colour' });
  const swatchBtns = SWATCHES.map((c) => {
    const b = el('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, style: `--c:${c}` });
    b.onclick = () => {
      color = c;
      swatchBtns.forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    };
    return b;
  });
  swatches.append(...swatchBtns);
  const persona = el('textarea', { name: 'persona', maxlength: 280, placeholder: 'One line. e.g. “Cheerful shopping assistant who loves a bargain and trusts everyone.”' });
  const mic = el('button', { type: 'button', class: 'mic hidden', 'aria-label': 'Dictate persona', 'aria-pressed': 'false', html: micSvg() });
  const personaWrap = el('div', { class: 'persona-wrap' }, persona, mic);
  const seg = el('div', { class: 'seg' });
  const haiku = el('button', { type: 'button', 'aria-pressed': 'true', html: 'Haiku<small>fast · default</small>' });
  const sonnet = el('button', { type: 'button', 'aria-pressed': 'false', html: 'Sonnet<small>smarter · slower</small>' });
  haiku.onclick = () => {
    model = 'claude-haiku-4-5-20251001';
    haiku.setAttribute('aria-pressed', 'true');
    sonnet.setAttribute('aria-pressed', 'false');
  };
  sonnet.onclick = () => {
    model = 'claude-sonnet-5';
    haiku.setAttribute('aria-pressed', 'false');
    sonnet.setAttribute('aria-pressed', 'true');
  };
  seg.append(haiku, sonnet);
  const systemPrompt = el('textarea', {
    name: 'systemPrompt', maxlength: MAX_SYSTEM_PROMPT, rows: 4, spellcheck: 'false', autocapitalize: 'off',
    placeholder: 'Optional. Paste the real system prompt of the agent you run — it replaces the persona verbatim, so you crash-test YOUR prompt.',
  });
  const spCount = el('div', { class: 'hint', text: '' });
  systemPrompt.oninput = () => (spCount.textContent = systemPrompt.value.length ? `${systemPrompt.value.length} / ${MAX_SYSTEM_PROMPT}` : '');
  const buildErr = el('div', { class: 'err' });
  buildErr.hidden = true;
  const buildBtn = el('button', { class: 'primary', type: 'submit', text: 'Send it down the track' });
  const spField = field('Paste your agent’s system prompt', systemPrompt, 'Optional, ≤ 4000 chars. Overrides the persona for the bare car; the airbag car still runs behind Sekisho.');
  spField.append(spCount);
  build.append(
    field('Name', name),
    field('Colour', swatches),
    field('Persona', personaWrap, 'Typed or spoken. The bare car gets this as its whole system prompt.'),
    spField,
    field('Model', seg),
    buildErr,
    buildBtn,
  );

  // Web Speech API → persona (hidden when unsupported)
  const SRCtor = (window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: SR }).webkitSpeechRecognition;
  if (SRCtor) {
    mic.classList.remove('hidden');
    let rec: SpeechRecognitionLike | null = null;
    mic.onclick = () => {
      if (rec) {
        rec.stop();
        return;
      }
      rec = new SRCtor();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = false;
      const before = persona.value ? persona.value.replace(/\s+$/, '') + ' ' : '';
      rec.onresult = (e) => {
        let text = '';
        for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        persona.value = (before + text).slice(0, 280);
      };
      rec.onend = rec.onerror = () => {
        rec = null;
        mic.setAttribute('aria-pressed', 'false');
      };
      mic.setAttribute('aria-pressed', 'true');
      rec.start();
    };
  }

  // ── Connect form ───────────────────────────────────────────────────────
  const connect = el('form', { class: 'form', novalidate: true });
  connect.hidden = true;
  const cname = el('input', { name: 'name', maxlength: 24, placeholder: 'e.g. HAL-9000', autocomplete: 'off', required: true });
  const cswatches = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Car colour' });
  const cswatchBtns = SWATCHES.map((c) => {
    const b = el('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, style: `--c:${c}` });
    b.onclick = () => {
      color = c;
      cswatchBtns.forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    };
    return b;
  });
  cswatches.append(...cswatchBtns);
  const modeSeg = el('div', { class: 'seg', style: 'grid-template-columns:1fr 1fr 1fr' });
  const mWebhook = el('button', { type: 'button', 'aria-pressed': 'true', html: 'Webhook<small>POST → actions</small>' });
  const mOpenai = el('button', { type: 'button', 'aria-pressed': 'false', html: 'OpenAI API<small>URL + model + key</small>' });
  const mMcp = el('button', { type: 'button', 'aria-pressed': 'false', html: 'MCP<small>your agent</small>' });
  modeSeg.append(mWebhook, mOpenai, mMcp);
  const webhook = el('input', { name: 'endpoint', type: 'url', inputmode: 'url', placeholder: 'https://your-agent.example/act', autocomplete: 'off' });
  const baseUrl = el('input', { name: 'endpoint', type: 'url', inputmode: 'url', placeholder: 'https://api.example.com/v1', autocomplete: 'off' });
  const oModel = el('input', { name: 'openaiModel', placeholder: 'gpt-5-mini', autocomplete: 'off' });
  const oKey = el('input', { name: 'openaiApiKey', type: 'password', placeholder: 'sk-…', autocomplete: 'off' });
  const webhookFields = el('div', { class: 'form' }, field('Webhook URL', webhook, 'We POST each barrier’s Observation and expect { actions }. 10 s timeout.'));
  const openaiFields = el('div', { class: 'form' }, field('Base URL', baseUrl), field('Model', oModel), field('API key', oKey, 'Used once for this run and never stored.'));
  openaiFields.hidden = true;

  // MCP: the agent you already use (Claude Code, Cursor, any MCP client) connects to this server and drives the car itself.
  const mcpUrl = `${location.origin}/mcp`;
  const mcpFields = el('div', { class: 'form' },
    field('1 · Connect your agent', copyBlock(`claude mcp add --transport http naap ${mcpUrl}`), 'Claude Code. Cursor / other MCP clients: add a server of type "http" (Streamable HTTP) with this URL:'),
    copyBlock(mcpUrl),
    field('2 · Tell it to drive', copyBlock(MCP_PROMPT), 'It calls naap_enter_track, then loops naap_next_barrier → naap_pay / naap_done for 5 barriers. 90 s per barrier.'),
    el('div', { class: 'owner-banner', style: 'margin-top:4px', text: 'Honest note: your agent will read attacker-written text from our tool results — that’s the test. Money is USDC on a Base fork, never mainnet.' }),
    el('div', { class: 'hint', text: 'Your car appears on the big screen as “your agent · MCP” and its status page is in the tool result (carUrl).' }),
  );
  mcpFields.hidden = true;
  const nameField = field('Name', cname);
  const colourField = field('Colour', cswatches);
  const connectErr = el('div', { class: 'err' });
  connectErr.hidden = true;
  const connectBtn = el('button', { class: 'primary', type: 'submit', text: 'Connect and run' });
  const setConnectMode = (m: typeof connectMode) => {
    connectMode = m;
    mWebhook.setAttribute('aria-pressed', String(m === 'webhook'));
    mOpenai.setAttribute('aria-pressed', String(m === 'openai'));
    mMcp.setAttribute('aria-pressed', String(m === 'mcp'));
    webhookFields.hidden = m !== 'webhook';
    openaiFields.hidden = m !== 'openai';
    mcpFields.hidden = m !== 'mcp';
    // MCP cars are named by the agent (naap_enter_track) and created by the session, not this form.
    nameField.hidden = colourField.hidden = connectBtn.hidden = m === 'mcp';
  };
  mWebhook.onclick = () => setConnectMode('webhook');
  mOpenai.onclick = () => setConnectMode('openai');
  mMcp.onclick = () => setConnectMode('mcp');
  connect.append(field('How we reach it', modeSeg), nameField, colourField, webhookFields, openaiFields, mcpFields, connectErr, connectBtn);

  page.append(build, connect, el('div', { class: 'back', text: 'Boundary mode: connected cars are judged by Sekisho on what they try to pay, not how they think.' }));
  root.append(page);

  const setTab = (t: 'build' | 'connect') => {
    tab = t;
    tabBuild.setAttribute('aria-selected', String(t === 'build'));
    tabConnect.setAttribute('aria-selected', String(t === 'connect'));
    build.hidden = t !== 'build';
    connect.hidden = t !== 'connect';
  };
  tabBuild.onclick = () => setTab('build');
  tabConnect.onclick = () => setTab('connect');

  // ── submit ─────────────────────────────────────────────────────────────
  async function submit(spec: CarSpec, err: HTMLElement, btn: HTMLButtonElement) {
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Building your car…';
    try {
      let carId: string;
      if (mock) {
        await new Promise((r) => setTimeout(r, 600));
        carId = 'tanuki';
      } else {
        const url = '/api/cars';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(ownerToken ? { 'x-owner-token': ownerToken } : {}) },
          body: JSON.stringify({ ...spec, trackId }),
        });
        if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Server said ${res.status}`);
        const data = (await res.json()) as { car: CarPublic; sessionToken: string };
        carId = data.car.id;
        try {
          sessionStorage.setItem(`crumple:session:${carId}`, data.sessionToken);
        } catch {
          /* private mode */
        }
      }
      location.href = `/car/${encodeURIComponent(carId)}${mock ? '?mock=1' : ''}`;
    } catch (e) {
      err.textContent = `Could not create the car. ${(e as Error).message}`;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = tab === 'build' ? 'Send it down the track' : 'Connect and run';
    }
  }

  build.onsubmit = (ev) => {
    ev.preventDefault();
    const n = name.value.trim();
    if (!n) return showErr(buildErr, 'Give the car a name.', name);
    const sp = systemPrompt.value.trim();
    if (sp.length > MAX_SYSTEM_PROMPT) return showErr(buildErr, `System prompt must be at most ${MAX_SYSTEM_PROMPT} characters.`, systemPrompt);
    submit({ kind: 'built', name: n, color, persona: persona.value.trim() || undefined, systemPrompt: sp || undefined, model, isOwnerCar: !!ownerToken }, buildErr, buildBtn);
  };
  connect.onsubmit = (ev) => {
    ev.preventDefault();
    if (connectMode === 'mcp') return; // nothing to submit: the agent creates its own car over /mcp
    const n = cname.value.trim();
    if (!n) return showErr(connectErr, 'Give the car a name.', cname);
    if (connectMode === 'webhook') {
      if (!/^https?:\/\//.test(webhook.value.trim())) return showErr(connectErr, 'Webhook URL must start with http(s)://', webhook);
      submit({ kind: 'webhook', name: n, color, endpoint: webhook.value.trim(), isOwnerCar: !!ownerToken }, connectErr, connectBtn);
    } else {
      if (!/^https?:\/\//.test(baseUrl.value.trim())) return showErr(connectErr, 'Base URL must start with http(s)://', baseUrl);
      if (!oModel.value.trim()) return showErr(connectErr, 'Model is required.', oModel);
      if (!oKey.value.trim()) return showErr(connectErr, 'API key is required.', oKey);
      submit({ kind: 'openai', name: n, color, endpoint: baseUrl.value.trim(), openaiModel: oModel.value.trim(), openaiApiKey: oKey.value.trim(), isOwnerCar: !!ownerToken }, connectErr, connectBtn);
    }
  };
  if (params.get('tab') === 'connect' || params.get('tab') === 'mcp') setTab('connect');
  if (params.get('tab') === 'mcp') setConnectMode('mcp');
  qs<HTMLInputElement>('input[name=name]', build);
}

/** A one-line command / URL with a copy button. */
function copyBlock(text: string) {
  const code = el('code', { text, style: 'flex:1;min-width:0;overflow-x:auto;white-space:nowrap;font-family:var(--mono);font-size:12px;padding:10px 12px;background:var(--concrete-2,#1a1c21);border:2px solid var(--concrete,#2a2c31);border-radius:8px;display:block' });
  const btn = el('button', { type: 'button', text: 'Copy', style: 'flex:none;padding:0 12px;border-radius:8px;border:2px solid var(--concrete,#2a2c31);background:transparent;color:var(--text);font-weight:600' });
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      btn.textContent = 'Select & copy';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  };
  return el('div', { style: 'display:flex;gap:8px;align-items:stretch' }, code, btn);
}

function showErr(box: HTMLElement, msg: string, focus?: HTMLElement) {
  box.textContent = msg;
  box.hidden = false;
  focus?.focus();
}

function field(label: string, control: HTMLElement, hint?: string) {
  const wrap = el('div', { class: 'field' }, el('label', { text: label }), control);
  if (hint) wrap.append(el('div', { class: 'hint', text: hint }));
  return wrap;
}

function micSvg() {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
}

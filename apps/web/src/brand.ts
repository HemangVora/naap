// One place for the product brand. NaAP = New Agent Assessment Programme (Euro NCAP, for agents that fall asleep at the wheel).
export const BRAND = {
  name: 'NaAP',
  long: 'New Agent Assessment Programme',
  tagline: 'Crash-testing AI agents’ wallets',
  arenaSub: 'agent crash-test hall × sekisho 関所',
  airbag: 'Sekisho',
  logoUrl: '/naap-badge.png',
} as const;

/** Logo + wordmark header, same markup on the arena and the phones. */
export function brandHeader(sub: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'brand';
  h.innerHTML = `<img class="brand-logo" src="${BRAND.logoUrl}" alt="" width="64" height="64"/><div><h1>N<span class="brand-a">a</span>AP</h1><small>${sub}</small></div>`;
  return h;
}

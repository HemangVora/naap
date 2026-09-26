/** Tiny DOM helpers. All dynamic text goes through esc() before hitting innerHTML. */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') n.className = String(v);
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'html') n.innerHTML = String(v);
    else n.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export const qs = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export function starsText(n: number) {
  const k = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(k) + '☆'.repeat(5 - k);
}

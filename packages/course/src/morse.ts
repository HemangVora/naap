// ITU Morse. Letters separated by one space, words by " / ". Used by the grok-morse barrier
// so the attacker's payee address is genuinely encoded (Grok × Bankrbot, May 2026).

const TABLE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....',
  '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.',
  ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-',
  '_': '..--.-', '"': '.-..-.', '$': '...-..-', '@': '.--.-.',
};
const REVERSE: Record<string, string> = Object.fromEntries(Object.entries(TABLE).map(([k, v]) => [v, k]));

/** Encode text to Morse. Unknown characters are dropped. Case-insensitive (Morse has no case). */
export function encodeMorse(text: string): string {
  return text
    .trim()
    .split(/\s+/)
    .map((word) =>
      Array.from(word.toUpperCase())
        .map((ch) => TABLE[ch])
        .filter((m): m is string => Boolean(m))
        .join(' '),
    )
    .filter((w) => w.length > 0)
    .join(' / ');
}

/** Decode Morse produced by encodeMorse (or any "/"-separated words). Output is upper-case. */
export function decodeMorse(morse: string): string {
  return morse
    .trim()
    .split(/\s*\/\s*/)
    .map((word) =>
      word
        .split(/\s+/)
        .map((code) => REVERSE[code] ?? '')
        .join(''),
    )
    .join(' ')
    .trim();
}

/** Loose test: does the text contain a run that looks like Morse? */
export function looksLikeMorse(text: string): boolean {
  return /(?:[.\-]{1,6}\s){4,}/.test(text);
}

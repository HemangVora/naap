import { describe, expect, it } from 'vitest';
import { skinFor } from './incidents.js';

describe('skinFor', () => {
  it('maps the payload channel of an attack to a preset scene', () => {
    expect(skinFor('attack', [{ kind: 'http402', source: 's', text: 't', payload: true }])).toBe('x402-swap');
    expect(skinFor('attack', [{ kind: 'tweet', source: 's', text: 'x' }, { kind: 'email', source: 's', text: 't', payload: true }])).toBe('freysa');
    expect(skinFor('attack', [{ kind: 'agent', source: 's', text: 't', payload: true }])).toBe('grok-morse');
    expect(skinFor('legit', [{ kind: 'http402', source: 's', text: 't' }])).toBe('legit');
  });
});

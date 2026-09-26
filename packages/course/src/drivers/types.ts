import type { CarDriver } from '@crumple/core';

/** A CarDriver that also says what it is and whether it is a stand-in (no key / no network). */
export interface CourseDriver extends CarDriver {
  readonly kind: 'claude' | 'webhook' | 'openai' | 'mcp' | 'gullible';
  /** true when a fake is standing in for a live integration — the UI must show "offline". */
  readonly offline: boolean;
}

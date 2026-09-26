// Stub: the world lane replaces this. Until then the world is the v2 arena.
export async function mountWorld(root: HTMLElement) {
  const { mountArena } = await import('../arena/index');
  mountArena(root);
}

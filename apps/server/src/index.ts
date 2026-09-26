import { buildApp } from './app.js';
import { createWiring } from './wire.js';

const wiring = await createWiring();
const app = await buildApp(wiring);
const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: '0.0.0.0' });
app.log.info({ integrations: wiring.integrations }, `crumple server on :${port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await wiring.close?.();
    process.exit(0);
  });
}

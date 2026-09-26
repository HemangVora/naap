import './styles.css';

const root = document.getElementById('app')!;
const path = location.pathname.replace(/\/+$/, '') || '/';

async function route() {
  if (path === '/') {
    const { mountLanding } = await import('./pages/landing');
    mountLanding(root);
  } else if (path === '/world') {
    const { mountWorld } = await import('./world/index');
    mountWorld(root);
  } else if (path === '/classic' || path === '/arena') {
    const { mountArena } = await import('./arena/index');
    mountArena(root);
  } else if (path === '/join') {
    const { mountJoin } = await import('./pages/join');
    mountJoin(root);
  } else if (path === '/tracks/new') {
    const { mountTrackBuilder } = await import('./pages/tracks');
    mountTrackBuilder(root);
  } else if (path.startsWith('/car/')) {
    const { mountCar } = await import('./pages/car');
    mountCar(root, decodeURIComponent(path.slice('/car/'.length)));
  } else {
    location.replace('/');
  }
}

route().catch((err) => {
  console.error(err);
  root.innerHTML = `<div class="fatal"><h1>Something broke</h1><pre>${String(err?.stack ?? err)}</pre></div>`;
});

import './styles.css';

const root = document.getElementById('app')!;
const path = location.pathname.replace(/\/+$/, '') || '/';

async function route() {
  if (path === '/join') {
    const { mountJoin } = await import('./pages/join');
    mountJoin(root);
  } else if (path.startsWith('/car/')) {
    const { mountCar } = await import('./pages/car');
    mountCar(root, decodeURIComponent(path.slice('/car/'.length)));
  } else {
    const { mountArena } = await import('./arena/index');
    mountArena(root);
  }
}

route().catch((err) => {
  console.error(err);
  root.innerHTML = `<div class="fatal"><h1>Something broke</h1><pre>${String(err?.stack ?? err)}</pre></div>`;
});

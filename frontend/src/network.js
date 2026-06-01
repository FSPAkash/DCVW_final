const RENDER_NO_SERVER = 'no-server';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRenderNoServer(response) {
  return response?.status === 404 && response.headers?.get('x-render-routing') === RENDER_NO_SERVER;
}

async function wakeRenderService() {
  try {
    await fetch('/', { cache: 'no-store' });
  } catch (_e) {
    // Best-effort wake-up only.
  }
}

export async function fetchWithRenderWake(input, init = {}, options = {}) {
  const retries = options.retries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 4000;

  let response = await fetch(input, init);
  if (!isRenderNoServer(response)) return response;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    await wakeRenderService();
    await sleep(baseDelayMs * (attempt + 1));
    response = await fetch(input, init);
    if (!isRenderNoServer(response)) return response;
  }

  return response;
}

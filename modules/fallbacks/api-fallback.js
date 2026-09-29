export const name = 'api-fallback';
export function fetchData() { return Promise.resolve({ ok: false, degraded: true }); }

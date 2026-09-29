const mods = globalThis.__APP_MODULES__ || {};
export const name = 'delta';
export const version = '1.0.0-full';
export function info() {
  return `delta(full) <- gamma: ${mods.gamma ? 'ok' : 'missing'}`;
}
export default { name, version, info };

const mods = globalThis.__APP_MODULES__ || {};
export const name = 'gamma';
export function summary() {
  return `gamma deps: ${['alpha', 'beta'].map((d) => mods[d] ? d + '✓' : d + '✗').join(', ')}`;
}
export default { name, summary };

const alpha = globalThis.__APP_MODULES__?.alpha;
export const name = 'beta';
export function describe() {
  return `beta <- ${alpha ? alpha.name : 'alpha(未加载)'}`;
}
export default { name, describe };

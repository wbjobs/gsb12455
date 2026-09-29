// delta 的降级版本：功能裁剪但接口兼容
export const name = 'delta';
export const version = '0.1.0-fallback';
export function info() {
  return 'delta(fallback) 精简版';
}
export default { name, version, info };

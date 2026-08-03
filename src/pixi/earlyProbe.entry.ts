/**
 * 独立入口：编译为 dist/pixi-probe.js，由 content 抢先注入页面主世界。
 */
import { EARLY_PIXI_PROBE_SOURCE } from './earlyProbeSource';

try {
  // eslint-disable-next-line no-new-func
  new Function(EARLY_PIXI_PROBE_SOURCE)();
} catch (e) {
  console.error('[Cocos Inspector] pixi-probe 执行失败', e);
}

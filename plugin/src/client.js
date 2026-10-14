/**
 * devflow 看板的 DSH 薄框 —— 客户端插件本体。
 *
 * 定位（必须守住，否则会变成"第二份看板实现"）：
 *   · 本插件**只做窗口**：一个 iframe 指向 devflow board 的本地服务；
 *   · 看板的全部渲染、数据、刷新逻辑仍在 `devflow board`（单一事实源）；
 *   · **删掉本插件不影响任何工作流能力** —— 它只是可选的呈现方式。
 *
 * 契约来源（全部核对过真实源码，见 ./README.md 的取证记录）：
 *   · 标签页类型：ctx.sidebarRightTabs.register({ id, kind, title, ... })
 *   · 标签页内容：ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Body))
 *   · 每次注册都包在 ctx.effect(...) 里，随插件生命周期销毁
 *
 * 刻意不写 JSX：用宿主注入的 React.createElement，减少编译需求（只需一层打包）。
 */
import { createElement as h } from 'react';

const BOARD_URL = 'http://127.0.0.1:8787';
const TAB_ID = 'devflow/board';

/** 看板面板：一个懒加载 iframe（不打开就不请求，避免无谓的等待） */
function BoardFrame() {
  return h('div', { style: { width: '100%', height: '100%', display: 'flex', flexDirection: 'column' } },
    h('iframe', {
      src: BOARD_URL,
      title: 'devflow 看板',
      style: { flex: '1 1 auto', width: '100%', border: '0', background: '#0f172a' },
      // 允许同源脚本即可；不给 allow-same-origin，避免内嵌页拿到 DSH 的源权限
      sandbox: 'allow-scripts allow-popups allow-forms',
      loading: 'lazy',
    }),
    h('div', {
      style: { padding: '6px 10px', fontSize: '11px', opacity: 0.7, borderTop: '1px solid rgba(128,128,128,.25)' },
    }, `看板地址：${BOARD_URL}　（未显示内容时，请在项目里运行 devflow board）`),
  );
}

/** Cordis 客户端插件入口 */
export default function devflowBoardPlugin(ctx) {
  // ① 注册标签页类型：一个"按 kind 打开"的页面型标签（不需要 patterns）
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'devflow-board',
    title: () => 'devflow 看板',
    // 页面型：没有 patterns，由 kind 打开
  }), 'devflow: board tab type');

  // ② 注册该标签页的内容
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
  }, BoardFrame)), 'devflow: board tab body');
}

export { BoardFrame };

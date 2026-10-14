// Client (browser) half — hand-written module-loader factory, no build step.
// Proves an out-of-tree package can contribute a `main` panel + a sidebar entry.
window.__ModuleLoader__.load({
  id: '@office/console-spike',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function ConsolePage() {
      return h('div', { style: { padding: 16, fontFamily: 'system-ui' } }, [
        h('h2', { key: 't', style: { margin: '0 0 8px' } }, 'Office Console Spike'),
        h('p', { key: 'b', style: { margin: 0, opacity: 0.7 } },
          '技能 / 专家 / 连接器 管理面板的最小占位（M2.0 验证）'),
      ]);
    }

    function ConsoleIcon() {
      return h('span', { style: { fontWeight: 600 } }, 'OC');
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'office-console-spike',
        }, ConsolePage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'office-console-spike',
          order: 99,
          label: () => 'Office 控制台',
        }, ConsoleIcon));
      },
    };
  },
});

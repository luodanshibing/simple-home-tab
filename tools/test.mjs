// Simple Home Tab —— 纯逻辑单测
//   运行：node tools/test.mjs
//   不依赖 Obsidian：把 require('obsidian') 换成一个最小桩件。
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

/* ---------- obsidian 桩件 ---------- */
class Plugin {}
class ItemView {}
class PluginSettingTab {}
class Setting {}
class TFile {}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') return { Plugin, ItemView, PluginSettingTab, Setting, TFile };
  return originalLoad.call(this, request, ...rest);
};

const SimpleHomePlugin = require('../main.js');
const T = SimpleHomePlugin.__test;

/* ---------- 极简断言 ---------- */
let pass = 0;
const fails = [];
const ok = (cond, label) => {
  if (cond) pass += 1;
  else fails.push(`✗ ${label}`);
};
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass += 1;
  else fails.push(`✗ ${label}\n    实际：${a}\n    期望：${b}`);
};

/* ---------- 1. 默认设置 ---------- */
eq(Object.keys(T.DEFAULT_SETTINGS).length, 20, '默认设置共 20 项');
for (const key of ['showBanner', 'showAvatar', 'showTitle', 'showGreeting', 'showClock', 'showSearch', 'showRecent']) {
  eq(T.DEFAULT_SETTINGS[key], true, `${key} 默认显示`);
}
eq(T.DEFAULT_SETTINGS.title, '我的工作台', '默认标题');
eq(T.DEFAULT_SETTINGS.bannerWidth, 'card', '题图默认与页面同宽');
eq(T.DEFAULT_SETTINGS.bannerHeight, 200, '题图默认高 200');

/* ---------- 2. normalizeSettings ---------- */
eq(T.normalizeSettings(null).title, '我的工作台', 'null 设置回退默认');
eq(T.normalizeSettings({ title: 'X' }).title, 'X', '已知键被接受');
eq('extra' in T.normalizeSettings({ extra: 1 }), false, '未知键被丢弃');
eq(T.normalizeSettings({ title: 'X' }).recentCount, 8, '缺的键补默认值');
eq(T.normalizeSettings({ showSearch: false }).showSearch, false, 'false 不会被默认值覆盖');

/* ---------- 3. clampNumber ---------- */
eq(T.clampNumber(500, 40, 800, 200), 500, '区间内原样');
eq(T.clampNumber(999, 0, 60, 0), 60, '超上限取上限');
eq(T.clampNumber(-5, 0, 40, 12), 0, '低于下限取下限');
eq(T.clampNumber('abc', 0, 60, 7), 7, '非数字回退默认');
eq(T.clampNumber('300', 0, 100, 0), 100, '数字字符串也认');

/* ---------- 4. greeting ---------- */
const at = (h) => new Date(2026, 0, 1, h, 0, 0);
eq(T.greeting(at(0)), '夜深了，注意休息', '0 点');
eq(T.greeting(at(5)), '夜深了，注意休息', '5 点');
eq(T.greeting(at(6)), '早上好', '6 点是边界 → 早上好');
eq(T.greeting(at(8)), '早上好', '8 点');
eq(T.greeting(at(9)), '上午好', '9 点是边界 → 上午好');
eq(T.greeting(at(11)), '上午好', '11 点');
eq(T.greeting(at(12)), '中午好', '12 点');
eq(T.greeting(at(13)), '中午好', '13 点');
eq(T.greeting(at(14)), '下午好', '14 点是边界 → 下午好');
eq(T.greeting(at(17)), '下午好', '17 点');
eq(T.greeting(at(18)), '晚上好', '18 点');
eq(T.greeting(at(23)), '晚上好', '23 点');

/* ---------- 5. formatClock / formatDate ---------- */
eq(T.formatClock(new Date(2026, 9, 10, 9, 5, 3)), '09:05:03', '时钟补零');
eq(T.formatClock(new Date(2026, 9, 10, 23, 45, 12)), '23:45:12', '时钟 23:45:12');
// 2026-01-01 是星期四
eq(T.formatDate(new Date(2026, 0, 1)), '2026年1月1日 星期四', '日期格式');
eq(T.formatDate(new Date(2026, 9, 10)), '2026年10月10日 星期六', '10 月 10 日');

/* ---------- 6. relTime ---------- */
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const ago = (ms) => NOW - ms;
eq(T.relTime(ago(30 * 1000), NOW), '刚刚', '30 秒 → 刚刚');
eq(T.relTime(ago(5 * 60000), NOW), '5 分钟前', '5 分钟');
eq(T.relTime(ago(59 * 60000), NOW), '59 分钟前', '59 分钟');
eq(T.relTime(ago(2 * 3600000), NOW), '2 小时前', '2 小时');
eq(T.relTime(ago(23 * 3600000), NOW), '23 小时前', '23 小时');
eq(T.relTime(ago(3 * 86400000), NOW), '3 天前', '3 天');
eq(T.relTime(ago(29 * 86400000), NOW), '29 天前', '29 天');
eq(T.relTime(ago(60 * 86400000), NOW), '2 个月前', '60 天 → 2 个月前');

/* ---------- 7. searchFiles / buildNameIndex ---------- */
const index = T.buildNameIndex([
  { basename: '库的git追踪规则', path: '1 Obsidian/Rules/库的git追踪规则.md' },
  { basename: '2026-10-10', path: '日记/2026-10-10.md' },
  { basename: 'README', path: 'README.md' },
]);
eq(index.length, 3, '索引条数');
eq(index[0].n, '库的git追踪规则'.toLowerCase(), '索引保存小写名称');
eq(index[0].p, '1 obsidian/rules/库的git追踪规则.md', '索引保存小写路径');
eq(T.searchFiles(index, 'readme').length, 1, '大小写不敏感');
eq(T.searchFiles(index, '日记').length, 1, '按路径命中');
eq(T.searchFiles(index, '不存在的串').length, 0, '未命中返回空');
eq(T.searchFiles(index, '   ').length, 0, '空白查询返回空');
eq(T.searchFiles(index, '2026').length, 1, '命中一个');
eq(T.searchFiles(index, '').length, 0, '空串返回空');
eq(T.searchFiles(index, 'a', 1).length, 1, 'limit 生效');
eq(T.searchFiles(null, 'a').length, 0, '索引为 null 不报错');
eq(T.buildNameIndex(null).length, 0, 'buildNameIndex(null) 返回空数组');

/* ---------- 8. resolveImageUrl ---------- */
class FakeTFile extends TFile {}
const fakeApp = {
  vault: {
    getAbstractFileByPath: (p) => (p === 'a.png' ? new FakeTFile() : null),
    getResourcePath: () => 'app://local/a.png',
  },
};
eq(T.resolveImageUrl(fakeApp, 'https://x/y.png'), 'https://x/y.png', '网络 URL 原样');
eq(T.resolveImageUrl(fakeApp, 'data:image/png;base64,AAA'), 'data:image/png;base64,AAA', 'data URL 原样');
eq(T.resolveImageUrl(fakeApp, '/abs/path.png'), '/abs/path.png', '绝对路径原样');
eq(T.resolveImageUrl(fakeApp, 'a.png'), 'app://local/a.png', 'vault 内路径解析');
eq(T.resolveImageUrl(fakeApp, 'missing.png'), null, 'vault 里没有 → null');
eq(T.resolveImageUrl(fakeApp, '   '), null, '空白 → null');
eq(T.resolveImageUrl(fakeApp, ''), null, '空串 → null');
eq(T.resolveImageUrl(fakeApp, '  https://x/y.png  '), 'https://x/y.png', '两端空白被裁掉');

/* ---------- 9. bannerVars / bannerClasses ---------- */
const vars = T.bannerVars(T.DEFAULT_SETTINGS);
eq(vars['--shb-height'], '200px', '默认高度');
eq(vars['--shb-radius'], '12px', '默认圆角');
eq(vars['--shb-gap'], '18px', '默认间距');
eq(vars['--shb-fit'], 'cover', '默认填充');
eq(vars['--shb-pos'], 'center', '默认对齐');
eq(vars['--shb-overlay'], '0', '默认无遮罩');

const odd = T.bannerVars({ bannerHeight: 9999, bannerRadius: -3, bannerGap: 'x', bannerOverlay: 500, bannerFit: 'contain', bannerPosition: 'bottom' });
eq(odd['--shb-height'], '800px', '高度超限被夹到 800');
eq(odd['--shb-radius'], '0px', '负圆角夹到 0');
eq(odd['--shb-gap'], '18px', '非数字间距回退 18');
eq(odd['--shb-overlay'], '0.7', '遮罩夹到 0.7');
eq(odd['--shb-fit'], 'contain', 'contain 透传');
eq(odd['--shb-pos'], 'bottom', 'bottom 透传');
eq(T.bannerVars({ bannerPosition: 'top' })['--shb-pos'], 'top', 'top 透传');
eq(T.bannerVars({ bannerOverlay: 40 })['--shb-overlay'], '0.4', '遮罩换算成 0–1');
eq(T.bannerVars({ bannerFit: '乱填' })['--shb-fit'], 'cover', '非法填充回退 cover');

eq(T.bannerClasses({}), [], '默认无附加 class');
eq(T.bannerClasses({ bannerWidth: 'full', bannerFlushTop: true, bannerShadow: true }), ['is-full', 'is-flush', 'has-shadow'], '三个 class 都加');
eq(T.bannerClasses({ bannerWidth: 'card' }), [], 'card 不加 is-full');
eq(T.bannerClasses({ bannerShadow: true }), ['has-shadow'], '只加 shadow');

/* ---------- 10. 导出的类 ---------- */
ok(typeof SimpleHomePlugin === 'function', '默认导出是插件类');
eq(SimpleHomePlugin.VIEW_TYPE, 'simple-home-view', '导出 VIEW_TYPE');

/* ---------- 汇总 ---------- */
if (fails.length === 0) {
  console.log(`\n通过 ${pass} 项，失败 0 项\n全部通过 ✓\n`);
} else {
  console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项\n`);
  for (const f of fails) console.log(f);
  process.exitCode = 1;
}

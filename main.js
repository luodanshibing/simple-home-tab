'use strict';

/* ==========================================================================
 * Simple Home Tab — 极简新标签页（v1.2.0）
 * --------------------------------------------------------------------------
 * 把空标签页换成一张首页：题图 / 日期时间 / 头像与名称 / 搜索 / 近期文档。
 *
 * 改代码前先读这四条设计红线：
 *   1. 启动零扫描   onload 不遍历 vault、不建索引。文件名索引只在【第一次搜索】时构建。
 *   2. 隐藏即不跑   任何模块被隐藏后，它对应的 DOM、定时器、索引都不创建。
 *   3. 主题自适应   所有颜色走 Obsidian 的 CSS 变量（见 styles.css），亮/暗自动跟随。
 *   4. 单文件无构建 main.js 既是源码也是产物 —— 直接改它，不需要打包。
 *
 * 文件结构：
 *   §1 常量与默认设置
 *   §2 纯函数（无副作用；tools/test.mjs 覆盖这部分）
 *   §3 SimpleHomePlugin  生命周期 / 视图注册 / 懒索引
 *   §4 HomeView          首页界面
 *   §5 HomeSettingTab    设置页
 *   §6 导出
 * ========================================================================== */

const { Plugin, ItemView, PluginSettingTab, Setting, TFile } = require('obsidian');

/* §1 常量与默认设置 ======================================================== */

const VIEW_TYPE = 'simple-home-view';
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const SEARCH_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 120;
const CLOCK_INTERVAL_MS = 1000;

const DEFAULT_SETTINGS = {
  /* 每个功能块的显示开关 */
  showBanner: true,
  showAvatar: true,
  showTitle: true,
  showGreeting: true,
  showClock: true,
  showSearch: true,
  showRecent: true,

  /* 页面头部 */
  title: '我的工作台',
  avatar: '',

  /* 近期文档 */
  recentCount: 8,

  /* 题图 */
  bannerPath: '',
  bannerWidth: 'card', // 'card' = 与页面同宽 | 'full' = 全宽
  bannerHeight: 200,
  bannerRadius: 12,
  bannerFit: 'cover', // 'cover' | 'contain'
  bannerPosition: 'center', // 'center' | 'top' | 'bottom'
  bannerOverlay: 0, // 0–70（百分比）
  bannerGap: 18,
  bannerShadow: false,
  bannerFlushTop: false,
};

/* §2 纯函数 =============================================================== */

/**
 * 合并设置：只接受 DEFAULT_SETTINGS 里已知的键。
 * 旧版 data.json 里的多余字段不会影响界面。
 */
function normalizeSettings(raw) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
  }
  return out;
}

/** 数字夹紧；非数字回退到默认值 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** 问候语（按当前小时） */
function greeting(date) {
  const d = date instanceof Date ? date : new Date();
  const h = d.getHours();
  if (h < 6) return '夜深了，注意休息';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/** HH:MM:SS（补零） */
function formatClock(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** YYYY年M月D日 星期X */
function formatDate(date) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 */
function relTime(ms, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const diff = now - Number(ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

/** 在文件名索引里搜索：大小写不敏感，命中文件名或路径 */
function searchFiles(index, query, limit) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q || !Array.isArray(index)) return [];
  const max = Number.isFinite(limit) ? limit : SEARCH_LIMIT;
  const out = [];
  for (const item of index) {
    if (!item) continue;
    if (item.n.includes(q) || item.p.includes(q)) {
      out.push(item);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** 把 vault 文件表转成搜索索引（小写文件名 + 小写路径） */
function buildNameIndex(files) {
  if (!Array.isArray(files)) return [];
  return files.map((f) => ({ n: String(f.basename).toLowerCase(), p: String(f.path).toLowerCase() }));
}

/**
 * 图片地址：网络 URL / data: / file: / 绝对路径 原样使用；
 * 其余按 vault 内路径解析成可渲染地址（不读文件内容，Obsidian 自己缓存）。
 */
function resolveImageUrl(app, src) {
  const value = String(src == null ? '' : src).trim();
  if (!value) return null;
  if (/^(https?:|data:|file:|\/)/i.test(value)) return value;
  const file = app && app.vault ? app.vault.getAbstractFileByPath(value) : null;
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  return null;
}

/** 题图的 CSS 变量值（纯函数，方便单测与调样式） */
function bannerVars(settings) {
  const s = settings || {};
  return {
    '--shb-height': `${clampNumber(s.bannerHeight, 40, 800, 200)}px`,
    '--shb-radius': `${clampNumber(s.bannerRadius, 0, 60, 0)}px`,
    '--shb-gap': `${clampNumber(s.bannerGap, 0, 80, 18)}px`,
    '--shb-fit': s.bannerFit === 'contain' ? 'contain' : 'cover',
    '--shb-pos': s.bannerPosition === 'top' ? 'top' : s.bannerPosition === 'bottom' ? 'bottom' : 'center',
    '--shb-overlay': String(clampNumber(s.bannerOverlay, 0, 70, 0) / 100),
  };
}

/** 题图的附加 class */
function bannerClasses(settings) {
  const s = settings || {};
  const out = [];
  if (s.bannerWidth === 'full') out.push('is-full');
  if (s.bannerFlushTop) out.push('is-flush');
  if (s.bannerShadow) out.push('has-shadow');
  return out;
}

/* §3 插件主体 ============================================================= */

class SimpleHomePlugin extends Plugin {
  constructor() {
    super(...arguments);
    /** 延迟构建的文件名索引（仅首次搜索时构建，之后缓存）。启动阶段完全不碰。 */
    this.nameIndex = null;
  }

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new HomeView(leaf, this));

    const replace = () => this.replaceEmptyLeaves();
    this.registerEvent(this.app.workspace.on('layout-change', replace));
    this.registerEvent(this.app.workspace.on('active-leaf-change', replace));

    const invalidate = () => {
      this.nameIndex = null;
    };
    this.registerEvent(this.app.vault.on('create', invalidate));
    this.registerEvent(this.app.vault.on('delete', invalidate));
    this.registerEvent(this.app.vault.on('rename', invalidate));

    this.addCommand({
      id: 'open-home',
      name: '打开首页',
      callback: () => this.openHome(),
    });

    this.addSettingTab(new HomeSettingTab(this.app, this));
    this.replaceEmptyLeaves();
  }

  onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      leaf.detach();
    }
  }

  /** 把所有空标签页换成首页 */
  replaceEmptyLeaves() {
    for (const leaf of this.app.workspace.getLeavesOfType('empty')) {
      leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
  }

  /** 命令：新开一个标签页并显示首页 */
  async openHome() {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** 懒构建文件名索引；搜索模块关闭时不会被调用 */
  ensureNameIndex() {
    if (!this.nameIndex) this.nameIndex = buildNameIndex(this.app.vault.getFiles());
    return this.nameIndex;
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 设置变更后刷新已打开的首页 */
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof HomeView) view.reload();
    }
  }
}

/* §4 首页视图 ============================================================= */

class HomeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.timer = null;
    this.dateEl = null;
    this.clockEl = null;
    this.avatarEl = null;
    this.searchInput = null;
    this.dropdownEl = null;
    this.recentEl = null;
    this.recentHeaderEl = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.plugin.settings.title || '首页';
  }

  getIcon() {
    return 'home';
  }

  async onOpen() {
    this.reload();
  }

  async onClose() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** 重建整个界面（onOpen 与设置变更都走这里） */
  reload() {
    this.contentEl.empty();
    this.buildUI();
    this.startClock();
    this.renderRecent();
  }

  /* ---------------- 组装界面 ---------------- */

  buildUI() {
    const s = this.plugin.settings;
    const root = this.contentEl.createDiv({ cls: 'simple-home simple-home-root' });

    if (s.showBanner) this.renderBanner(root);

    if (s.showClock) {
      const top = root.createDiv({ cls: 'simple-home-top' });
      this.dateEl = top.createDiv({ cls: 'simple-home-date' });
      this.clockEl = top.createDiv({ cls: 'simple-home-clock' });
    } else {
      this.dateEl = null;
      this.clockEl = null;
    }

    const card = root.createDiv({ cls: 'simple-home-card' });

    if (s.showAvatar) {
      this.avatarEl = card.createDiv({ cls: 'simple-home-avatar' });
      this.renderAvatar();
    } else {
      this.avatarEl = null;
    }

    if (s.showTitle) {
      card.createDiv({ cls: 'simple-home-title' }).textContent = s.title || '首页';
    }

    if (s.showGreeting) {
      card.createDiv({ cls: 'simple-home-greet' }).textContent = greeting(new Date());
    }

    if (s.showSearch) {
      const wrap = card.createDiv({ cls: 'simple-home-search' });
      this.searchInput = wrap.createEl('input', {
        cls: 'simple-home-search-input',
        attr: { type: 'text', placeholder: '搜索文件名…', spellcheck: 'false' },
      });
      this.dropdownEl = wrap.createDiv({ cls: 'simple-home-dropdown hidden' });
      this.wireSearch();
    } else {
      this.searchInput = null;
      this.dropdownEl = null;
    }

    if (s.showRecent) {
      this.recentHeaderEl = card.createDiv({ cls: 'simple-home-recent-header' });
      this.recentHeaderEl.textContent = '近期文档';
      this.recentEl = card.createDiv({ cls: 'simple-home-recent' });
    } else {
      this.recentHeaderEl = null;
      this.recentEl = null;
    }

    // 点卡片空白处收起搜索结果
    card.addEventListener('click', (e) => {
      if (e.target === card || e.target === this.recentEl || e.target === this.recentHeaderEl) {
        this.clearSearch();
      }
    });
  }

  /** 题图：一个 <img> + CSS 变量。不读文件、不扫描、不加定时器 */
  renderBanner(root) {
    const s = this.plugin.settings;
    const url = resolveImageUrl(this.app, s.bannerPath);
    if (!url) return; // 没填或找不到图 → 整个题图模块不产生 DOM

    const box = root.createDiv({ cls: 'simple-home-banner' });
    for (const cls of bannerClasses(s)) box.addClass(cls);
    const vars = bannerVars(s);
    for (const key of Object.keys(vars)) box.style.setProperty(key, vars[key]);

    box.createEl('img', { attr: { src: url, alt: '', decoding: 'async' } });
    if (clampNumber(s.bannerOverlay, 0, 70, 0) > 0) {
      box.createDiv({ cls: 'simple-home-banner-overlay' });
    }
  }

  /** 头像：填了图就显示图，否则显示标题首字 */
  renderAvatar() {
    if (!this.avatarEl) return;
    this.avatarEl.empty();
    const url = resolveImageUrl(this.app, this.plugin.settings.avatar);
    if (url) {
      this.avatarEl.createEl('img', { attr: { src: url, alt: 'avatar' } });
      return;
    }
    const initial = (this.plugin.settings.title || '首').trim().charAt(0);
    this.avatarEl.createDiv({ cls: 'simple-home-avatar-initial' }).textContent = initial;
  }

  /* ---------------- 时钟 ---------------- */

  startClock() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.clockEl || !this.dateEl) return; // 模块隐藏 → 不跑定时器

    const update = () => {
      const now = new Date();
      this.clockEl.textContent = formatClock(now);
      this.dateEl.textContent = formatDate(now);
    };
    update();
    this.timer = window.setInterval(update, CLOCK_INTERVAL_MS);
  }

  /* ---------------- 搜索 ---------------- */

  wireSearch() {
    let debounce = null;
    this.searchInput.addEventListener('input', () => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => this.doSearch(), SEARCH_DEBOUNCE_MS);
    });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.dropdownEl.querySelector('.simple-home-result-item');
        if (first) first.click();
      } else if (e.key === 'Escape') {
        this.clearSearch();
      }
    });
  }

  clearSearch() {
    if (!this.searchInput || !this.dropdownEl) return;
    this.searchInput.value = '';
    this.dropdownEl.empty();
    this.dropdownEl.addClass('hidden');
  }

  doSearch() {
    if (!this.searchInput || !this.dropdownEl) return;
    this.dropdownEl.empty();
    if (!this.searchInput.value.trim()) {
      this.dropdownEl.addClass('hidden');
      return;
    }
    const matches = searchFiles(this.plugin.ensureNameIndex(), this.searchInput.value, SEARCH_LIMIT);
    this.dropdownEl.removeClass('hidden');
    if (matches.length === 0) {
      this.dropdownEl.createDiv({ cls: 'simple-home-result-empty' }).textContent = '无匹配';
      return;
    }
    for (const m of matches) {
      const item = this.dropdownEl.createDiv({ cls: 'simple-home-result-item' });
      item.createDiv({ cls: 'simple-home-result-name' }).textContent = m.n;
      item.createDiv({ cls: 'simple-home-result-path' }).textContent = m.p;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.workspace.openLinkText(m.p, m.p, false);
        this.clearSearch();
      });
    }
  }

  /* ---------------- 近期文档 ---------------- */

  renderRecent() {
    if (!this.recentEl) return; // 模块隐藏
    this.recentEl.empty();
    const s = this.plugin.settings;
    let paths = this.app.workspace.getLastOpenFiles();

    if (!paths || paths.length === 0) {
      this.recentEl.createDiv({ cls: 'simple-home-recent-empty' }).textContent = '还没有打开过文档';
      return;
    }
    paths = paths.slice(0, clampNumber(s.recentCount, 1, 20, 8));

    const frag = document.createDocumentFragment();
    for (const p of paths) {
      const file = this.app.vault.getAbstractFileByPath(p);
      if (!(file instanceof TFile)) continue;

      const row = frag.createDiv({ cls: 'simple-home-recent-item' });
      const left = row.createDiv({ cls: 'simple-home-recent-main' });
      left.createDiv({ cls: 'simple-home-recent-name' }).textContent = file.basename;
      left.createDiv({ cls: 'simple-home-recent-dir' }).textContent = file.parent ? file.parent.path : '/';
      row.createDiv({ cls: 'simple-home-recent-time' }).textContent = relTime(file.stat.mtime);
      row.addEventListener('click', () => {
        this.app.workspace.openLinkText(file.path, file.path, false);
      });
    }
    this.recentEl.appendChild(frag);
  }
}

/* §5 设置页 =============================================================== */

class HomeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Simple Home Tab — 新标签页设置' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '轻量实现：启动零扫描，不拖慢 Obsidian。每个模块都能单独隐藏 —— 隐藏后对应的 DOM、定时器与索引都不会创建。',
    });

    /** 绑定一个设置项：写入 → 保存 → 刷新已打开的首页 */
    const bind = (key, cast) => async (value) => {
      s[key] = cast ? cast(value) : value;
      await p.saveSettings();
      p.refreshViews();
    };
    /** 一个显示/隐藏开关 */
    const toggleRow = (name, key, desc) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc || '')
        .addToggle((t) => t.setValue(!!s[key]).onChange(bind(key)));
    };

    /* ---------- 页面头部 ---------- */
    containerEl.createEl('h3', { text: '页面头部' });

    toggleRow('显示日期时间', 'showClock', '顶部的实时时钟。关闭后不再运行定时器');
    toggleRow('显示头像', 'showAvatar');
    new Setting(containerEl)
      .setName('头像')
      .setDesc('网络图片 URL，或 vault 内的图片相对路径（留空则显示标题首字）')
      .addText((t) =>
        t.setPlaceholder('https://… 或 图片路径').setValue(s.avatar).onChange(bind('avatar', (v) => v.trim()))
      );

    toggleRow('显示页面名称', 'showTitle');
    new Setting(containerEl)
      .setName('页面名称')
      .setDesc('首页顶部的自定义标题')
      .addText((t) => t.setPlaceholder('我的工作台').setValue(s.title).onChange(bind('title', (v) => v || '首页')));

    toggleRow('显示问候语', 'showGreeting', '按时间变化的问候语（早上好 / 夜深了…）');

    /* ---------- 题图 ---------- */
    containerEl.createEl('h3', { text: '题图' });

    toggleRow('显示题图', 'showBanner', '页面最上方的一张图；图片留空时同样不显示');
    new Setting(containerEl)
      .setName('题图图片')
      .setDesc('网络图片 URL，或 vault 内图片相对路径')
      .addText((t) =>
        t.setPlaceholder('https://… 或 图片路径').setValue(s.bannerPath).onChange(bind('bannerPath', (v) => v.trim()))
      );
    new Setting(containerEl)
      .setName('题图宽度')
      .setDesc('全宽 = 铺满整个视图；与页面同宽 = 和下方内容列对齐')
      .addDropdown((d) =>
        d
          .addOption('card', '与页面同宽')
          .addOption('full', '全宽')
          .setValue(s.bannerWidth)
          .onChange(bind('bannerWidth'))
      );
    new Setting(containerEl)
      .setName('题图高度')
      .setDesc('像素')
      .addSlider((sl) =>
        sl.setLimits(80, 600, 10).setValue(s.bannerHeight).setDynamicTooltip().onChange(bind('bannerHeight'))
      );
    new Setting(containerEl)
      .setName('圆角')
      .setDesc('像素；0 = 直角')
      .addSlider((sl) =>
        sl.setLimits(0, 40, 1).setValue(s.bannerRadius).setDynamicTooltip().onChange(bind('bannerRadius'))
      );
    new Setting(containerEl)
      .setName('图片填充')
      .setDesc('裁切铺满 = 不变形但会切边；完整显示 = 可能留白')
      .addDropdown((d) =>
        d
          .addOption('cover', '裁切铺满')
          .addOption('contain', '完整显示')
          .setValue(s.bannerFit)
          .onChange(bind('bannerFit'))
      );
    new Setting(containerEl)
      .setName('图片对齐')
      .setDesc('裁切时保留哪一部分')
      .addDropdown((d) =>
        d
          .addOption('center', '居中')
          .addOption('top', '顶部')
          .addOption('bottom', '底部')
          .setValue(s.bannerPosition)
          .onChange(bind('bannerPosition'))
      );
    new Setting(containerEl)
      .setName('压暗遮罩')
      .setDesc('0–70；浅色题图上要放文字时压暗一点更清楚')
      .addSlider((sl) =>
        sl.setLimits(0, 70, 1).setValue(s.bannerOverlay).setDynamicTooltip().onChange(bind('bannerOverlay'))
      );
    new Setting(containerEl)
      .setName('与下方内容的间距')
      .setDesc('像素')
      .addSlider((sl) =>
        sl.setLimits(0, 60, 2).setValue(s.bannerGap).setDynamicTooltip().onChange(bind('bannerGap'))
      );
    new Setting(containerEl)
      .setName('阴影')
      .addToggle((t) => t.setValue(!!s.bannerShadow).onChange(bind('bannerShadow')));
    new Setting(containerEl)
      .setName('顶到最上')
      .setDesc('配合「全宽」：去掉页面顶部留白，做成真正的通栏题图')
      .addToggle((t) => t.setValue(!!s.bannerFlushTop).onChange(bind('bannerFlushTop')));

    /* ---------- 搜索 ---------- */
    containerEl.createEl('h3', { text: '搜索' });

    toggleRow('显示搜索框', 'showSearch', '关闭后首页不显示搜索；文件名索引也不会被构建（更省）');

    /* ---------- 近期文档 ---------- */
    containerEl.createEl('h3', { text: '近期文档' });

    toggleRow('显示近期文档', 'showRecent');
    new Setting(containerEl)
      .setName('显示条数')
      .setDesc('1–20 条')
      .addSlider((sl) =>
        sl.setLimits(1, 20, 1).setValue(s.recentCount).setDynamicTooltip().onChange(bind('recentCount'))
      );

    /* ---------- 关于 ---------- */
    containerEl.createEl('h3', { text: '关于' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '本插件只读取文件名、路径、修改时间与「最近打开」列表，不修改任何笔记，也不联网。',
    });
  }
}

/* §6 导出 ================================================================= */

module.exports = SimpleHomePlugin;
module.exports.VIEW_TYPE = VIEW_TYPE;
module.exports.__test = {
  DEFAULT_SETTINGS,
  WEEKDAYS,
  SEARCH_LIMIT,
  normalizeSettings,
  clampNumber,
  greeting,
  formatClock,
  formatDate,
  relTime,
  searchFiles,
  buildNameIndex,
  resolveImageUrl,
  bannerVars,
  bannerClasses,
};

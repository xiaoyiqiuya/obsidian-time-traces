// ─── 时迹 · Time Traces ───
// Obsidian 插件 | 砂糖 2026-06-13
// 脚步计时 + 项目树 + 时间日志

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, Modal, Menu } = require('obsidian');

// ── 平台检测 ──
let _isMobile = null;
function isMobile(plugin) {
  if (_isMobile === null) {
    try { _isMobile = !!(plugin.app && plugin.app.isMobile); }
    catch(e) { _isMobile = false; }
  }
  return _isMobile;
}

// 跨 Vault 共享数据路径
// "shared" → ~/.time-is-gold/data.json（仅桌面端，Node.js fs）
// "vault"  → Vault 内 {dataFolder}/time-is-gold.json（全平台，Obsidian adapter API）
function getDataPath(plugin) {
  const loc = plugin.settings?.dataLocation || 'shared';
  if (loc === 'vault' || isMobile(plugin)) {
    const folder = plugin.settings?.dataFolder || '时迹数据';
    return { mode: 'vault', path: `${folder}/time-is-gold.json` };
  }
  return { mode: 'shared', path: '.time-is-gold/data.json' };
}

// ═══════════════════════════════════════════
//  常量与工具函数
// ═══════════════════════════════════════════

const VIEW_TYPE_MAIN = "time-is-gold-main-view";
const VIEW_TYPE_PROJECT_TREE = "time-is-gold-project-tree";
const VIEW_TYPE_STATS = "time-is-gold-stats-view";

const SITUATION_COLORS = {
  "生活": "#4CAF50",
  "学习": "#FFC107", 
  "运动": "#2196F3",
  "工作": "#9C27B0",
  "备课": "#FF9800",
  "娱乐": "#F44336",
  "默认": "#9E9E9E"
};

const DEFAULT_SETTINGS = {
  situationColors: SITUATION_COLORS,
  defaultSituation: "默认",
  showRibbonIcon: true,
  appendToDailyNote: false,
  dataLocation: "vault",  // "shared" = ~/.time-is-gold/  |  "vault" = Vault内同步
  dataFolder: "时迹数据"    // vault 模式下数据文件的存放文件夹
};

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 9);
}

function fmtDuration(minutes) {
  if (!minutes || minutes <= 0) return "0分钟";
  if (minutes < 60) return `${Math.round(minutes)}分钟`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch { return '--:--'; }
}

function fmtDate(iso) {
  try { return new Date(iso).toISOString().split('T')[0]; } catch { return ''; }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function nowISO() {
  return new Date().toISOString();
}

// 获取本周一的日期
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date.toISOString().split('T')[0];
}

// 获取本月1号
function getFirstOfMonth(d) {
  const date = new Date(d);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-01`;
}

// 日期加 N 天
function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

// 星期简称
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

// ═══════════════════════════════════════════
//  数据管理器
// ═══════════════════════════════════════════

class DataManager {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get data() { return this.plugin.data; }
  set data(v) { this.plugin.data = v; }

  // ── 项目操作 ──

  getProjects(includeArchived = false) {
    const projects = this.data.projects || [];
    return includeArchived ? projects : projects.filter(p => !p.archived);
  }

  getProject(id) {
    return (this.data.projects || []).find(p => p.id === id);
  }

  getProjectTree(parentId = null) {
    const projects = this.getProjects();
    return projects
      .filter(p => p.parentId === parentId)
      .map(p => ({
        ...p,
        children: this.getProjectTree(p.id),
        totalMinutes: this.getProjectTotalMinutes(p.id)
      }));
  }

  getProjectTotalMinutes(projectId) {
    // 本项目直接记录的时间
    const ownMinutes = (this.data.entries || [])
      .filter(e => e.projectId === projectId)
      .reduce((sum, e) => sum + (e.duration || 0), 0);
    // 子项目时间
    const children = (this.data.projects || []).filter(p => p.parentId === projectId);
    const childMinutes = children.reduce((sum, c) => sum + this.getProjectTotalMinutes(c.id), 0);
    return ownMinutes + childMinutes;
  }

  getProjectGoalProgress(projectId) {
    const project = this.getProject(projectId);
    if (!project || !project.goalHours || project.goalHours <= 0) return null;
    const totalMin = this.getProjectTotalMinutes(projectId);
    const goalMin = project.goalHours * 60;
    return Math.min(100, Math.round((totalMin / goalMin) * 100));
  }

  hasProjectNamed(name, parentId = null) {
    return (this.data.projects || []).some(p => 
      p.name === name && p.parentId === parentId && !p.archived
    );
  }

  async addProject(name, parentId = null, color = null, situation = null) {
    const projects = this.data.projects || [];
    // 同名警告（仍允许创建，调用方负责提示）
    const isDuplicate = this.hasProjectNamed(name, parentId);
    const project = {
      id: uid(),
      name,
      parentId,
      color: color || this.plugin.settings.situationColors[situation || this.plugin.settings.defaultSituation] || SITUATION_COLORS["默认"],
      situation: situation || this.plugin.settings.defaultSituation,
      goalHours: 0,
      archived: false,
      createdAt: nowISO(),
      sort: projects.length
    };
    projects.push(project);
    this.data.projects = projects;
    await this.plugin.saveData();
    return project;
  }

  async updateProject(id, updates) {
    const projects = this.data.projects || [];
    const idx = projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    projects[idx] = { ...projects[idx], ...updates };
    this.data.projects = projects;
    await this.plugin.saveData();
    return projects[idx];
  }

  async deleteProject(id) {
    // 删除项目及其所有子项目
    const idsToDelete = new Set([id]);
    const collectChildren = (pid) => {
      (this.data.projects || []).filter(p => p.parentId === pid).forEach(p => {
        idsToDelete.add(p.id);
        collectChildren(p.id);
      });
    };
    collectChildren(id);
    
    this.data.projects = (this.data.projects || []).filter(p => !idsToDelete.has(p.id));
    // 删除相关条目
    this.data.entries = (this.data.entries || []).filter(e => !idsToDelete.has(e.projectId));
    await this.plugin.saveData();
  }

  async archiveProject(id) {
    return this.updateProject(id, { archived: true });
  }

  // 获取最近使用的项目（按条目时间排序）
  getRecentProjects(limit = 5) {
    const entries = this.data.entries || [];
    const projectUsage = new Map();
    
    for (const e of entries) {
      if (!projectUsage.has(e.projectId)) {
        projectUsage.set(e.projectId, e.endTime || e.createdAt);
      }
    }
    
    // 排序：最近使用的在前
    const sorted = [...projectUsage.entries()]
      .sort((a, b) => new Date(b[1]) - new Date(a[1]))
      .slice(0, limit)
      .map(([pid]) => this.getProject(pid))
      .filter(Boolean);
    
    // 补足：加入还没用过的项目
    if (sorted.length < limit) {
      const usedIds = new Set(sorted.map(p => p.id));
      const unused = this.getProjects().filter(p => !usedIds.has(p.id)).slice(0, limit - sorted.length);
      sorted.push(...unused);
    }
    
    return sorted;
  }

  // ── 条目操作 ──

  async recordEntry(projectId, note = '') {
    const lastTime = this.data.lastRecordTime;
    const endTime = new Date();
    const startTime = lastTime ? new Date(lastTime) : new Date(endTime - 3600000); // 默认1小时前
    
    let duration = Math.round((endTime - startTime) / 60000);
    if (duration < 0) duration = 0;
    
    const entries = this.data.entries || [];
    
    // 检查上一条记录是否是同一个项目 → 合并而非新增
    let entry, isMerge = false;
    if (entries.length > 0) {
      const lastEntry = entries[entries.length - 1];
      if (lastEntry.projectId === projectId) {
        lastEntry.duration += duration;
        lastEntry.endTime = endTime.toISOString();
        if (note) lastEntry.note = (lastEntry.note ? lastEntry.note + '; ' : '') + note;
        entry = lastEntry;
        isMerge = true;
      }
    }
    
    if (!entry) {
      entry = {
        id: uid(),
        projectId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration,
        note,
        createdAt: nowISO()
      };
      entries.push(entry);
    }
    
    this.data.entries = entries;
    this.data.lastRecordTime = endTime.toISOString();
    
    await this.plugin.saveData();
    
    if (this.plugin.settings.appendToDailyNote && !isMerge) {
      await this.appendToDailyNote(entry);
    }
    
    return entry;
  }

  async appendToDailyNote(entry) {
    try {
      const project = this.getProject(entry.projectId);
      const dailyNotePath = `${today()}.md`;
      const file = this.plugin.app.vault.getAbstractFileByPath(dailyNotePath);
      const line = `- 🐾 ${fmtTime(entry.endTime)} ${project ? project.name : '(未知)'} — ${fmtDuration(entry.duration)}${entry.note ? ` _${entry.note}_` : ''}`;
      
      if (file) {
        await this.plugin.app.vault.append(file, `\n${line}`);
      } else {
        await this.plugin.app.vault.create(dailyNotePath, `# ${today()}\n\n## 时间日志\n${line}\n`);
      }
    } catch (e) {
      console.warn('时迹: 无法追加到日记', e);
    }
  }

  getTodayEntries() {
    const t = today();
    return (this.data.entries || []).filter(e => fmtDate(e.endTime) === t);
  }

  getEntriesByDate(date) {
    return (this.data.entries || []).filter(e => fmtDate(e.endTime) === date);
  }

  getAllEntriesSorted() {
    return [...(this.data.entries || [])].sort((a, b) => new Date(b.endTime) - new Date(a.endTime));
  }

  getLastRecordTime() {
    return this.data.lastRecordTime || null;
  }

  // 按日期分组的条目
  getEntriesByDay(days = 7) {
    const result = {};
    const entries = this.getAllEntriesSorted();
    for (const e of entries) {
      const d = fmtDate(e.endTime);
      if (!result[d]) result[d] = [];
      result[d].push(e);
    }
    return result;
  }
}

// ═══════════════════════════════════════════
//  快速记录弹窗
// ═══════════════════════════════════════════

class QuickRecordModal extends Modal {
  constructor(app, plugin, onSubmit) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('tig-modal');
    contentEl.createEl('h3', { text: '🐾 快速记录' });
    
    const dm = this.plugin.dataManager;
    const lastTime = dm.getLastRecordTime();
    
    if (lastTime) {
      const diff = Math.round((new Date() - new Date(lastTime)) / 60000);
      contentEl.createEl('p', { text: `距上次记录已过 ${fmtDuration(diff)}`, cls: 'tig-modal-hint' });
    }

    // 项目选择
    const projects = dm.getProjects();
    
    if (projects.length === 0) {
      contentEl.createEl('p', { text: '还没有项目，请先创建', cls: 'tig-empty' });
      const inputRow = contentEl.createDiv('tig-modal-row');
      const input = inputRow.createEl('input', { type: 'text', placeholder: '项目名称' });
      const btn = inputRow.createEl('button', { text: '创建并记录' });
      btn.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        const project = await dm.addProject(name);
        await dm.recordEntry(project.id);
        new Notice(`🐾 已记录: ${name} — ${fmtDuration(dm.getTodayEntries().slice(-1)[0]?.duration || 0)}`);
        if (this.onSubmit) this.onSubmit();
        this.close();
      });
      return;
    }

    // 最近使用的项目
    const recent = dm.getRecentProjects(5);
    const list = contentEl.createDiv('tig-modal-list');
    
    for (const p of recent) {
      const row = list.createDiv('tig-modal-item');
      const colorDot = row.createSpan('tig-color-dot');
      colorDot.style.backgroundColor = p.color || '#9E9E9E';
      
      const nameEl = row.createSpan({ text: p.name, cls: 'tig-modal-item-name' });
      const total = dm.getProjectTotalMinutes(p.id);
      const durEl = row.createSpan({ text: fmtDuration(total), cls: 'tig-modal-item-dur' });
      
      row.addEventListener('click', async () => {
        const entry = await dm.recordEntry(p.id);
        new Notice(`🐾 已记录: ${p.name} — ${fmtDuration(entry.duration)}`);
        if (this.onSubmit) this.onSubmit();
        this.close();
      });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ═══════════════════════════════════════════
//  项目编辑弹窗
// ═══════════════════════════════════════════

class ProjectEditModal extends Modal {
  constructor(app, plugin, project, onSaved) {
    super(app);
    this.plugin = plugin;
    this.project = project;
    this.onSaved = onSaved;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('tig-modal');
    contentEl.createEl('h3', { text: this.project ? '✏️ 编辑项目' : '🌱 新建项目' });

    // 名称
    const nameRow = contentEl.createDiv('tig-modal-row');
    nameRow.createEl('label', { text: '名称' });
    const nameInput = nameRow.createEl('input', { type: 'text', value: this.project?.name || '' });
    
    // 情境（颜色标签）
    const sitRow = contentEl.createDiv('tig-modal-row');
    sitRow.createEl('label', { text: '情境' });
    const sitSelect = sitRow.createEl('select');
    const situations = Object.keys(this.plugin.settings.situationColors);
    situations.forEach(s => {
      const opt = sitSelect.createEl('option', { text: s, value: s });
      if (this.project?.situation === s) opt.selected = true;
    });

    // 目标时长
    const goalRow = contentEl.createDiv('tig-modal-row');
    goalRow.createEl('label', { text: '目标(小时/天)' });
    const goalInput = goalRow.createEl('input', { 
      type: 'number', 
      value: String(this.project?.goalHours || 0),
      placeholder: '0 = 不设目标'
    });

    // 备注
    const noteRow = contentEl.createDiv('tig-modal-row');
    noteRow.createEl('label', { text: '备注' });
    const noteInput = noteRow.createEl('input', { 
      type: 'text', 
      value: this.project?.note || '',
      placeholder: '可选'
    });

    // 按钮
    const btnRow = contentEl.createDiv('tig-modal-buttons');
    
    const saveBtn = btnRow.createEl('button', { text: '💾 保存', cls: 'tig-btn-primary' });
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { new Notice('名称不能为空'); return; }
      
      const situation = sitSelect.value;
      const color = this.plugin.settings.situationColors[situation] || '#9E9E9E';
      
      if (this.project) {
        await this.plugin.dataManager.updateProject(this.project.id, {
          name, situation, color,
          goalHours: parseFloat(goalInput.value) || 0,
          note: noteInput.value.trim()
        });
      } else {
        if (this.plugin.dataManager.hasProjectNamed(name)) {
          new Notice(`⚠️ 已存在同名项目「${name}」`);
        }
        await this.plugin.dataManager.addProject(name, null, color, situation);
      }
      
      new Notice(this.project ? '项目已更新' : `✅ 项目「${name}」已创建`);
      if (this.onSaved) this.onSaved();
      this.close();
    });

    const cancelBtn = btnRow.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ═══════════════════════════════════════════
//  主视图：脚步计时 + 今日记录
// ═══════════════════════════════════════════

class TimeIsGoldMainView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = 'timer'; // 'timer' | 'tree' | 'stats'
    this.refreshTimer = null;
    this.expandedNodes = new Set(); // 项目树展开状态
  }

  getViewType() { return VIEW_TYPE_MAIN; }
  getDisplayText() { return "时迹"; }
  getIcon() { return "footprints"; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('tig-view');
    container.addClass('tig-tabbed-view');

    try {
      // 内容区域
      this.contentArea = container.createDiv('tig-tab-content');
      // 底部 Tab 栏
      this.buildTabBar(container);
      // 渲染默认面板
      this.renderPanel('timer');

      this.refreshTimer = setInterval(() => {
        if (this.activeTab === 'timer') this.updateStepTimer();
      }, 30000);
    } catch (e) {
      container.createEl('pre', { text: '时迹 加载错误:\n' + (e && e.message || String(e)) });
      console.error('时迹 onOpen error:', e);
    }
  }

  async onClose() {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  // ── 底部 Tab 栏 ──

  buildTabBar(container) {
    const bar = container.createDiv('tig-tabbar');
    const tabs = [
      { id: 'timer', icon: '🐾', label: '计时' },
      { id: 'tree',  icon: '🌳', label: '项目' },
      { id: 'stats', icon: '📊', label: '统计' }
    ];
    this._tabBtns = [];
    for (const t of tabs) {
      const btn = bar.createEl('button', {
        text: `${t.icon} ${t.label}`,
        cls: 'tig-tabbar-btn'
      });
      if (t.id === this.activeTab) btn.addClass('active');
      btn.addEventListener('click', () => this.renderPanel(t.id));
      this._tabBtns.push({ id: t.id, btn });
    }
  }

  _setActiveTab(tabId) {
    this.activeTab = tabId;
    for (const { id, btn } of (this._tabBtns || [])) {
      if (id === tabId) btn.addClass('active'); else btn.removeClass('active');
    }
  }

  renderPanel(tabId) {
    this._setActiveTab(tabId);
    this.contentArea.empty();
    if (tabId === 'timer') this.renderTimerPanel();
    else if (tabId === 'tree') this.renderTreePanel();
    else if (tabId === 'stats') this.renderStatsPanel();
  }

  // ═══ 计时面板 ═══

  renderTimerPanel() {
    this.buildStepTimer(this.contentArea);
    this.buildQuickActions(this.contentArea);
    this.buildTodayLog(this.contentArea);
    this.updateStepTimer();
  }

  // ═══ 项目树面板（复用 ProjectTreeView 逻辑）═══

  renderTreePanel() {
    const dm = this.plugin.dataManager;
    const container = this.contentArea;
    container.empty(); // 先清空，避免重复渲染

    const header = container.createDiv('tig-section-header');
    header.createEl('div', { text: '🌳 人生之树', cls: 'tig-section-title' });
    const addBtn = header.createEl('button', { text: '+ 新项目', cls: 'tig-btn tig-btn-sm' });
    addBtn.addEventListener('click', () => {
      new ProjectEditModal(this.app, this.plugin, null, () => this.renderTreePanel()).open();
    });

    const tree = dm.getProjectTree(null);
    if (tree.length === 0) {
      container.createEl('p', { text: '🌱 创建你的第一个项目吧', cls: 'tig-empty' });
      return;
    }
    this.treeEl = container.createDiv('tig-tree');
    for (const node of tree) {
      this._renderTreeNode(this.treeEl, node, 0);
    }
    container.createEl('p', { text: '💡 点击节点记录 | 右键/长按更多操作', cls: 'tig-context-hint' });
  }

  _renderTreeNode(parentEl, node, depth) {
    const dm = this.plugin.dataManager;
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = this.expandedNodes.has(node.id);

    const row = parentEl.createDiv('tig-tree-row');
    row.style.paddingLeft = `${depth * 16 + 6}px`;

    const toggle = row.createSpan('tig-tree-toggle');
    if (hasChildren) {
      toggle.setText(isExpanded ? '▼' : '▶');
      toggle.addClass('tig-tree-toggle-active');
    } else {
      toggle.setText('·'); toggle.style.opacity = '0.3';
    }

    const dot = row.createSpan('tig-dot');
    dot.style.backgroundColor = node.color || '#9E9E9E';

    row.createSpan({ text: node.name, cls: 'tig-tree-name' });
    row.createSpan({ text: fmtDuration(node.totalMinutes), cls: 'tig-tree-dur' });

    // 操作按钮
    const actions = row.createSpan('tig-tree-actions');
    const recBtn = actions.createEl('button', { text: '🐾', cls: 'tig-action-btn', attr: { title: '记录' } });
    recBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await dm.recordEntry(node.id);
      new Notice(`🐾 ${node.name}`);
      this.renderTreePanel();
    });
    const chBtn = actions.createEl('button', { text: '🌿', cls: 'tig-action-btn', attr: { title: '子项' } });
    chBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const child = await dm.addProject('新子项', node.id, node.color, node.situation);
      new ProjectEditModal(this.app, this.plugin, child, () => this.renderTreePanel()).open();
    });
    const edBtn = actions.createEl('button', { text: '✏️', cls: 'tig-action-btn', attr: { title: '编辑' } });
    edBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      new ProjectEditModal(this.app, this.plugin, node, () => this.renderTreePanel()).open();
    });

    // 点击：仅切换展开/折叠，不记录（通过按钮操作）
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tig-action-btn') || e.target.closest('.tig-tree-actions')) return;
      if (e.target === toggle || e.target.closest('.tig-tree-toggle')) {
        if (hasChildren) {
          if (isExpanded) this.expandedNodes.delete(node.id); else this.expandedNodes.add(node.id);
          this.renderTreePanel();
        }
      }
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showTreeMenu(node, e);
    });

    let lp = null;
    row.addEventListener('touchstart', (e) => {
      if (e.target.closest('.tig-action-btn')) return;
      lp = setTimeout(() => {
        const t = e.touches[0] || e.changedTouches[0];
        this._showTreeMenu(node, { x: t.clientX, y: t.clientY });
      }, 600);
    }, { passive: true });
    row.addEventListener('touchend', () => { if (lp) { clearTimeout(lp); lp = null; } });
    row.addEventListener('touchmove', () => { if (lp) { clearTimeout(lp); lp = null; } });

    if (hasChildren && isExpanded) {
      for (const child of node.children) this._renderTreeNode(parentEl, child, depth + 1);
    }
  }

  _showTreeMenu(node, event) {
    const dm = this.plugin.dataManager;
    const menu = new Menu();
    menu.addItem(item => item.setTitle('🐾 记录时间').setIcon('clock').onClick(async () => {
      await dm.recordEntry(node.id); new Notice(`已记录: ${node.name}`); this.renderTreePanel();
    }));
    menu.addItem(item => item.setTitle('🌿 添加子项目').setIcon('plus').onClick(async () => {
      const child = await dm.addProject('新子项', node.id, node.color, node.situation);
      new ProjectEditModal(this.app, this.plugin, child, () => this.renderTreePanel()).open();
    }));
    menu.addItem(item => item.setTitle('✏️ 编辑').setIcon('pencil').onClick(() => {
      new ProjectEditModal(this.app, this.plugin, node, () => this.renderTreePanel()).open();
    }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('🗑️ 删除').setIcon('trash').onClick(async () => {
      await dm.deleteProject(node.id); this.renderTreePanel(); new Notice(`已删除「${node.name}」`);
    }));
    menu.showAtMouseEvent(event);
  }

  // ═══ 统计面板（复用 StatisticsView 逻辑）═══

  renderStatsPanel() {
    const container = this.contentArea;
    container.empty(); // 先清空，避免重复渲染
    this._statsTab = this._statsTab || 'week';

    const tabBar = container.createDiv('tig-stats-tabs');
    const tabs = [
      { id: 'week', label: '📅 本周' },
      { id: 'month', label: '📆 本月' },
      { id: 'situation', label: '🎨 情境' }
    ];
    for (const t of tabs) {
      const btn = tabBar.createEl('button', { text: t.label, cls: 'tig-stats-tab' });
      if (this._statsTab === t.id) btn.addClass('active');
      btn.addEventListener('click', () => { this._statsTab = t.id; this.renderStatsPanel(); });
    }

    const area = container.createDiv('tig-stats-content');
    if (this._statsTab === 'week') this._renderWeekStats(area);
    else if (this._statsTab === 'month') this._renderMonthStats(area);
    else this._renderSituationStats(area);
  }

  _renderWeekStats(area) {
    const dm = this.plugin.dataManager;
    const monday = getMonday(new Date());
    const days = []; for (let i = 0; i < 7; i++) days.push(addDays(monday, i));
    const dailyTotals = days.map(d => {
      const e = (this.plugin.data.entries || []).filter(x => fmtDate(x.endTime) === d);
      return e.reduce((s, x) => s + (x.duration || 0), 0);
    });
    const maxMin = Math.max(...dailyTotals, 60);
    const chartH = 160, chartW = 280, padL = 32, padR = 8, padT = 8, padB = 20;
    const barW = Math.floor((chartW - padL - padR) / 7 - 6);

    area.createEl('h3', { text: '📅 本周每日时长', cls: 'tig-stats-title' });

    // 取 computed style 色值（SVG 内不支持 CSS 变量）
    const cs = getComputedStyle(document.body);
    const cGrid = cs.getPropertyValue('--background-modifier-border').trim() || '#444';
    const cMuted = cs.getPropertyValue('--text-muted').trim() || '#999';
    const cAccent = cs.getPropertyValue('--text-accent').trim() || '#7c3aed';
    const cBar = cs.getPropertyValue('--interactive-accent').trim() || '#555';

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${chartW} ${chartH}`);
    svg.setAttribute('width', '100%'); svg.setAttribute('height', String(chartH));
    svg.style.maxWidth = '380px';

    const barArea = chartH - padT - padB;
    for (let h = 0; h <= maxMin; h += Math.ceil(maxMin / 4)) {
      const y = padT + barArea * (1 - h / maxMin);
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(padL)); line.setAttribute('y1', y.toFixed(1));
      line.setAttribute('x2', String(chartW - padR)); line.setAttribute('y2', y.toFixed(1));
      line.setAttribute('stroke', cGrid); line.setAttribute('stroke-width', '0.5');
      svg.appendChild(line);
      const txt = document.createElementNS(NS, 'text');
      txt.setAttribute('x', String(padL - 4)); txt.setAttribute('y', (y + 4).toFixed(1));
      txt.setAttribute('text-anchor', 'end'); txt.setAttribute('font-size', '9');
      txt.setAttribute('fill', cMuted); txt.textContent = `${Math.round(h / 60)}h`;
      svg.appendChild(txt);
    }
    // 堆叠柱：每天按情境分色
    const stColors = this.plugin.settings.situationColors || SITUATION_COLORS;
    for (let i = 0; i < 7; i++) {
      const dayEntries = (this.plugin.data.entries || []).filter(x => fmtDate(x.endTime) === days[i]);
      // 按情境分组
      const sitMin = {};
      for (const e of dayEntries) {
        const p = dm.getProject(e.projectId);
        const sit = p?.situation || '默认';
        sitMin[sit] = (sitMin[sit] || 0) + (e.duration || 0);
      }
      const totalDay = Object.values(sitMin).reduce((a,b)=>a+b,0);
      const sortedSits = Object.entries(sitMin).sort((a,b)=>b[1]-a[1]);
      const x = padL + i * (barW + 6) + 3;
      const isToday = days[i] === today();

      // 从底部向上堆叠
      let stackY = padT + barArea;
      for (const [sit, mins] of sortedSits) {
        const segH = maxMin > 0 ? (mins / maxMin) * barArea : 0;
        if (segH < 1) continue;
        stackY -= segH;
        const color = stColors[sit] || stColors['默认'] || '#9E9E9E';
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(x)); rect.setAttribute('y', stackY.toFixed(1));
        rect.setAttribute('width', String(barW)); rect.setAttribute('height', segH.toFixed(1));
        rect.setAttribute('rx', '1'); rect.setAttribute('fill', color);
        rect.setAttribute('opacity', '0.85');
        svg.appendChild(rect);
      }

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', (x + barW / 2).toFixed(1));
      label.setAttribute('y', String(padT + barArea + 14));
      label.setAttribute('text-anchor', 'middle'); label.setAttribute('font-size', '9');
      label.setAttribute('fill', isToday ? cAccent : cMuted);
      label.setAttribute('font-weight', isToday ? '700' : '400');
      label.textContent = WEEKDAY_NAMES[new Date(days[i]).getDay()];
      svg.appendChild(label);
      if (totalDay > 0) {
        const val = document.createElementNS(NS, 'text');
        val.setAttribute('x', (x + barW / 2).toFixed(1));
        val.setAttribute('y', (stackY - 4).toFixed(1));
        val.setAttribute('text-anchor', 'middle'); val.setAttribute('font-size', '8');
        val.setAttribute('fill', isToday ? cAccent : cMuted);
        val.textContent = totalDay >= 60 ? `${Math.round(totalDay / 60)}h` : `${totalDay}m`;
        svg.appendChild(val);
      }
    }
    area.appendChild(svg);

    const total = dailyTotals.reduce((a,b)=>a+b,0);
    area.createEl('div', { text: `本周合计：${fmtDuration(total)}`, cls: 'tig-stats-summary' });
  }

  _renderMonthStats(area) {
    const dm = this.plugin.dataManager;
    const firstDay = getFirstOfMonth(new Date());
    const entries = (this.plugin.data.entries || []).filter(e => fmtDate(e.endTime) >= firstDay);
    const pm = {};
    for (const e of entries) {
      const p = dm.getProject(e.projectId); const k = p ? p.name : '(已删除)';
      pm[k] = (pm[k] || 0) + (e.duration || 0);
    }
    const totalMin = Object.values(pm).reduce((a,b)=>a+b,0);
    const sorted = Object.entries(pm).sort((a,b)=>b[1]-a[1]);
    const projects = dm.getProjects();
    const colors = sorted.map(([n]) => { const p = projects.find(pr => pr.name === n); return p?.color || '#9E9E9E'; });

    area.createEl('h3', { text: '📆 本月项目分布', cls: 'tig-stats-title' });
    if (totalMin === 0) { area.createEl('p', { text: '本月暂无记录', cls: 'tig-empty' }); return; }

    const cs = getComputedStyle(document.body);
    const cText = cs.getPropertyValue('--text-normal').trim() || '#ddd';
    const cMuted = cs.getPropertyValue('--text-muted').trim() || '#999';
    const NS = 'http://www.w3.org/2000/svg';
    const size = 180, cx = 90, cy = 90, r = 60, sw = 20;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
    svg.style.display = 'block'; svg.style.margin = '0 auto 12px';

    const circ = 2 * Math.PI * r;
    let off = 0;
    for (let i = 0; i < sorted.length; i++) {
      const frac = sorted[i][1] / totalMin;
      if (frac < 0.01) continue;
      const dl = frac * circ;
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', String(cx)); circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r)); circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', colors[i]); circle.setAttribute('stroke-width', String(sw));
      circle.setAttribute('stroke-dasharray', `${dl.toFixed(1)} ${(circ-dl).toFixed(1)}`);
      circle.setAttribute('stroke-dashoffset', (-off).toFixed(1));
      circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      circle.setAttribute('stroke-linecap', 'butt');
      svg.appendChild(circle);
      off += dl;
    }
    const th = totalMin >= 60 ? (totalMin/60).toFixed(1)+'h' : totalMin+'m';
    const t1 = document.createElementNS(NS, 'text');
    t1.setAttribute('x', String(cx)); t1.setAttribute('y', String(cy-6));
    t1.setAttribute('text-anchor', 'middle'); t1.setAttribute('font-size', '20');
    t1.setAttribute('font-weight', '700'); t1.setAttribute('fill', cText);
    t1.textContent = th; svg.appendChild(t1);
    const t2 = document.createElementNS(NS, 'text');
    t2.setAttribute('x', String(cx)); t2.setAttribute('y', String(cy+12));
    t2.setAttribute('text-anchor', 'middle'); t2.setAttribute('font-size', '10');
    t2.setAttribute('fill', cMuted); t2.textContent = '本月总计';
    svg.appendChild(t2);
    area.appendChild(svg);

    const list = area.createDiv('tig-donut-list');
    for (let i = 0; i < sorted.length; i++) {
      const [n, m] = sorted[i];
      const pct = Math.round((m/totalMin)*100);
      const item = list.createDiv('tig-donut-item');
      item.createSpan({ cls: 'tig-donut-dot', attr: { style: `background:${colors[i]}` } });
      item.createSpan({ text: n, cls: 'tig-donut-name' });
      item.createSpan({ text: `${fmtDuration(m)} (${pct}%)`, cls: 'tig-donut-val' });
    }
  }

  _renderSituationStats(area) {
    const dm = this.plugin.dataManager;
    const firstDay = getFirstOfMonth(new Date());
    const entries = (this.plugin.data.entries || []).filter(e => fmtDate(e.endTime) >= firstDay);
    const sm = {};
    for (const e of entries) {
      const p = dm.getProject(e.projectId); const sit = p?.situation || '默认';
      sm[sit] = (sm[sit] || 0) + (e.duration || 0);
    }
    const totalMin = Object.values(sm).reduce((a,b)=>a+b,0);
    const sorted = Object.entries(sm).sort((a,b)=>b[1]-a[1]);
    const stColors = this.plugin.settings.situationColors || SITUATION_COLORS;

    area.createEl('h3', { text: '🎨 本月情境分布', cls: 'tig-stats-title' });
    if (totalMin === 0) { area.createEl('p', { text: '本月暂无记录', cls: 'tig-empty' }); return; }

    const cs = getComputedStyle(document.body);
    const cText = cs.getPropertyValue('--text-normal').trim() || '#ddd';
    const cMuted = cs.getPropertyValue('--text-muted').trim() || '#999';
    const NS = 'http://www.w3.org/2000/svg';
    const size = 180, cx = 90, cy = 90, r = 60, sw = 20;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
    svg.style.display = 'block'; svg.style.margin = '0 auto 12px';

    const circ = 2 * Math.PI * r;
    let off = 0;
    for (let i = 0; i < sorted.length; i++) {
      const frac = sorted[i][1] / totalMin;
      if (frac < 0.01) continue;
      const dl = frac * circ;
      const color = stColors[sorted[i][0]] || stColors['默认'] || '#9E9E9E';
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', String(cx)); circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r)); circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color); circle.setAttribute('stroke-width', String(sw));
      circle.setAttribute('stroke-dasharray', `${dl.toFixed(1)} ${(circ-dl).toFixed(1)}`);
      circle.setAttribute('stroke-dashoffset', (-off).toFixed(1));
      circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      circle.setAttribute('stroke-linecap', 'butt');
      svg.appendChild(circle);
      off += dl;
    }
    const th = totalMin >= 60 ? (totalMin/60).toFixed(1)+'h' : totalMin+'m';
    const t1 = document.createElementNS(NS, 'text');
    t1.setAttribute('x', String(cx)); t1.setAttribute('y', String(cy-6));
    t1.setAttribute('text-anchor', 'middle'); t1.setAttribute('font-size', '20');
    t1.setAttribute('font-weight', '700'); t1.setAttribute('fill', cText);
    t1.textContent = th; svg.appendChild(t1);
    const t2 = document.createElementNS(NS, 'text');
    t2.setAttribute('x', String(cx)); t2.setAttribute('y', String(cy+12));
    t2.setAttribute('text-anchor', 'middle'); t2.setAttribute('font-size', '10');
    t2.setAttribute('fill', cMuted); t2.textContent = '本月总计';
    svg.appendChild(t2);
    area.appendChild(svg);

    const list = area.createDiv('tig-donut-list');
    for (let i = 0; i < sorted.length; i++) {
      const [n, m] = sorted[i];
      const pct = Math.round((m/totalMin)*100);
      const color = stColors[n] || stColors['默认'] || '#9E9E9E';
      const item = list.createDiv('tig-donut-item');
      item.createSpan({ cls: 'tig-donut-dot', attr: { style: `background:${color}` } });
      item.createSpan({ text: n, cls: 'tig-donut-name' });
      item.createSpan({ text: `${fmtDuration(m)} (${pct}%)`, cls: 'tig-donut-val' });
    }
  }

  buildStepTimer(container) {
    const section = container.createDiv('tig-section tig-timer');
    section.createEl('div', { text: '🐾 脚步计时', cls: 'tig-section-title' });

    const lastTime = this.plugin.dataManager.getLastRecordTime();
    this.timerEl = section.createDiv('tig-timer-display');
    this.updateStepTimer();

    // 手动记录按钮
    const btnRow = section.createDiv('tig-btn-row');
    const recordBtn = btnRow.createEl('button', {
      text: '📝 记录此刻',
      cls: 'tig-btn tig-btn-primary'
    });
    recordBtn.addEventListener('click', () => {
      new QuickRecordModal(this.app, this.plugin, () => {
        this.updateStepTimer();
        this.refreshTodayLog();
      }).open();
    });
  }

  updateStepTimer() {
    if (!this.timerEl) return;
    const lastTime = this.plugin.dataManager.getLastRecordTime();
    
    if (!lastTime) {
      this.timerEl.setText('🕐 等待第一次记录...');
      this.timerEl.removeClass('tig-timer-active');
      return;
    }

    const diff = Math.round((new Date() - new Date(lastTime)) / 60000);
    this.timerEl.addClass('tig-timer-active');
    
    if (diff < 1) {
      this.timerEl.setText('⏱ 刚刚记录过');
    } else if (diff < 60) {
      this.timerEl.setText(`⏱ ${diff} 分钟前`);
    } else if (diff < 1440) {
      const h = Math.floor(diff / 60);
      const m = diff % 60;
      this.timerEl.setText(`⏱ ${h}小时${m}分钟前`);
    } else {
      const d = Math.floor(diff / 1440);
      const h = Math.floor((diff % 1440) / 60);
      this.timerEl.setText(`⏱ ${d}天${h}小时前`);
    }
  }

  buildQuickActions(container) {
    const section = container.createDiv('tig-section');
    section.createEl('div', { text: '📌 快捷项目', cls: 'tig-section-title' });

    this.quickListEl = section.createDiv('tig-quick-list');
    this.refreshQuickList();

    // 新项目
    const newRow = section.createDiv('tig-new-row');
    const input = newRow.createEl('input', {
      type: 'text',
      placeholder: '新建项目...',
      cls: 'tig-input'
    });
    const addBtn = newRow.createEl('button', {
      text: '+',
      cls: 'tig-btn tig-btn-sm'
    });

    const doAdd = async () => {
      const name = input.value.trim();
      if (!name) return;
      const dm = this.plugin.dataManager;
      if (dm.hasProjectNamed(name)) {
        new Notice(`⚠️ 已存在同名项目「${name}」，仍已创建`);
      }
      await dm.addProject(name);
      input.value = '';
      this.refreshQuickList();
      new Notice(`✅ 项目「${name}」已创建`);
    };

    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doAdd();
    });
  }

  refreshQuickList() {
    if (!this.quickListEl) return;
    this.quickListEl.empty();

    const projects = this.plugin.dataManager.getRecentProjects(8);

    if (projects.length === 0) {
      this.quickListEl.createEl('p', { text: '还没有项目', cls: 'tig-empty' });
      return;
    }

    for (const p of projects) {
      const row = this.quickListEl.createDiv('tig-quick-item');
      
      // 颜色标记
      const dot = row.createSpan('tig-dot');
      dot.style.backgroundColor = p.color || '#9E9E9E';
      
      // 名称
      row.createSpan({ text: p.name, cls: 'tig-quick-name' });

      // 总时长
      const total = this.plugin.dataManager.getProjectTotalMinutes(p.id);
      row.createSpan({ text: fmtDuration(total), cls: 'tig-quick-dur' });

      // 点击记录
      row.addEventListener('click', async () => {
        const entry = await this.plugin.dataManager.recordEntry(p.id);
        new Notice(`🐾 已记录: ${p.name} — ${fmtDuration(entry.duration)}`);
        this.updateStepTimer();
        this.refreshTodayLog();
      });

      // 右键菜单
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showProjectContextMenu(e, p);
      });
    }
  }

  showProjectContextMenu(event, project) {
    const menu = new Menu();
    
    menu.addItem(item => item
      .setTitle('✏️ 编辑')
      .setIcon('pencil')
      .onClick(() => {
        new ProjectEditModal(this.app, this.plugin, project, () => {
          this.refreshQuickList();
          this.refreshTodayLog();
        }).open();
      })
    );

    menu.addItem(item => item
      .setTitle('🌿 添加子项目')
      .setIcon('plus')
      .onClick(async () => {
        // 简易子项目创建
        const dm = this.plugin.dataManager;
        const child = await dm.addProject(
          project.name + ' / 子项', 
          project.id, 
          project.color,
          project.situation
        );
        new ProjectEditModal(this.app, this.plugin, child, () => {
          this.refreshQuickList();
        }).open();
      })
    );

    menu.addSeparator();

    menu.addItem(item => item
      .setTitle('🗑️ 删除')
      .setIcon('trash')
      .onClick(async () => {
        await this.plugin.dataManager.deleteProject(project.id);
        this.refreshQuickList();
        this.refreshTodayLog();
        new Notice(`已删除项目「${project.name}」`);
      })
    );

    menu.showAtMouseEvent(event);
  }

  buildTodayLog(container) {
    const section = container.createDiv('tig-section');
    const headerRow = section.createDiv('tig-section-header');
    headerRow.createEl('div', { text: '📋 今日时间日志', cls: 'tig-section-title' });
    
    const addNoteBtn = headerRow.createEl('button', {
      text: '+ 手动记',
      cls: 'tig-btn tig-btn-sm'
    });
    addNoteBtn.addEventListener('click', () => {
      new QuickRecordModal(this.app, this.plugin, () => {
        this.refreshTodayLog();
      }).open();
    });

    this.logEl = section.createDiv('tig-log-list');
    this.refreshTodayLog();
  }

  refreshTodayLog() {
    if (!this.logEl) return;
    this.logEl.empty();

    const entries = this.plugin.dataManager.getTodayEntries().reverse();

    if (entries.length === 0) {
      this.logEl.createEl('p', { text: '今天还没有记录', cls: 'tig-empty' });
      return;
    }

    let totalDay = 0;
    for (const entry of entries) {
      totalDay += entry.duration || 0;
      const project = this.plugin.dataManager.getProject(entry.projectId);
      const row = this.logEl.createDiv('tig-log-row');

      // 时间
      const timeEl = row.createSpan('tig-log-time');
      timeEl.setText(fmtTime(entry.endTime));

      // 项目名（带颜色）
      const nameEl = row.createSpan('tig-log-name');
      nameEl.setText(project ? project.name : '(已删除)');
      if (project?.color) {
        nameEl.style.color = project.color;
        nameEl.style.fontWeight = '600';
      }

      // 时长
      const durEl = row.createSpan('tig-log-dur');
      durEl.setText(fmtDuration(entry.duration));

      // 删除按钮
      const delBtn = row.createSpan('tig-log-del');
      delBtn.setText('×');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const entries = this.plugin.data.entries || [];
        this.plugin.data.entries = entries.filter(e => e.id !== entry.id);
        await this.plugin.saveData();
        this.refreshTodayLog();
      });
    }

    // 今日总计
    const totalRow = this.logEl.createDiv('tig-log-total');
    totalRow.createSpan({ text: '今日总计' });
    totalRow.createSpan({ text: fmtDuration(totalDay), cls: 'tig-log-total-dur' });
  }
}

// ═══════════════════════════════════════════
//  项目树视图（独立侧边栏）
// ═══════════════════════════════════════════

class ProjectTreeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.expandedNodes = new Set();
  }

  getViewType() { return VIEW_TYPE_PROJECT_TREE; }
  getDisplayText() { return "人生之树"; }
  getIcon() { return "git-branch"; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('tig-view');
    container.addClass('tig-tree-view');

    try {
      const header = container.createDiv('tig-section-header');
      header.createEl('div', { text: '🌳 人生之树', cls: 'tig-section-title' });
      
      const addBtn = header.createEl('button', {
        text: '+ 新项目',
        cls: 'tig-btn tig-btn-sm'
      });
      addBtn.addEventListener('click', () => {
        new ProjectEditModal(this.app, this.plugin, null, () => this.refreshTree()).open();
      });

      this.treeEl = container.createDiv('tig-tree');
      this.refreshTree();
    } catch (e) {
      container.createEl('pre', { text: '时迹 树视图错误:\n' + (e && e.message || String(e)) });
      console.error(e);
    }
  }

  refreshTree() {
    if (!this.treeEl) return;
    this.treeEl.empty();

    const tree = this.plugin.dataManager.getProjectTree(null);

    if (tree.length === 0) {
      this.treeEl.createEl('p', { text: '🌱 创建你的第一个项目吧', cls: 'tig-empty' });
      return;
    }

    for (const node of tree) {
      this.renderTreeNode(this.treeEl, node, 0);
    }
  }

  // 弹出项目操作菜单（桌面右键 / iPad 长按共用）
  showNodeMenu(node, event) {
    const menu = new Menu();

    menu.addItem(item => item
      .setTitle('🐾 记录时间')
      .setIcon('clock')
      .onClick(async () => {
        const entry = await this.plugin.dataManager.recordEntry(node.id);
        new Notice(`已记录: ${node.name} — ${fmtDuration(entry.duration)}`);
        this.refreshTree();
      }));

    menu.addItem(item => item
      .setTitle('🌿 添加子项目')
      .setIcon('plus')
      .onClick(async () => {
        const child = await this.plugin.dataManager.addProject(
          '新子项', node.id, node.color, node.situation
        );
        new ProjectEditModal(this.app, this.plugin, child, () => this.refreshTree()).open();
      }));

    menu.addItem(item => item
      .setTitle('✏️ 编辑')
      .setIcon('pencil')
      .onClick(() => {
        new ProjectEditModal(this.app, this.plugin, node, () => this.refreshTree()).open();
      }));

    menu.addSeparator();

    menu.addItem(item => item
      .setTitle('🗑️ 删除')
      .setIcon('trash')
      .onClick(async () => {
        await this.plugin.dataManager.deleteProject(node.id);
        this.refreshTree();
        new Notice(`已删除「${node.name}」`);
      }));

    menu.showAtMouseEvent(event);
  }

  renderTreeNode(parentEl, node, depth) {
    const dm = this.plugin.dataManager;
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = this.expandedNodes.has(node.id);

    const row = parentEl.createDiv('tig-tree-row');
    row.style.paddingLeft = `${depth * 16 + 6}px`;

    // 展开/折叠
    const toggle = row.createSpan('tig-tree-toggle');
    if (hasChildren) {
      toggle.setText(isExpanded ? '▼' : '▶');
      toggle.addClass('tig-tree-toggle-active');
    } else {
      toggle.setText('·');
      toggle.style.opacity = '0.3';
    }

    // 颜色点
    const dot = row.createSpan('tig-dot');
    dot.style.backgroundColor = node.color || '#9E9E9E';

    // 名称
    const nameEl = row.createSpan('tig-tree-name');
    nameEl.setText(node.name);

    // 时长
    const durEl = row.createSpan('tig-tree-dur');
    durEl.setText(fmtDuration(node.totalMinutes));

    // ── 操作按钮（触屏友好，桌面也可见）──
    const actions = row.createSpan('tig-tree-actions');

    const recordBtn = actions.createEl('button', {
      text: '🐾',
      cls: 'tig-action-btn',
      attr: { title: '记录时间', 'aria-label': '记录时间' }
    });
    recordBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entry = await dm.recordEntry(node.id);
      new Notice(`🐾 ${node.name} — ${fmtDuration(entry.duration)}`);
      this.refreshTree();
    });

    const childBtn = actions.createEl('button', {
      text: '🌿',
      cls: 'tig-action-btn',
      attr: { title: '添加子项目', 'aria-label': '添加子项目' }
    });
    childBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const child = await dm.addProject('新子项', node.id, node.color, node.situation);
      new ProjectEditModal(this.app, this.plugin, child, () => this.refreshTree()).open();
    });

    const editBtn = actions.createEl('button', {
      text: '✏️',
      cls: 'tig-action-btn',
      attr: { title: '编辑', 'aria-label': '编辑' }
    });
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      new ProjectEditModal(this.app, this.plugin, node, () => this.refreshTree()).open();
    });

    // 进度条（在 action 按钮下面）
    const progress = dm.getProjectGoalProgress(node.id);
    if (progress !== null) {
      const progressRow = parentEl.createDiv('tig-tree-progress-row');
      progressRow.style.paddingLeft = `${depth * 16 + 28}px`;
      const bar = progressRow.createDiv('tig-progress-bar');
      bar.createSpan({
        cls: 'tig-progress-fill',
        attr: { style: `width:${progress}%` }
      });
      progressRow.createSpan({ text: ` ${progress}%`, cls: 'tig-progress-text' });
    }

    // ── 点击行：仅展开/折叠（记录通过按钮）──
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tig-action-btn') || e.target.closest('.tig-tree-actions')) return;
      if (e.target === toggle || e.target.closest('.tig-tree-toggle')) {
        if (hasChildren) {
          if (isExpanded) this.expandedNodes.delete(node.id);
          else this.expandedNodes.add(node.id);
          this.refreshTree();
        }
      }
    });

    // ── 右键菜单（桌面）──
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showNodeMenu(node, e);
    });

    // ── 长按菜单（iPad/触屏 fallback）──
    let longPressTimer = null;
    row.addEventListener('touchstart', (e) => {
      // 忽略在操作按钮上的触摸
      if (e.target.closest('.tig-action-btn')) return;
      longPressTimer = setTimeout(() => {
        // 用 touch 坐标模拟鼠标事件
        const touch = e.touches[0] || e.changedTouches[0];
        this.showNodeMenu(node, { x: touch.clientX, y: touch.clientY });
      }, 600);
    }, { passive: true });
    row.addEventListener('touchend', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });
    row.addEventListener('touchmove', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    // ── 递归渲染子节点 ──
    if (hasChildren && isExpanded) {
      for (const child of node.children) {
        this.renderTreeNode(parentEl, child, depth + 1);
      }
    }
  }
}

// ═══════════════════════════════════════════
//  统计视图（周/月/情境）
// ═══════════════════════════════════════════

class StatisticsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeTab = 'week';
  }

  getViewType() { return VIEW_TYPE_STATS; }
  getDisplayText() { return "时光统计"; }
  getIcon() { return "bar-chart-3"; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('tig-stats-view');

    try {
      this.buildTabs(container);
      this.contentEl = container.createDiv('tig-stats-content');
      this.renderActiveTab();
    } catch (e) {
      container.createEl('pre', { text: '时迹 统计视图错误:\n' + (e && e.message || String(e)) });
      console.error(e);
    }
  }

  buildTabs(container) {
    const tabBar = container.createDiv('tig-stats-tabs');
    const tabs = [
      { id: 'week', label: '📅 本周' },
      { id: 'month', label: '📆 本月' },
      { id: 'situation', label: '🎨 情境' }
    ];
    for (const t of tabs) {
      const btn = tabBar.createEl('button', { text: t.label, cls: 'tig-stats-tab' });
      if (this.activeTab === t.id) btn.addClass('active');
      btn.addEventListener('click', () => {
        this.activeTab = t.id;
        tabBar.querySelectorAll('.tig-stats-tab').forEach(b => b.removeClass('active'));
        btn.addClass('active');
        this.renderActiveTab();
      });
    }
  }

  renderActiveTab() {
    this.contentEl.empty();
    if (this.activeTab === 'week') this.renderWeekView();
    else if (this.activeTab === 'month') this.renderMonthView();
    else this.renderSituationView();
  }

  // ── 本周柱状图 ──

  renderWeekView() {
    const dm = this.plugin.dataManager;
    const monday = getMonday(new Date());
    const days = []; for (let i = 0; i < 7; i++) days.push(addDays(monday, i));
    const dailyTotals = days.map(d => {
      const entries = (this.plugin.data.entries || []).filter(e => fmtDate(e.endTime) === d);
      return entries.reduce((s, e) => s + (e.duration || 0), 0);
    });
    const maxMin = Math.max(...dailyTotals, 60);
    const chartH = 160, chartW = 280, padL = 32, padR = 8, padT = 8, padB = 20;
    const barW = Math.floor((chartW - padL - padR) / 7 - 6);
    this.contentEl.createEl('h3', { text: '📅 本周每日时长', cls: 'tig-stats-title' });

    const cs = getComputedStyle(document.body);
    const cGrid = cs.getPropertyValue('--background-modifier-border').trim() || '#444';
    const cMuted = cs.getPropertyValue('--text-muted').trim() || '#999';
    const cAccent = cs.getPropertyValue('--text-accent').trim() || '#7c3aed';
    const cBar = cs.getPropertyValue('--interactive-accent').trim() || '#555';

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${chartW} ${chartH}`);
    svg.setAttribute('width', '100%'); svg.setAttribute('height', String(chartH));
    svg.style.maxWidth = '380px';

    const barArea = chartH - padT - padB;
    for (let h = 0; h <= maxMin; h += Math.ceil(maxMin / 4)) {
      const y = padT + barArea * (1 - h / maxMin);
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(padL)); line.setAttribute('y1', y.toFixed(1));
      line.setAttribute('x2', String(chartW - padR)); line.setAttribute('y2', y.toFixed(1));
      line.setAttribute('stroke', cGrid); line.setAttribute('stroke-width', '0.5');
      svg.appendChild(line);
      const txt = document.createElementNS(NS, 'text');
      txt.setAttribute('x', String(padL - 4)); txt.setAttribute('y', (y + 4).toFixed(1));
      txt.setAttribute('text-anchor', 'end'); txt.setAttribute('font-size', '9');
      txt.setAttribute('fill', cMuted); txt.textContent = `${Math.round(h / 60)}h`;
      svg.appendChild(txt);
    }
    for (let i = 0; i < 7; i++) {
      const h = maxMin > 0 ? (dailyTotals[i] / maxMin) * barArea : 0;
      const x = padL + i * (barW + 6) + 3, y = padT + barArea - h;
      const isToday = days[i] === today();
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(x)); rect.setAttribute('y', y.toFixed(1));
      rect.setAttribute('width', String(barW)); rect.setAttribute('height', Math.max(h, 1).toFixed(1));
      rect.setAttribute('rx', '2');
      rect.setAttribute('fill', isToday ? cAccent : cBar);
      rect.setAttribute('opacity', isToday ? '1' : '0.65');
      svg.appendChild(rect);
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', (x + barW / 2).toFixed(1));
      label.setAttribute('y', String(padT + barArea + 14));
      label.setAttribute('text-anchor', 'middle'); label.setAttribute('font-size', '9');
      label.setAttribute('fill', isToday ? cAccent : cMuted);
      label.setAttribute('font-weight', isToday ? '700' : '400');
      label.textContent = WEEKDAY_NAMES[new Date(days[i]).getDay()]; svg.appendChild(label);
      if (dailyTotals[i] > 0) {
        const val = document.createElementNS(NS, 'text');
        val.setAttribute('x', (x + barW / 2).toFixed(1));
        val.setAttribute('y', (y - 4).toFixed(1));
        val.setAttribute('text-anchor', 'middle'); val.setAttribute('font-size', '8');
        val.setAttribute('fill', cMuted);
        val.textContent = dailyTotals[i] >= 60 ? `${Math.round(dailyTotals[i] / 60)}h` : `${dailyTotals[i]}m`;
        svg.appendChild(val);
      }
    }
    this.contentEl.appendChild(svg);

    const weekTotal = dailyTotals.reduce((a, b) => a + b, 0);
    this.contentEl.createEl('div', { text: `本周合计：${fmtDuration(weekTotal)}`, cls: 'tig-stats-summary' });
    this.renderWeekTable(days, dailyTotals, dm);
  }

  renderWeekTable(days, dailyTotals, dm) {
    const table = this.contentEl.createEl('table', 'tig-stats-table');
    const hr = table.createEl('thead').createEl('tr');
    hr.createEl('th', { text: '日期' }); hr.createEl('th', { text: '时长' }); hr.createEl('th', { text: '项目' });
    const tbody = table.createEl('tbody');
    for (let i = 0; i < 7; i++) {
      if (dailyTotals[i] === 0) continue;
      const row = tbody.createEl('tr');
      const d = new Date(days[i]);
      row.createEl('td', { text: `${d.getMonth() + 1}/${d.getDate()} 周${WEEKDAY_NAMES[d.getDay()]}` });
      row.createEl('td', { text: fmtDuration(dailyTotals[i]) });
      const entries = (this.plugin.data.entries || []).filter(e => fmtDate(e.endTime) === days[i]);
      const pn = [...new Set(entries.map(e => { const p = dm.getProject(e.projectId); return p ? p.name : '?'; }))].join('、');
      row.createEl('td', { text: pn || '-' });
    }
  }

  // ── 本月环形图 ──

  renderMonthView() {
    const dm = this.plugin.dataManager;
    const firstDay = getFirstOfMonth(new Date());
    const entries = (this.plugin.data.entries || []).filter(e => fmtDate(e.endTime) >= firstDay);
    const pm = {};
    for (const e of entries) {
      const p = dm.getProject(e.projectId); const k = p ? p.name : '(已删除)';
      pm[k] = (pm[k] || 0) + (e.duration || 0);
    }
    const totalMin = Object.values(pm).reduce((a,b)=>a+b,0);
    const sorted = Object.entries(pm).sort((a,b)=>b[1]-a[1]);
    const projects = dm.getProjects();
    const colors = sorted.map(([n]) => { const p = projects.find(pr => pr.name === n); return p?.color || '#9E9E9E'; });
    this.contentEl.createEl('h3', { text: '📆 本月项目分布', cls: 'tig-stats-title' });
    if (totalMin === 0) { this.contentEl.createEl('p', { text: '本月暂无记录', cls: 'tig-empty' }); return; }

    const cs = getComputedStyle(document.body);
    const cText = cs.getPropertyValue('--text-normal').trim() || '#ddd';
    const cMuted = cs.getPropertyValue('--text-muted').trim() || '#999';
    const NS = 'http://www.w3.org/2000/svg';
    const size = 180, cx = 90, cy = 90, r = 60, sw = 20;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
    svg.style.display = 'block'; svg.style.margin = '0 auto 12px';

    const circ = 2 * Math.PI * r;
    let off = 0;
    for (let i = 0; i < sorted.length; i++) {
      const frac = sorted[i][1] / totalMin;
      if (frac < 0.01) continue;
      const dl = frac * circ;
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', String(cx)); circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r)); circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', colors[i]); circle.setAttribute('stroke-width', String(sw));
      circle.setAttribute('stroke-dasharray', `${dl.toFixed(1)} ${(circ-dl).toFixed(1)}`);
      circle.setAttribute('stroke-dashoffset', (-off).toFixed(1));
      circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      circle.setAttribute('stroke-linecap', 'butt');
      svg.appendChild(circle);
      off += dl;
    }
    const th = totalMin >= 60 ? (totalMin/60).toFixed(1)+'h' : totalMin+'m';
    const t1 = document.createElementNS(NS, 'text');
    t1.setAttribute('x', String(cx)); t1.setAttribute('y', String(cy-6));
    t1.setAttribute('text-anchor', 'middle'); t1.setAttribute('font-size', '20');
    t1.setAttribute('font-weight', '700'); t1.setAttribute('fill', cText);
    t1.textContent = th; svg.appendChild(t1);
    const t2 = document.createElementNS(NS, 'text');
    t2.setAttribute('x', String(cx)); t2.setAttribute('y', String(cy+12));
    t2.setAttribute('text-anchor', 'middle'); t2.setAttribute('font-size', '10');
    t2.setAttribute('fill', cMuted); t2.textContent = '本月总计';
    svg.appendChild(t2);
    this.contentEl.appendChild(svg);

    const list = this.contentEl.createDiv('tig-donut-list');
    for (let i = 0; i < sorted.length; i++) {
      const [n, m] = sorted[i];
      const pct = Math.round((m/totalMin)*100);
      const item = list.createDiv('tig-donut-item');
      item.createSpan({ cls: 'tig-donut-dot', attr: { style: `background:${colors[i]}` } });
      item.createSpan({ text: n, cls: 'tig-donut-name' });
      item.createSpan({ text: `${fmtDuration(m)} (${pct}%)`, cls: 'tig-donut-val' });
    }
  }

  // ── 情境分布 ──

  renderSituationView() {
    const dm = this.plugin.dataManager;
    const firstDay = getFirstOfMonth(new Date());
    const entries = (this.plugin.data.entries || []).filter(e => fmtDate(e.endTime) >= firstDay);
    const sm = {};
    for (const e of entries) {
      const p = dm.getProject(e.projectId); const sit = p?.situation || '默认';
      sm[sit] = (sm[sit] || 0) + (e.duration || 0);
    }
    const totalMin = Object.values(sm).reduce((a,b)=>a+b,0);
    const sorted = Object.entries(sm).sort((a,b)=>b[1]-a[1]);
    const stColors = this.plugin.settings.situationColors || SITUATION_COLORS;
    this.contentEl.createEl('h3', { text: '🎨 本月情境分布', cls: 'tig-stats-title' });
    if (totalMin === 0) { this.contentEl.createEl('p', { text: '本月暂无记录', cls: 'tig-empty' }); return; }

    const cs = getComputedStyle(document.body);
    const cText = cs.getPropertyValue('--text-normal').trim() || '#ddd';
    const cMuted = cs.getPropertyValue('--text-muted').trim() || '#999';
    const NS = 'http://www.w3.org/2000/svg';
    const size = 180, cx = 90, cy = 90, r = 60, sw = 20;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
    svg.style.display = 'block'; svg.style.margin = '0 auto 12px';

    const circ = 2 * Math.PI * r;
    let off = 0;
    for (let i = 0; i < sorted.length; i++) {
      const frac = sorted[i][1] / totalMin;
      if (frac < 0.01) continue;
      const dl = frac * circ;
      const color = stColors[sorted[i][0]] || stColors['默认'] || '#9E9E9E';
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', String(cx)); circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r)); circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color); circle.setAttribute('stroke-width', String(sw));
      circle.setAttribute('stroke-dasharray', `${dl.toFixed(1)} ${(circ-dl).toFixed(1)}`);
      circle.setAttribute('stroke-dashoffset', (-off).toFixed(1));
      circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      circle.setAttribute('stroke-linecap', 'butt');
      svg.appendChild(circle);
      off += dl;
    }
    const th = totalMin >= 60 ? (totalMin/60).toFixed(1)+'h' : totalMin+'m';
    const t1 = document.createElementNS(NS, 'text');
    t1.setAttribute('x', String(cx)); t1.setAttribute('y', String(cy-6));
    t1.setAttribute('text-anchor', 'middle'); t1.setAttribute('font-size', '20');
    t1.setAttribute('font-weight', '700'); t1.setAttribute('fill', cText);
    t1.textContent = th; svg.appendChild(t1);
    const t2 = document.createElementNS(NS, 'text');
    t2.setAttribute('x', String(cx)); t2.setAttribute('y', String(cy+12));
    t2.setAttribute('text-anchor', 'middle'); t2.setAttribute('font-size', '10');
    t2.setAttribute('fill', cMuted); t2.textContent = '本月总计';
    svg.appendChild(t2);
    this.contentEl.appendChild(svg);

    const list = this.contentEl.createDiv('tig-donut-list');
    for (let i = 0; i < sorted.length; i++) {
      const [n, m] = sorted[i];
      const pct = Math.round((m/totalMin)*100);
      const color = stColors[n] || stColors['默认'] || '#9E9E9E';
      const item = list.createDiv('tig-donut-item');
      item.createSpan({ cls: 'tig-donut-dot', attr: { style: `background:${color}` } });
      item.createSpan({ text: n, cls: 'tig-donut-name' });
      item.createSpan({ text: `${fmtDuration(m)} (${pct}%)`, cls: 'tig-donut-val' });
    }
  }
}

// ═══════════════════════════════════════════
//  设置页
// ═══════════════════════════════════════════

class TimeIsGoldSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('tig-settings');

    containerEl.createEl('h2', { text: '🐾 时迹 设置' });

    // 基本设置
    containerEl.createEl('h3', { text: '基本' });

    new Setting(containerEl)
      .setName('显示侧边栏图标')
      .setDesc('在左侧边栏显示脚印图标')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showRibbonIcon)
        .onChange(async (value) => {
          this.plugin.settings.showRibbonIcon = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('追加到每日笔记')
      .setDesc('记录时间时自动追加一行到今日笔记')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.appendToDailyNote || false)
        .onChange(async (value) => {
          this.plugin.settings.appendToDailyNote = value;
          await this.plugin.saveSettings();
        }));

    // ── 数据同步设置 ──
    containerEl.createEl('h3', { text: '🔄 数据同步' });

    new Setting(containerEl)
      .setName('数据存储位置')
      .setDesc('「Vault 内」可被 remotely-save 跨设备同步；「系统目录」仅桌面端本地。')
      .addDropdown(dropdown => dropdown
        .addOption('shared', '系统目录 (~/.time-is-gold/)')
        .addOption('vault', 'Vault 内')
        .setValue(this.plugin.settings.dataLocation || 'shared')
        .onChange(async (value) => {
          const old = this.plugin.settings.dataLocation;
          this.plugin.settings.dataLocation = value;
          await this.plugin.saveSettings();
          if (old !== value) {
            await this.plugin.loadSharedData();
            this.plugin.refreshAllViews();
            new Notice(`✅ 数据已切换到: ${value === 'vault' ? 'Vault 内同步' : '系统目录'}`);
          }
        }));

    this._buildFolderSetting(containerEl);
  }

  async _buildFolderSetting(containerEl) {
    const current = this.plugin.settings.dataFolder || '时迹数据';

    // 收集一级文件夹
    const topFolders = new Set(['时迹数据']);
    try {
      const entries = await this.app.vault.adapter.list('/');
      for (const e of entries) {
        const name = e.replace(/\/$/, '');
        if (name && !name.startsWith('.') && e.endsWith('/')) topFolders.add(name);
      }
    } catch(e) { /* 忽略 */ }
    // 当前值如果是一级文件夹也加入列表
    if (current && !current.includes('/')) topFolders.add(current);

    const migrate = async (folder) => {
      const old = this.plugin.settings.dataFolder;
      this.plugin.settings.dataFolder = folder;
      await this.plugin.saveSettings();
      if (old !== folder) {
        await this.plugin.loadSharedData();
        this.plugin.refreshAllViews();
        new Notice(`✅ 数据已迁移到「${folder}/」`);
      }
    };

    // 自定义路径（置顶，支持深层路径如「考研/自律」）
    new Setting(containerEl)
      .setName('数据文件夹')
      .setDesc('自定义路径，如「考研/自律」。数据存为 路径/time-is-gold.json')
      .addText(text => text
        .setPlaceholder('时迹数据')
        .setValue(current)
        .onChange(async (value) => {
          const folder = value.trim();
          if (!folder) return;
          await migrate(folder);
        }));

    // 快捷选择（一级文件夹下拉）
    const sorted = [...topFolders].sort();
    const isTopLevel = current && !current.includes('/') && topFolders.has(current);

    new Setting(containerEl)
      .setName('快捷选择')
      .setDesc('从 Vault 一级文件夹中选一个')
      .addDropdown(dropdown => {
        if (!isTopLevel) dropdown.addOption('', '— 当前为深层路径 —');
        for (const f of sorted) {
          dropdown.addOption(f, f);
        }
        dropdown.setValue(isTopLevel ? current : '');
        dropdown.onChange(async (value) => {
          if (!value) return;
          await migrate(value);
        });
        return dropdown;
      });

    // 情境颜色设置
    containerEl.createEl('h3', { text: '🎨 情境颜色' });
    containerEl.createEl('p', { text: '自定义各情境的显示颜色', cls: 'setting-item-description' });

    const colors = this.plugin.settings.situationColors || SITUATION_COLORS;

    for (const [name, color] of Object.entries(colors)) {
      new Setting(containerEl)
        .setName(name)
        .addColorPicker(picker => picker
          .setValue(color)
          .onChange(async (value) => {
            this.plugin.settings.situationColors[name] = value;
            await this.plugin.saveSettings();
          }));
    }

    // 数据管理
    containerEl.createEl('h3', { text: '💾 数据管理' });

    new Setting(containerEl)
      .setName('导出数据')
      .setDesc('将所有记录导出为 JSON 文件')
      .addButton(btn => btn
        .setButtonText('导出 JSON')
        .onClick(() => {
          const data = JSON.stringify(this.plugin.data, null, 2);
          const blob = new Blob([data], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `时迹-备份-${today()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          new Notice('✅ 数据已导出');
        }));

    new Setting(containerEl)
      .setName('导入数据')
      .setDesc('从 JSON 文件导入数据（会覆盖当前数据）⚠️')
      .addButton(btn => btn
        .setButtonText('选择文件')
        .setWarning()
        .onClick(() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json';
          input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
              const text = await file.text();
              const data = JSON.parse(text);
              if (!data.projects || !data.entries) {
                new Notice('❌ 无效的备份文件');
                return;
              }
              this.plugin.data = data;
              await this.plugin.saveData();
              new Notice('✅ 数据已导入，请重载插件');
            } catch (err) {
              new Notice('❌ 导入失败: ' + err.message);
            }
          };
          input.click();
        }));

    new Setting(containerEl)
      .setName('清除所有数据')
      .setDesc('删除所有项目和记录，不可恢复！')
      .addButton(btn => btn
        .setButtonText('清除')
        .setWarning()
        .onClick(async () => {
          if (confirm('确定要删除所有数据吗？此操作不可恢复！')) {
            this.plugin.data = { projects: [], entries: [], lastRecordTime: null };
            await this.plugin.saveData();
            new Notice('🗑️ 所有数据已清除');
          }
        }));
  }
}

// ═══════════════════════════════════════════
//  主插件类
// ═══════════════════════════════════════════

class TimeIsGoldPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.dataManager = new DataManager(this);
  }

  async onload() {
    // ── 第一步：从 Vault 本地加载设置（设置永远存这里，避免鸡生蛋）──
    const localRaw = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, localRaw.settings || {});

    // ── 第二步：根据 dataLocation 从正确位置加载项目+记录 ──
    await this.loadSharedData();

    // 数据管理器
    this.dataManager = new DataManager(this);

    // 注册视图
    this.registerView(
      VIEW_TYPE_MAIN,
      (leaf) => new TimeIsGoldMainView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_PROJECT_TREE,
      (leaf) => new ProjectTreeView(leaf, this)
    );

    this.registerView(
      VIEW_TYPE_STATS,
      (leaf) => new StatisticsView(leaf, this)
    );

    // Ribbon 图标
    if (this.settings.showRibbonIcon) {
      this.ribbonIcon = this.addRibbonIcon('footprints', '时迹', () => {
        this.activateMainView();
      });
    }

    // 命令：打开主视图
    this.addCommand({
      id: 'open-main-view',
      name: '打开计时面板',
      callback: () => this.activateMainView()
    });

    // 命令：打开项目树
    this.addCommand({
      id: 'open-project-tree',
      name: '打开人生之树',
      callback: () => this.activateProjectTree()
    });

    // 命令：打开统计
    this.addCommand({
      id: 'open-stats',
      name: '打开统计',
      callback: () => this.activateStatsView()
    });

    // 命令：快速记录（快捷键在 Obsidian 设置 → 热键 中自定义）
    this.addCommand({
      id: 'quick-record',
      name: '快速记录',
      callback: () => {
        new QuickRecordModal(this.app, this, () => {
          // 刷新所有打开的视图
          this.refreshAllViews();
        }).open();
      }
    });

    // 命令：新建项目
    this.addCommand({
      id: 'new-project',
      name: '新建项目',
      callback: () => {
        new ProjectEditModal(this.app, this, null, () => {
          this.refreshAllViews();
        }).open();
      }
    });

    // 设置页
    this.addSettingTab(new TimeIsGoldSettingTab(this.app, this));

    // 启动时自动打开主视图（首次）
    this.app.workspace.onLayoutReady(() => {
      // 不自动打开，避免打扰
    });

    console.log('🐾 时迹 插件已加载');
  }

  // ── 数据读写（设置与数据分离，全平台兼容）──
  // 设置 → 永远存 Vault 本地 .obsidian/plugins/time-is-gold/data.json（super.saveData）
  // 数据 → vault 模式用 adapter API（全平台）；shared 模式用 fs（仅桌面）

  _getAdapter() { return this.app.vault.adapter; }

  async _ensureDataDir() {
    const { mode, path: relPath } = getDataPath(this);
    if (mode === 'vault') {
      const adapter = this._getAdapter();
      const folder = this.settings?.dataFolder || '时迹数据';
      if (!(await adapter.exists(folder))) {
        await adapter.mkdir(folder);
      }
    } else {
      // Desktop shared mode — lazy require fs
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const absPath = path.join(os.homedir(), relPath);
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  async loadSharedData() {
    await this._ensureDataDir();
    const { mode, path: relPath } = getDataPath(this);
    const adapter = this._getAdapter();

    // ── 尝试从目标路径加载 ──
    let raw = null;
    if (mode === 'vault') {
      if (await adapter.exists(relPath)) {
        raw = await adapter.read(relPath);
      }
    } else {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const absPath = path.join(os.homedir(), relPath);
        if (fs.existsSync(absPath)) raw = fs.readFileSync(absPath, 'utf8');
      } catch(e) { /* fs not available */ }
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        this.data = {
          projects: parsed.projects || [],
          entries: parsed.entries || [],
          lastRecordTime: parsed.lastRecordTime || null
        };
        console.log(`🐾 时迹: 加载数据 (${this.data.projects.length}项目, ${this.data.entries.length}条记录, mode=${mode})`);
        return;
      } catch (e) {
        console.warn('时迹: 数据解析失败', e.message);
      }
    }

    // ── 迁移：vault 模式尝试从桌面共享目录迁移 ──
    if (mode === 'vault' && !isMobile(this)) {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const oldPath = path.join(os.homedir(), '.time-is-gold', 'data.json');
        if (fs.existsSync(oldPath)) {
          const oldRaw = fs.readFileSync(oldPath, 'utf8');
          const parsed = JSON.parse(oldRaw);
          this.data = {
            projects: parsed.projects || [],
            entries: parsed.entries || [],
            lastRecordTime: parsed.lastRecordTime || null
          };
          await adapter.write(relPath, JSON.stringify(this.data, null, 2));
          console.log('🐾 时迹: 数据已从共享目录迁移到 Vault 内');
          return;
        }
      } catch(e) { /* fs not available, skip */ }
    }

    // ── 迁移：从旧 vault 路径 .time-is-gold/data.json 迁移 ──
    if (mode === 'vault' && relPath !== '.time-is-gold/data.json') {
      try {
        if (await adapter.exists('.time-is-gold/data.json')) {
          const oldRaw = await adapter.read('.time-is-gold/data.json');
          const parsed = JSON.parse(oldRaw);
          this.data = {
            projects: parsed.projects || [],
            entries: parsed.entries || [],
            lastRecordTime: parsed.lastRecordTime || null
          };
          await adapter.write(relPath, JSON.stringify(this.data, null, 2));
          console.log('🐾 时迹: 数据已从旧路径迁移到新文件夹');
          return;
        }
      } catch(e) { /* skip */ }
    }

    // ── 迁移：从 Vault 本地 data.json（旧格式）──
    try {
      const vaultData = await this.loadData();
      if (vaultData && (vaultData.projects?.length || vaultData.entries?.length)) {
        this.data = {
          projects: vaultData.projects || [],
          entries: vaultData.entries || [],
          lastRecordTime: vaultData.lastRecordTime || null
        };
        const toWrite = JSON.stringify(this.data, null, 2);
        if (mode === 'vault') {
          await adapter.write(relPath, toWrite);
        } else {
          try {
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            fs.writeFileSync(path.join(os.homedir(), relPath), toWrite, 'utf8');
          } catch(e) { /* fallback */ }
        }
        console.log('🐾 时迹: 数据已从 Vault 本地迁移');
        return;
      }
    } catch (e) { /* 正常 */ }

    this.data = { projects: [], entries: [], lastRecordTime: null };
  }

  async saveData() {
    await this._ensureDataDir();
    const toSave = JSON.stringify({
      projects: this.data.projects || [],
      entries: this.data.entries || [],
      lastRecordTime: this.data.lastRecordTime || null
    }, null, 2);

    const { mode, path: relPath } = getDataPath(this);
    try {
      if (mode === 'vault') {
        await this._getAdapter().write(relPath, toSave);
      } else {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        fs.writeFileSync(path.join(os.homedir(), relPath), toSave, 'utf8');
      }
    } catch (e) {
      console.error('时迹: 保存数据失败', e.message);
    }
  }

  // 保存设置到 Vault 本地（永不丢失 dataLocation）
  async saveSettings() {
    return super.saveData({ settings: this.settings });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_MAIN);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PROJECT_TREE);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_STATS);
    console.log('🐾 时迹 插件已卸载');
  }

  async activateMainView() {
    const { workspace } = this.app;
    
    // 检查是否已打开
    const existing = workspace.getLeavesOfType(VIEW_TYPE_MAIN);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    // 在右侧侧边栏打开
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_MAIN, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  async activateProjectTree() {
    const { workspace } = this.app;
    
    const existing = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_TREE);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_PROJECT_TREE, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  async activateStatsView() {
    const { workspace } = this.app;
    
    const existing = workspace.getLeavesOfType(VIEW_TYPE_STATS);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_STATS, active: true });
      workspace.revealLeaf(leaf);
    }
  }

  refreshAllViews() {
    // 刷新主视图（tabbed：重新渲染当前面板）
    const mainLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAIN);
    for (const leaf of mainLeaves) {
      if (leaf.view && leaf.view instanceof TimeIsGoldMainView) {
        leaf.view.renderPanel(leaf.view.activeTab || 'timer');
      }
    }

    // 刷新独立的项目树视图
    const treeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_TREE);
    for (const leaf of treeLeaves) {
      if (leaf.view && leaf.view instanceof ProjectTreeView) {
        leaf.view.refreshTree();
      }
    }

    // 刷新独立的统计视图
    const statsLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_STATS);
    for (const leaf of statsLeaves) {
      if (leaf.view && leaf.view instanceof StatisticsView) {
        leaf.view.renderActiveTab();
      }
    }
  }
}

module.exports = TimeIsGoldPlugin;

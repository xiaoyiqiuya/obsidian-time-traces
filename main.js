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
// "vault"  → Vault 内 {dataFolder}/time-traces.json（全平台，Obsidian adapter API）
function getDataPath(plugin) {
  const loc = plugin.settings?.dataLocation || 'shared';
  if (loc === 'vault' || isMobile(plugin)) {
    const folder = plugin.settings?.dataFolder || '时迹数据';
    return { mode: 'vault', path: `${folder}/time-traces.json` };
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
  dataLocation: "vault",
  dataFolder: "时迹数据",
  httpEnabled: false,
  httpToken: "",
  timelineOrder: "newest-first",
  treeDefaultView: "situation",
  webdavEnabled: false,
  webdavUrl: "",
  webdavUsername: "",
  webdavPassword: "",
  webdavLastSync: null
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
function fmtDateLocal(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

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

  findProjectByName(name) {
    return (this.data.projects || []).filter(p => 
      p.name === name && !p.archived
    ).map(p => ({
      ...p,
      parentPath: this._getProjectPath(p.parentId)
    }));
  }

  _getProjectPath(pid) {
    if (!pid) return '';
    const p = this.getProject(pid);
    if (!p) return '';
    const parentPath = this._getProjectPath(p.parentId);
    return parentPath ? `${parentPath} > ${p.name}` : p.name;
  }

  async addProject(name, parentId = null, color = null, situation = null) {
    const projects = this.data.projects || [];
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
    // 链式记录：基于 lastChainTime 计算，不受独立事件（AI/API）干扰
    const lastTime = this.data.lastChainTime || this.data.lastRecordTime;
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
    this.data.lastChainTime = endTime.toISOString();
    
    await this.plugin.saveData();
    
    if (this.plugin.settings.appendToDailyNote && !isMerge) {
      await this.appendToDailyNote(entry);
    }
    
    return entry;
  }

  // ── 空白记录（遗忘时间）──

  async recordBlankEntry() {
    // 空白记录也属于链式操作，使用 lastChainTime
    const lastTime = this.data.lastChainTime || this.data.lastRecordTime;
    const endTime = new Date();
    const startTime = lastTime ? new Date(lastTime) : new Date(endTime - 3600000);
    let duration = Math.round((endTime - startTime) / 60000);
    if (duration < 0) duration = 0;
    if (duration === 0) return null;

    const entry = {
      id: uid(),
      projectId: '__blank__',
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration,
      note: '',
      createdAt: nowISO()
    };
    const entries = this.data.entries || [];
    entries.push(entry);
    this.data.entries = entries;
    this.data.lastRecordTime = endTime.toISOString();
    this.data.lastChainTime = endTime.toISOString();
    await this.plugin.saveData();
    return entry;
  }

  // ── 间隙填补（用于时间轴点击未记录时段）──

  async recordGapEntry(projectId, startTimeISO, endTimeISO, note = '') {
    // 独立事件记录（API/分账/时间轴填补）
    // 不更新 lastChainTime，避免污染链式指针
    const startTime = new Date(startTimeISO);
    const endTime = new Date(endTimeISO);
    let duration = Math.round((endTime - startTime) / 60000);
    if (duration < 0) duration = 0;
    if (duration === 0) return null;

    const entry = {
      id: uid(),
      projectId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration,
      note,
      createdAt: nowISO()
    };
    const entries = this.data.entries || [];
    entries.push(entry);
    entries.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    this.data.entries = entries;
    // 更新 lastRecordTime：取当前值和新条目 endTime 中较新的
    // 注意：不更新 lastChainTime，保证链式记录不被独立事件干扰
    const currLast = this.data.lastRecordTime ? new Date(this.data.lastRecordTime) : null;
    if (!currLast || endTime > currLast) {
      this.data.lastRecordTime = endTime.toISOString();
    }
    await this.plugin.saveData();
    return entry;
  }

  // ── 长间隔检测 ──

  getGapInfo() {
    // 使用链式指针判断间隔（独立事件不会重置间隔）
    const lastTime = this.data.lastChainTime || this.data.lastRecordTime;
    if (!lastTime) return { gapMinutes: 0, isLongGap: false, lastTime: null, now: new Date().toISOString() };
    const now = new Date();
    const gapMinutes = Math.round((now - new Date(lastTime)) / 60000);
    return {
      gapMinutes,
      isLongGap: gapMinutes > 30,
      lastTime,
      now: now.toISOString()
    };
  }

  // ── 智能推荐（全数据驱动，零字段依赖）──
  // 六维信号：①时间邻近度 ②节律匹配 ③衰减记忆 ④连续活跃 ⑤时段合理性 ⑥今日配额

  getSmartRecommendations(gapMinutes) {
    const entries = this.data.entries || [];
    if (entries.length === 0) return [];

    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay(); // 0=Sun..6=Sat
    const todayStr = fmtDate(now.toISOString());
    const windowDays = 60;
    const decayHalf = 10; // 半衰期 ~7天（ln2 × 10 ≈ 7）

    // ── 单次遍历：为每个条目打分 + 收集各项目统计 ──
    const projectAcc = new Map(); // pid → accumulator

    for (const e of entries) {
      if (e.projectId === '__blank__') continue;
      const d = new Date(e.endTime);
      const daysAgo = (now - d) / 86400000;
      if (daysAgo > windowDays) continue;

      const hour = d.getHours();
      const day = d.getDay();
      const date = fmtDate(e.endTime);
      const decay = Math.exp(-daysAgo / decayHalf);
      // ① 时间邻近度：平滑衰减，±4h 归零
      const proximity = Math.max(0, 1 - Math.abs(hour - currentHour) / 4);
      const entryScore = proximity * decay;

      let acc = projectAcc.get(e.projectId);
      if (!acc) {
        acc = {
          totalScore: 0,
          durations: [],
          lastHour: 0,
          dates: new Set(),        // 出现过哪些日期
          slotHits: 0,             // ±3h 时段内命中
          totalCount: 0,
          dayCounts: [0,0,0,0,0,0,0], // Sun..Sat
          todayCount: 0
        };
        projectAcc.set(e.projectId, acc);
      }

      acc.totalScore += entryScore;
      acc.durations.push(e.duration || 0);
      acc.lastHour = Math.max(acc.lastHour, hour);
      acc.dates.add(date);
      acc.totalCount++;
      if (Math.abs(hour - currentHour) <= 3) acc.slotHits++;
      acc.dayCounts[day]++;
      if (date === todayStr) acc.todayCount++;
    }

    if (projectAcc.size === 0) return [];

    // ── 计算每个项目的最终得分 ──
    const results = [];
    for (const [pid, acc] of projectAcc) {
      let score = acc.totalScore;

      // ② 节律匹配：该项目在同星期几的比例
      const dayRatio = acc.dayCounts[currentDay] / acc.totalCount;
      if (dayRatio > 0.3) score += 3 * dayRatio;

      // ④ 连续活跃：近7天连续出现天数
      const consecutive = this._countRecentStreak(acc.dates, 7);
      score += consecutive * 1.5;

      // ⑤ 时段合理性：该项目在此时段(±3h)出现过吗
      const slotRatio = acc.slotHits / acc.totalCount;
      if (acc.slotHits === 0) score *= 0.3;

      // ⑥ 今日配额：今天次数是否已触及历史单日上限
      if (acc.todayCount > 0) {
        const dailyMax = this._getProjectDailyMax(pid, 60);
        if (acc.todayCount >= dailyMax && acc.slotHits === 0) {
          score *= 0.15;
        }
      }

      // ⑦ 时长：中位数
      const sortedDur = [...acc.durations].sort((a, b) => a - b);
      const median = sortedDur[Math.floor(sortedDur.length / 2)] || 30;

      results.push({
        projectId: pid,
        score,
        medianDuration: median,
        lastHour: acc.lastHour
      });
    }

    // 排序，取 Top 4，返回典型时长（中位数），不缩放
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, 4);

    return top.map(r => {
      const p = this.getProject(r.projectId);
      return {
        projectId: r.projectId,
        name: p ? p.name : '(已删除)',
        color: p?.color || '#9E9E9E',
        duration: Math.min(r.medianDuration, gapMinutes),
        slotHour: r.lastHour
      };
    });
  }

  // ── 辅助：项目近N天连续出现天数 ──
  _countRecentStreak(dates, days) {
    let streak = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = fmtDate(d.toISOString());
      if (dates.has(ds)) streak++;
      else break; // 断开即停
    }
    return streak;
  }

  // ── 辅助：项目历史单日最大条目数（p95）──
  _getProjectDailyMax(projectId, windowDays) {
    const entries = this.data.entries || [];
    const dailyCounts = new Map(); // date → count
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);

    for (const e of entries) {
      if (e.projectId !== projectId) continue;
      const d = new Date(e.endTime);
      if (d < cutoff) continue;
      const ds = fmtDate(e.endTime);
      dailyCounts.set(ds, (dailyCounts.get(ds) || 0) + 1);
    }

    if (dailyCounts.size === 0) return 1;
    const counts = [...dailyCounts.values()].sort((a, b) => b - a);
    // p95：取前 5% 位置的值，最小为 1
    const idx = Math.max(0, Math.floor(counts.length * 0.05));
    return Math.max(1, counts[idx] || 1);
  }

  // ── 分账写入 ──

  async recordSplitEntries(splitEntries, baseTimeISO = null) {
    const entries = this.data.entries || [];
    // 分账也是链式操作：基于 lastChainTime 或传入的 baseTimeISO
    const chainBase = this.data.lastChainTime || this.data.lastRecordTime;
    const base = baseTimeISO ? new Date(baseTimeISO) : (chainBase ? new Date(chainBase) : new Date(Date.now() - 3600000));
    let prevEnd = base;

    for (const se of splitEntries) {
      const startTime = new Date(prevEnd);
      const endTime = new Date(startTime.getTime() + se.duration * 60000);
      const entry = {
        id: uid(),
        projectId: se.projectId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        duration: se.duration,
        note: se.note || '',
        createdAt: nowISO()
      };
      entries.push(entry);
      prevEnd = endTime;
    }

    this.data.entries = entries;
    this.data.lastRecordTime = prevEnd.toISOString();
    this.data.lastChainTime = prevEnd.toISOString();
    await this.plugin.saveData();
    return entries.slice(-splitEntries.length);
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
    return (this.data.entries || [])
      .filter(e => e.startTime && fmtDate(e.endTime) === t)
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  }

  getEntriesByDate(date) {
    // 返回 endTime 在某天的条目 + 跨天条目（startTime < 次日00:00 && endTime > 当日00:00）
    const dayStart = new Date(date + 'T00:00:00');
    const dayEnd = new Date(date + 'T23:59:59');
    return (this.data.entries || [])
      .filter(e => {
        if (!e.startTime) return false;
        const st = new Date(e.startTime), et = new Date(e.endTime);
        return et >= dayStart && st <= dayEnd;
      })
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  }

  getAllEntriesSorted() {
    return [...(this.data.entries || [])]
      .filter(e => e.startTime)
      .sort((a, b) => new Date(b.endTime) - new Date(a.endTime));
  }

  // 统计用（排除空白）
  getEntriesForStats(dateSince) {
    return (this.data.entries || [])
      .filter(e => e.startTime && e.projectId !== '__blank__')
      .filter(e => !dateSince || fmtDate(e.endTime) >= dateSince)
      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  }

  getLastRecordTime() {
    // 返回全局最新的条目结束时间（用于 UI 计时器显示）
    // 遍历所有 entries 取最新 endTime，确保不与链式指针混淆
    const entries = this.data.entries || [];
    if (entries.length === 0) return this.data.lastChainTime || this.data.lastRecordTime || null;
    const latest = entries.reduce((max, e) => e.endTime > max ? e.endTime : max, entries[0].endTime);
    return latest;
  }

  getChainTime() {
    // 返回链式指针（仅由 UI 手动点击更新）
    return this.data.lastChainTime || null;
  }

  getExternalTime() {
    // 返回最近的独立事件时间（不含链式的指针）
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
  // gapContext（可选）: { startTime: ISO, endTime: ISO, gapMin: number }
  //   从时间轴间隙进入时传入，用于填补过去的时间段
  constructor(app, plugin, onSubmit, gapContext = null) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
    this.gapContext = gapContext;
    this.listMode = 'situation'; // 'situation' | 'hierarchy' —— 全部项目的分组方式
  }

  // ── 统一的记录动作 ──
  async _doRecord(projectId) {
    const dm = this.plugin.dataManager;
    const isGap = !!(this.gapContext && this.gapContext.startTime && this.gapContext.endTime);
    try {
      if (isGap) {
        const entry = await dm.recordGapEntry(projectId, this.gapContext.startTime, this.gapContext.endTime);
        if (!entry) {
          new Notice('⚠️ 时间段无效，无法记录');
          this.close();
          return;
        }
        new Notice(`✅ ${dm.getProject(projectId)?.name || '项目'} — 时间段已分配`);
      } else {
        // 使用 maybeRecord 保留长间隔分账逻辑
        await new Promise(resolve => {
          this.plugin.maybeRecord(projectId, resolve);
        });
      }
    } catch (e) {
      console.error('时迹 _doRecord 错误:', e);
      new Notice('❌ 记录失败: ' + (e.message || '未知错误'));
      this.close();
      return;
    }
    // 先关闭 modal，再触发回调刷新视图（避免 DOM 竞争）
    this.close();
    if (this.onSubmit) {
      try { this.onSubmit(); } catch (e) { console.error('时迹 onSubmit 错误:', e); }
    }
  }

  // ── 渲染一个可点击的项目行 ──
  _renderProjectRow(container, p) {
    const dm = this.plugin.dataManager;
    const row = container.createDiv('tig-modal-item');
    const colorDot = row.createSpan('tig-color-dot');
    colorDot.style.backgroundColor = p.color || '#9E9E9E';
    row.createSpan({ text: p.name, cls: 'tig-modal-item-name' });
    const total = dm.getProjectTotalMinutes(p.id);
    row.createSpan({ text: fmtDuration(total), cls: 'tig-modal-item-dur' });
    row.addEventListener('click', () => this._doRecord(p.id));
    return row;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('tig-modal');
    
    const dm = this.plugin.dataManager;
    const isGapFill = !!(this.gapContext && this.gapContext.startTime && this.gapContext.endTime);

    if (isGapFill) {
      const gapMin = this.gapContext.gapMin || Math.round((new Date(this.gapContext.endTime) - new Date(this.gapContext.startTime)) / 60000);
      contentEl.createEl('h3', { text: '🐾 分配时间' });
      contentEl.createEl('p', { 
        text: `${fmtTime(this.gapContext.startTime)} → ${fmtTime(this.gapContext.endTime)}（${fmtDuration(gapMin)}）`,
        cls: 'tig-modal-hint' 
      });
    } else {
      contentEl.createEl('h3', { text: '🐾 快速记录' });
      const chainTime = dm.getChainTime() || dm.getLastRecordTime();
      if (chainTime) {
        const diff = Math.round((new Date() - new Date(chainTime)) / 60000);
        contentEl.createEl('p', { text: `距上次记录已过 ${fmtDuration(diff)}`, cls: 'tig-modal-hint' });
      }
    }

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
        await this._doRecord(project.id);
      });
      return;
    }

    // ── ❶ 5 个快捷项目（智能推荐，与快捷项目区一致）──
    const recent = dm.getRecentProjects(5);
    const recentIds = new Set(recent.map(p => p.id));
    const quickLabel = contentEl.createEl('p', { text: '💡 智能推荐', cls: 'tig-modal-label' });
    const quickList = contentEl.createDiv('tig-modal-list');
    for (const p of recent) {
      this._renderProjectRow(quickList, p);
    }

    // ── 分隔线 ──
    contentEl.createEl('hr', { cls: 'tig-modal-divider' });

    // ── ❷ 全部项目（带场景/层级切换）──
    const allHeader = contentEl.createDiv('tig-modal-all-header');
    allHeader.createSpan({ text: '📋 全部项目', cls: 'tig-modal-label' });
    const modeBtns = allHeader.createDiv('tig-mode-btns');
    const sitBtn = modeBtns.createEl('button', { text: '📂 情景', cls: 'tig-btn tig-btn-sm tig-mode-active', attr: { title: '按情景分组' } });
    const hierBtn = modeBtns.createEl('button', { text: '🌿 层级', cls: 'tig-btn tig-btn-sm', attr: { title: '按层级' } });
    sitBtn.addEventListener('click', () => {
      this.listMode = 'situation';
      sitBtn.addClass('tig-mode-active'); hierBtn.removeClass('tig-mode-active');
      this._renderAllList(allList, dm, projects, recentIds);
    });
    hierBtn.addEventListener('click', () => {
      this.listMode = 'hierarchy';
      hierBtn.addClass('tig-mode-active'); sitBtn.removeClass('tig-mode-active');
      this._renderAllList(allList, dm, projects, recentIds);
    });

    const allList = contentEl.createDiv('tig-modal-all-list');
    this._renderAllList(allList, dm, projects, recentIds);
  }

  // ── 渲染全部项目列表（按当前 listMode 分组）──
  _renderAllList(container, dm, projects, recentIds) {
    container.empty();

    if (this.listMode === 'situation') {
      // ── 按情景分组 ──
      const sitMap = new Map();
      const situations = Object.keys(this.plugin.settings.situationColors || SITUATION_COLORS);
      for (const p of projects) {
        const sit = p.situation || this.plugin.settings.defaultSituation || '默认';
        if (!sitMap.has(sit)) sitMap.set(sit, []);
        sitMap.get(sit).push(p);
      }
      // 按情境配置顺序排列
      const sortedSits = [...sitMap.keys()].sort((a, b) => {
        const ia = situations.indexOf(a), ib = situations.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.localeCompare(b, 'zh-CN');
      });

      for (const sit of sortedSits) {
        const projs = sitMap.get(sit);
        const sitHeader = container.createDiv('tig-modal-scene-header');
        const color = this.plugin.settings.situationColors?.[sit] || SITUATION_COLORS[sit] || '#9E9E9E';
        const dot = sitHeader.createSpan('tig-color-dot');
        dot.style.backgroundColor = color;
        sitHeader.createSpan({ text: `${sit}（${projs.length}）`, cls: 'tig-modal-scene-label' });
        for (const p of projs) {
          const row = this._renderProjectRow(container, p);
          if (recentIds.has(p.id)) row.addClass('tig-modal-item-recent');
        }
      }
    } else {
      // ── 按层级（树状）──
      const tree = dm.getProjectTree(null);
      this._renderTreeList(container, tree, recentIds, 0);
    }
  }

  _renderTreeList(container, nodes, recentIds, depth) {
    for (const node of nodes) {
      const row = this._renderProjectRow(container, node);
      row.style.paddingLeft = `${depth * 14 + 12}px`;
      if (recentIds.has(node.id)) row.addClass('tig-modal-item-recent');
      if (node.children && node.children.length > 0) {
        this._renderTreeList(container, node.children, recentIds, depth + 1);
      }
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// ═══════════════════════════════════════════
//  长间隔分账弹窗
// ═══════════════════════════════════════════

class SplitRecordModal extends Modal {
  // baseTime（可选）: ISO 字符串，分账的起始时间（用于时间轴间隙填补）
  constructor(app, plugin, gapInfo, mainProjectId, onDone, baseTime = null) {
    super(app);
    this.plugin = plugin;
    this.gapInfo = gapInfo;
    this.mainProjectId = mainProjectId;
    this.onDone = onDone;
    this.baseTime = baseTime;
    this.items = [];
    this.defaultStep = 15;
  }

  get totalGap() { return this.gapInfo.gapMinutes; }
  get allocatedMin() {
    return this.items.reduce((s, i) => s + i.duration, 0);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tig-split-modal');

    const dm = this.plugin.dataManager;
    const mainProject = dm.getProject(this.mainProjectId);
    const lastTime = new Date(this.gapInfo.lastTime);
    const now = new Date(this.gapInfo.now);

    // 标题
    contentEl.createEl('h3', {
      text: `📋 距上次记录 ${fmtDuration(this.totalGap)}（${fmtTime(lastTime.toISOString())} → ${fmtTime(now.toISOString())}）`
    });

    // ── 统一项目列表（主项目占满 gap，智能推荐点击添加）──
    this.itemsEl = contentEl.createDiv('tig-split-recs');

    // 主项目：初始占满整个 gap（如果存在）
    if (mainProject) {
      this._addItem(this.mainProjectId, mainProject.name, mainProject.color || '#9E9E9E', this.totalGap, new Date().getHours());
      const mainItem = this.items.find(i => i.projectId === this.mainProjectId);
      if (mainItem) mainItem.isMain = true;
    }
    this._mainManuallySet = false;
    this._renderAll();

    // 智能推荐：只展示，点击才添加
    const recs = dm.getSmartRecommendations(this.totalGap);
    const otherRecs = recs.filter(r => r.projectId !== this.mainProjectId);
    if (otherRecs.length > 0) {
      contentEl.createEl('p', { text: '💡 智能推荐 · 点击添加', cls: 'tig-split-label' });
      const recsEl = contentEl.createDiv('tig-split-suggestions');
      for (const r of otherRecs) {
        const btn = recsEl.createEl('button', { cls: 'tig-split-suggest-btn' });
        const dot = btn.createSpan('tig-split-dot');
        dot.style.backgroundColor = r.color;
        btn.createSpan({ text: r.name });
        btn.createSpan({ text: fmtDuration(r.duration), cls: 'tig-split-suggest-dur' });
        btn.addEventListener('click', () => {
          this._addItem(r.projectId, r.name, r.color, r.duration, r.slotHour);
          this._renderAll();
        });
      }
    }

    // ⬜ 空白（遗忘时间）
    const blankRow = contentEl.createDiv('tig-split-add-row');
    const blankBtn = blankRow.createEl('button', { text: '⬜ 遗忘/空白时间', cls: 'tig-split-add-btn' });
    blankBtn.addEventListener('click', () => {
      const gap = this.totalGap - this.allocatedMin;
      if (gap > 0) {
        this._mainManuallySet = false;
        this._renderAll();
        new Notice(`⬜ 剩余 ${fmtDuration(gap)} 已标为空白`);
      }
    });

    // 添加按钮（树形菜单 + 新建）
    const addRow = contentEl.createDiv('tig-split-add-row');
    const addBtn = addRow.createEl('button', { text: '＋ 补其他活动', cls: 'tig-split-add-btn' });
    addBtn.addEventListener('click', () => {
      const menu = new Menu();

      // 新建项目
      menu.addItem(item => item
        .setTitle('＋ 新建项目')
        .setIcon('plus')
        .onClick(() => {
          new ProjectEditModal(this.app, this.plugin, null, (newProject) => {
            if (newProject) {
              this._addItem(newProject.id, newProject.name, newProject.color || '#9E9E9E', 60);
              this._renderAll();
            }
          }).open();
        }));

      menu.addSeparator();

      // 树形项目列表
      const tree = dm.getProjectTree(null);
      const buildMenu = (nodes, m, depth) => {
        for (const node of nodes) {
          const prefix = depth > 0 ? '  '.repeat(depth) + '└ ' : '';
          m.addItem(item => item
            .setTitle(prefix + node.name)
            .onClick(() => {
              this._addItem(node.id, node.name, node.color || '#9E9E9E', 60);
              this._renderAll();
            }));
          if (node.children && node.children.length > 0) {
            buildMenu(node.children, m, depth + 1);
          }
        }
      };
      buildMenu(tree, menu, 0);

      menu.showAtPosition({ x: addBtn.getBoundingClientRect().left, y: addBtn.getBoundingClientRect().bottom });
    });

    // 汇总区
    this.summaryEl = contentEl.createDiv('tig-split-summary');

    // 按钮
    const btnRow = contentEl.createDiv('tig-split-btns');

    if (mainProject) {
      const skipBtn = btnRow.createEl('button', {
        text: `仅记「${mainProject.name}」`,
        cls: 'tig-split-skip'
      });
      skipBtn.addEventListener('click', async () => {
        await dm.recordEntry(this.mainProjectId);
        this.close();
        if (this.onDone) this.onDone();
        new Notice(`🐾 ${mainProject.name} — ${fmtDuration(this.totalGap)}`);
      });
    }

    this.confirmBtn = btnRow.createEl('button', {
      text: '✓ 确认分账',
      cls: 'tig-split-confirm'
    });
    this.confirmBtn.addEventListener('click', async () => {
      try {
        if (this.allocatedMin > this.totalGap) { new Notice('⚠️ 已分配时间超过总时长'); return; }
        const entries = this.items.map(i => ({ projectId: i.projectId, duration: i.duration, note: '' }));
        if (entries.length === 0) {
          if (this.mainProjectId) {
            entries.push({ projectId: this.mainProjectId, duration: this.totalGap, note: '' });
          } else {
            new Notice('⚠️ 请至少添加一个项目'); return;
          }
        }
        await dm.recordSplitEntries(entries, this.baseTime);
        this.close();
        if (this.onDone) this.onDone();
        const projectNames = [...new Set(entries.map(e => {
          const p = dm.getProject(e.projectId);
          return p ? p.name : '?';
        }))].join('、');
        new Notice(`✅ 已分账: ${projectNames}`);
      } catch (e) {
        console.error('时迹 分账保存失败:', e);
        new Notice('❌ 分账保存失败: ' + (e.message || '未知错误'));
      }
    });

  }

  // ── 添加项目到数组（不渲染 DOM）──
  _addItem(projectId, name, color, duration, slotHour) {
    const existing = this.items.find(i => i.projectId === projectId);
    if (existing) {
      // 已有项目追加时长：不超过剩余可分配空间
      const otherSum = this.items.reduce((s, i) => (i.isMain ? 0 : s + i.duration), 0);
      const remaining = this.totalGap - otherSum;
      existing.duration += Math.min(duration, Math.max(0, remaining));
      return;
    }
    // 新项目：默认时长不超过剩余空间
    const otherSum = this.items.reduce((s, i) => (i.isMain ? 0 : s + i.duration), 0);
    const remaining = this.totalGap - otherSum;
    const capped = Math.min(duration, Math.max(this.defaultStep, remaining));
    if (capped <= 0) return;
    const item = { projectId, name, color, duration: capped, slotHour: slotHour || new Date().getHours() };
    this.items.push(item);
  }

  _renderAll() {
    if (!this.itemsEl) return;

    // 主项目自动吸收剩余时间（除非用户手动调过）
    const mainItem = this.items.find(i => i.isMain);
    if (mainItem && !this._mainManuallySet) {
      const otherSum = this.items.reduce((s, i) => (i.isMain ? 0 : s + i.duration), 0);
      mainItem.duration = Math.max(0, this.totalGap - otherSum);
    }

    // 用 fragment 原子替换，避免 height→0 导致页面抖动
    const frag = document.createDocumentFragment();
    const totalRows = this.items.length;
    for (let idx = 0; idx < this.items.length; idx++) {
      this._renderRow(frag, this.items[idx], idx, totalRows);
    }
    this.itemsEl.replaceChildren(frag);
    this._renderSummary();
  }

  _renderRow(parentEl, item, idx, totalItems) {
    // 计算该项目在总时长中的位置
    let offsetMin = 0;
    for (let i = 0; i < idx; i++) offsetMin += this.items[i].duration || 0;
    const startTime = new Date(new Date(this.gapInfo.lastTime).getTime() + offsetMin * 60000);

    const row = parentEl.createDiv('tig-tl-row');
    const timeLabel = row.createDiv('tig-tl-time');
    timeLabel.setText(fmtTime(startTime.toISOString()));

    const card = row.createDiv('tig-tl-card');
    if (item.isMain) card.addClass('tig-tl-card-main');

    // 左边框比例填充
    const maxDur = Math.max(...this.items.map(i => i.duration || 0), 1);
    const fillPct = Math.round(((item.duration || 0) / maxDur) * 100);
    const barFill = card.createDiv('tig-tl-bar-fill');
    barFill.style.height = fillPct + '%';
    barFill.style.backgroundColor = item.color;
    if (fillPct >= 95) barFill.addClass('tig-tl-bar-full');

    // ▲▼ 按钮
    if (totalItems > 1) {
      const moveBtns = card.createSpan('tig-split-move');
      const upBtn = moveBtns.createEl('button', { text: '▲', cls: 'tig-split-move-btn', attr: { title: '上移' } });
      const downBtn = moveBtns.createEl('button', { text: '▼', cls: 'tig-split-move-btn', attr: { title: '下移' } });
      if (idx === 0) upBtn.addClass('tig-split-move-disabled');
      if (idx === totalItems - 1) downBtn.addClass('tig-split-move-disabled');
      upBtn.addEventListener('click', () => { this._moveItem(idx, -1); });
      downBtn.addEventListener('click', () => { this._moveItem(idx, 1); });
    }

    card.createSpan({ text: item.isMain ? `⭐ ${item.name}` : item.name, cls: 'tig-tl-name' });

    const minus = card.createEl('button', { text: '−', cls: 'tig-split-adj' });
    const durEl = card.createEl('span', { text: fmtDuration(item.duration), cls: 'tig-tl-dur', attr: { title: '点击输入分钟数' } });
    durEl.style.cursor = 'pointer';
    const plus = card.createEl('button', { text: '+', cls: 'tig-split-adj' });

    // 点击时长 → 输入框直接改分钟数
    durEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'number';
      input.min = String(this.defaultStep);
      input.max = String(this.totalGap);
      input.value = String(item.duration);
      input.style.cssText = 'width:58px;text-align:center;font-family:var(--font-monospace);font-size:13px;padding:2px 4px;border:1px solid var(--interactive-accent);border-radius:4px;background:var(--background-primary)';
      durEl.replaceWith(input);
      input.focus(); input.select();

      const apply = () => {
        const v = parseInt(input.value) || item.duration;
        item.duration = Math.max(this.defaultStep, Math.min(v, this.totalGap));
        if (item.isMain) {
          this._mainManuallySet = true;
          this._renderSummary();
          this._renderAll(); // 刷新 durEl 显示
        } else {
          this._mainManuallySet = false;
          this._renderAll();
        }
      };
      input.addEventListener('blur', apply);
      input.addEventListener('keydown', (ke) => { if (ke.key === 'Enter') { ke.preventDefault(); apply(); } });
    });

    if (!item.isMain) {
      const del = card.createEl('button', { text: '✕', cls: 'tig-split-del' });
      del.addEventListener('click', () => {
        this.items = this.items.filter(i => i.projectId !== item.projectId);
        this._mainManuallySet = false;
        this._renderAll();
      });
    }

    const update = () => {
      // 计算当前项目可调整的上限（保证总时长不超 totalGap）
      const otherSum = this.items.reduce((s, i) => (i === item ? s : s + i.duration), 0);
      const maxAllowed = Math.max(this.defaultStep, this.totalGap - otherSum);
      item.duration = Math.max(this.defaultStep, Math.min(item.duration, maxAllowed));
      durEl.setText(fmtDuration(item.duration));
      if (item.isMain) {
        this._mainManuallySet = true;
        this._renderSummary();
      } else {
        this._mainManuallySet = false;
        this._renderAll();
      }
    };
    minus.addEventListener('click', () => { item.duration -= this.defaultStep; update(); });
    plus.addEventListener('click', () => { item.duration += this.defaultStep; update(); });

    // ── 长按拖拽排序（pointer 事件，兼容触屏+鼠标）──
    let longPressTimer = null;
    let dragClone = null;
    let startY = 0;
    let rowRect = null;
    let dragging = false;

    const onDown = (e) => {
      if (e.target.closest('button')) return;
      rowRect = row.getBoundingClientRect();
      startY = e.clientY;
      longPressTimer = setTimeout(() => {
        dragging = true;
        dragClone = row.cloneNode(true);
        dragClone.addClass('tig-tl-dragging');
        dragClone.style.position = 'fixed';
        dragClone.style.left = rowRect.left + 'px';
        dragClone.style.top = rowRect.top + 'px';
        dragClone.style.width = rowRect.width + 'px';
        dragClone.style.zIndex = '1000';
        dragClone.style.pointerEvents = 'none';
        document.body.appendChild(dragClone);
        row.addClass('tig-tl-drag-source');
        row.setPointerCapture(e.pointerId);
      }, 500);
    };

    const onMove = (e) => {
      if (!dragging) { clearTimeout(longPressTimer); return; }
      e.preventDefault();
      const y = e.clientY;
      dragClone.style.top = (y - (startY - rowRect.top)) + 'px';
      const allRows = [...this.itemsEl.querySelectorAll('.tig-tl-row')];
      // 清除上一次的移位
      allRows.forEach(r => { r.classList.remove('tig-tl-drop-target'); r.style.transform = ''; });
      let insertBefore = -1;
      for (let i = 0; i < allRows.length; i++) {
        const rect = allRows[i].getBoundingClientRect();
        if (y < rect.top + rect.height / 2) { insertBefore = i; break; }
      }
      // transform 移位让出空间（不改布局，无抖动）
      const dragH = rowRect.height + 4;
      for (let i = 0; i < allRows.length; i++) {
        if (i === idx) { allRows[i].style.transform = ''; continue; } // 跳过拖拽源
        if (insertBefore >= 0 && i >= insertBefore) {
          allRows[i].style.transform = `translateY(${dragH}px)`;
        } else if (insertBefore < 0 && i < idx) {
          allRows[i].style.transform = `translateY(-${dragH}px)`;
        }
      }
      // 高亮目标行
      const highlightIdx = insertBefore >= 0 ? insertBefore : allRows.length - 1;
      if (highlightIdx >= 0 && highlightIdx < allRows.length && highlightIdx !== idx) {
        allRows[highlightIdx].classList.add('tig-tl-drop-target');
      }
    };

    const onUp = () => {
      clearTimeout(longPressTimer);
      if (!dragging) return;
      dragging = false;
      const allRows = [...this.itemsEl.querySelectorAll('.tig-tl-row')];
      allRows.forEach(r => { r.classList.remove('tig-tl-drop-target'); r.style.marginTop = ''; r.style.marginBottom = ''; });
      if (!dragClone) return;
      const y = dragClone.getBoundingClientRect().top + dragClone.getBoundingClientRect().height / 2;
      let insertBefore = -1;
      for (let i = 0; i < allRows.length; i++) {
        const rect = allRows[i].getBoundingClientRect();
        if (y < rect.top + rect.height / 2) { insertBefore = i; break; }
      }
      const moved = this.items.splice(idx, 1)[0];
      const insertAt = insertBefore >= 0 ? Math.min(insertBefore, this.items.length) : this.items.length;
      this.items.splice(insertAt, 0, moved);
      dragClone.remove();
      dragClone = null;
      row.removeClass('tig-tl-drag-source');
      // 清除所有行的 transform（拖拽时移位效果）
      allRows.forEach(r => { r.style.transform = ''; });
      // DOM 操作：移除拖拽行，插入到目标位置
      row.style.transition = 'none'; row.style.transform = ''; row.style.opacity = '';
      const targetRows = [...this.itemsEl.querySelectorAll('.tig-tl-row')];
      if (insertAt < targetRows.length) {
        this.itemsEl.insertBefore(row, targetRows[insertAt]);
      } else {
        this.itemsEl.appendChild(row);
      }
      // 更新所有行的时间标签
      const finalRows = [...this.itemsEl.querySelectorAll('.tig-tl-row')];
      for (let i = 0; i < finalRows.length; i++) {
        this._updateRowTime(finalRows[i], i);
      }
      this._renderSummary();
    };

    row.addEventListener('pointerdown', onDown);
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerup', onUp);
    row.addEventListener('pointercancel', () => {
      clearTimeout(longPressTimer); dragging = false;
      if (dragClone) { dragClone.remove(); dragClone = null; row.removeClass('tig-tl-drag-source'); }
    });
    row.style.touchAction = 'none';
  }

  _moveItem(idx, dir) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= this.items.length) return;

    const rows = [...this.itemsEl.querySelectorAll('.tig-tl-row')];
    const rowA = rows[idx], rowB = rows[newIdx];
    if (!rowA || !rowB) return;

    // 交换数据
    [this.items[idx], this.items[newIdx]] = [this.items[newIdx], this.items[idx]];

    // DOM 交换 + CSS 动画
    const hA = rowA.getBoundingClientRect().height;
    const hB = rowB.getBoundingClientRect().height;
    const gap = 4;
    rowA.style.transition = 'transform 0.2s ease';
    rowB.style.transition = 'transform 0.2s ease';
    rowA.style.transform = `translateY(${dir > 0 ? hB + gap : -(hB + gap)}px)`;
    rowB.style.transform = `translateY(${dir > 0 ? -(hA + gap) : hA + gap}px)`;

    let ended = false;
    const onEnd = () => {
      if (ended) return; ended = true;
      rowA.style.transition = ''; rowA.style.transform = '';
      rowB.style.transition = ''; rowB.style.transform = '';
      if (dir > 0) rowA.parentNode.insertBefore(rowA, rowB.nextSibling);
      else rowB.parentNode.insertBefore(rowB, rowA);
      this._updateRowTime(rowA, newIdx);
      this._updateRowTime(rowB, idx);
      this._renderSummary();
    };
    rowA.addEventListener('transitionend', onEnd, { once: true });
    setTimeout(onEnd, 250); // fallback
  }

  _updateRowTime(row, newIdx) {
    let offsetMin = 0;
    for (let i = 0; i < newIdx; i++) offsetMin += this.items[i].duration || 0;
    const st = new Date(new Date(this.gapInfo.lastTime).getTime() + offsetMin * 60000);
    const tl = row.querySelector('.tig-tl-time');
    if (tl) tl.setText(fmtTime(st.toISOString()));
  }

  _renderSummary() {
    if (!this.summaryEl) return;
    this.summaryEl.empty();
    const allocated = this.allocatedMin;
    const remaining = this.totalGap - allocated;
    const over = allocated > this.totalGap;
    this.summaryEl.createSpan({
      text: over ? `⚠️ 已分配 ${fmtDuration(allocated)} ｜ 超出 ${fmtDuration(-remaining)}`
        : remaining > 0 ? `已分配 ${fmtDuration(allocated)} ｜ 剩余 ${fmtDuration(remaining)}（将记为未记录）`
        : `已分配 ${fmtDuration(allocated)} ✅`,
      cls: 'tig-split-stats' + (over ? ' tig-split-over' : '')
    });
    if (this.confirmBtn) {
      if (over) { this.confirmBtn.disabled = true; this.confirmBtn.addClass('tig-split-disabled'); }
      else { this.confirmBtn.disabled = false; this.confirmBtn.removeClass('tig-split-disabled'); }
    }
  }

  onClose() { this.contentEl.empty(); }
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
        const dm = this.plugin.dataManager;
        const existing = dm.findProjectByName(name);
        if (existing.length > 0) {
          const locations = existing.map(e => e.parentPath || '根目录').join('、');
          if (!confirm(`已有同名项目「${name}」在「${locations}」。\n确认重复添加？`)) return;
        }
        await dm.addProject(name, null, color, situation);
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
    this.treeViewMode = this.plugin.settings.treeDefaultView || 'situation';
    this.logDate = today(); // 日志查看日期
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
      }, 15000);
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
    container.empty();

    const header = container.createDiv('tig-section-header');
    header.createEl('div', { text: '🌳 人生之树', cls: 'tig-section-title' });
    
    // 视图切换按钮
    const modeBtns = header.createDiv('tig-mode-btns');
    const hierBtn = modeBtns.createEl('button', { text: '🌿', cls: 'tig-btn tig-btn-sm' + (this.treeViewMode === 'hierarchy' ? ' tig-mode-active' : ''), attr: { title: '按层级' } });
    const sitBtn = modeBtns.createEl('button', { text: '📂', cls: 'tig-btn tig-btn-sm' + (this.treeViewMode === 'situation' ? ' tig-mode-active' : ''), attr: { title: '按情景' } });
    hierBtn.addEventListener('click', () => { this.treeViewMode = 'hierarchy'; this.renderTreePanel(); });
    sitBtn.addEventListener('click', () => { this.treeViewMode = 'situation'; this.renderTreePanel(); });
    
    const addBtn = header.createEl('button', { text: '+ 新项目', cls: 'tig-btn tig-btn-sm' });
    addBtn.addEventListener('click', () => {
      new ProjectEditModal(this.app, this.plugin, null, () => this.renderTreePanel()).open();
    });

    if (this.treeViewMode === 'situation') {
      this._renderSitTreePanel(container, dm);
      return;
    }

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

  _renderSitTreePanel(container, dm) {
    const projects = dm.getProjects();
    if (projects.length === 0) {
      container.createEl('p', { text: '🌱 创建你的第一个项目吧', cls: 'tig-empty' });
      return;
    }

    const situations = Object.keys(this.plugin.settings.situationColors || SITUATION_COLORS);
    const sitMap = new Map();
    for (const p of projects) {
      const sit = p.situation || this.plugin.settings.defaultSituation || '默认';
      if (!sitMap.has(sit)) sitMap.set(sit, []);
      sitMap.get(sit).push(p);
    }

    const sortedSits = [...sitMap.keys()].sort((a, b) => {
      const ia = situations.indexOf(a), ib = situations.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b, 'zh-CN');
    });

    this.treeEl = container.createDiv('tig-tree');
    for (const sit of sortedSits) {
      const projs = sitMap.get(sit);
      const sitTotal = projs.reduce((s, p) => s + dm.getProjectTotalMinutes(p.id), 0);
      const color = this.plugin.settings.situationColors?.[sit] || SITUATION_COLORS[sit] || '#9E9E9E';
      
      const sitHeader = this.treeEl.createDiv('tig-scene-header');
      const toggle = sitHeader.createSpan('tig-tree-toggle');
      toggle.setText('▶');
      const dot = sitHeader.createSpan('tig-color-dot');
      dot.style.backgroundColor = color;
      const label = sitHeader.createSpan('tig-scene-label');
      label.setText(`${sit}（${projs.length}）`);
      const sitDur = sitHeader.createSpan('tig-scene-dur');
      sitDur.setText(fmtDuration(sitTotal));
      
      const sitBody = this.treeEl.createDiv('tig-scene-body');
      sitBody.style.display = 'none';
      
      sitHeader.addEventListener('click', () => {
        const hidden = sitBody.style.display === 'none';
        sitBody.style.display = hidden ? 'block' : 'none';
        toggle.setText(hidden ? '▼' : '▶');
      });
      
      for (const p of projs) {
        this._renderTreeNode(sitBody, { ...p, children: [], totalMinutes: dm.getProjectTotalMinutes(p.id) }, 0);
      }
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
    const nodeColor = (node.situation && this.plugin.settings.situationColors[node.situation]) || node.color || '#9E9E9E';
    dot.style.backgroundColor = nodeColor;

    row.createSpan({ text: node.name, cls: 'tig-tree-name' });
    row.createSpan({ text: fmtDuration(node.totalMinutes), cls: 'tig-tree-dur' });

    // 操作按钮
    const actions = row.createSpan('tig-tree-actions');
    const recBtn = actions.createEl('button', { text: '🐾', cls: 'tig-action-btn', attr: { title: '记录' } });
    recBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.maybeRecord(node.id, () => {
        new Notice(`🐾 ${node.name}`);
        this.renderTreePanel();
      });
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
      const dayEntries = (this.plugin.data.entries || []).filter(x => fmtDate(x.endTime) === days[i] && x.projectId !== '__blank__');
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
    const entries = dm.getEntriesForStats(firstDay);
    const pm = {};
    for (const e of entries) {
      const p = dm.getProject(e.projectId); const k = p ? p.name : '(已删除)';
      pm[k] = (pm[k] || 0) + (e.duration || 0);
    }
    const totalMin = Object.values(pm).reduce((a,b)=>a+b,0);
    const sorted = Object.entries(pm).sort((a,b)=>b[1]-a[1]);
    const projects = dm.getProjects();
    const colors = sorted.map(([n]) => { const p = projects.find(pr => pr.name === n); return (p?.situation && this.plugin.settings.situationColors[p.situation]) || p?.color || '#9E9E9E'; });

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
    const entries = dm.getEntriesForStats(firstDay);
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

    // 按钮行
    const btnRow = section.createDiv('tig-btn-row');
    const recordBtn = btnRow.createEl('button', {
      text: '📝 记录此刻',
      cls: 'tig-btn tig-btn-primary'
    });
    recordBtn.addEventListener('click', () => {
      new QuickRecordModal(this.app, this.plugin, () => {
        this.updateStepTimer();
        this.refreshLog();
      }).open();
    });
    // 空白记录（只推进时间，不归属任何项目）
    const blankBtn = btnRow.createEl('button', {
      text: '⬜ 空白',
      cls: 'tig-btn tig-btn-sm',
      attr: { title: '遗忘/不想记录的时间' }
    });
    blankBtn.addEventListener('click', async () => {
      await this.plugin.dataManager.recordBlankEntry();
      this.updateStepTimer();
      this.refreshLog();
      new Notice('⬜ 已跳过这段时间');
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

    // 新项目（名称 + 情境）
    const newRow = section.createDiv('tig-new-row');
    const input = newRow.createEl('input', {
      type: 'text',
      placeholder: '项目名称',
      cls: 'tig-input'
    });
    const sitSelect = newRow.createEl('select', { cls: 'tig-input' });
    sitSelect.style.maxWidth = '80px';
    const situations = Object.keys(this.plugin.settings.situationColors || SITUATION_COLORS);
    situations.forEach(s => { const opt = sitSelect.createEl('option', { text: s }); opt.value = s; });
    sitSelect.value = this.plugin.settings.defaultSituation || '默认';

    const addBtn = newRow.createEl('button', {
      text: '+',
      cls: 'tig-btn tig-btn-sm'
    });

    const doAdd = async () => {
      const name = input.value.trim();
      if (!name) return;
      const dm = this.plugin.dataManager;
      const existing = dm.findProjectByName(name);
      if (existing.length > 0) {
        const locations = existing.map(e => e.parentPath || '根目录').join('、');
        if (!confirm(`已有同名项目「${name}」在「${locations}」。\n确认重复添加？`)) return;
      }
      const situation = sitSelect.value;
      const color = this.plugin.settings.situationColors[situation] || '#9E9E9E';
      await dm.addProject(name, null, color, situation);
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

    const projects = this.plugin.dataManager.getRecentProjects(5);

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

      // 点击记录（长间隔自动分账）
      row.addEventListener('click', () => {
        this.plugin.maybeRecord(p.id, () => {
          this.updateStepTimer();
          this.refreshLog();
          if (this.plugin.dataManager.getGapInfo().isLongGap) {
            // 分账面板已处理，不重复通知
          }
        });
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
          this.refreshLog();
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
        this.refreshLog();
        new Notice(`已删除项目「${project.name}」`);
      })
    );

    menu.showAtMouseEvent(event);
  }

  buildTodayLog(container) {
    const section = container.createDiv('tig-section');
    const headerRow = section.createDiv('tig-section-header');
    const isToday = this.logDate === today();
    headerRow.createEl('div', { text: isToday ? '📋 今日时间日志' : `📋 ${this.logDate} 日志`, cls: 'tig-section-title' });
    
    // 日期导航（历史回顾）
    const navBtns = headerRow.createSpan('tig-log-nav');
    const prevBtn = navBtns.createEl('button', { text: '◀', cls: 'tig-btn tig-btn-sm', attr: { title: '前一天' } });
    const todayBtn = navBtns.createEl('button', { text: '今天', cls: 'tig-btn tig-btn-sm' });
    const nextBtn = navBtns.createEl('button', { text: '▶', cls: 'tig-btn tig-btn-sm', attr: { title: '后一天' } });
    if (isToday) nextBtn.addClass('tig-btn-disabled');
    prevBtn.addEventListener('click', () => { const d = new Date(this.logDate + 'T00:00:00'); d.setDate(d.getDate() - 1); this.logDate = fmtDateLocal(d); this.renderPanel('timer'); });
    nextBtn.addEventListener('click', () => { const d = new Date(this.logDate + 'T00:00:00'); d.setDate(d.getDate() + 1); const nd = fmtDateLocal(d); if (nd <= today()) { this.logDate = nd; this.renderPanel('timer'); } });
    todayBtn.addEventListener('click', () => { this.logDate = today(); this.renderPanel('timer'); });

    const addNoteBtn = headerRow.createEl('button', {
      text: '+ 手动记',
      cls: 'tig-btn tig-btn-sm'
    });
    addNoteBtn.addEventListener('click', () => {
      new QuickRecordModal(this.app, this.plugin, () => {
        this.refreshLog();
      }).open();
    });

    this.logEl = section.createDiv('tig-log-list');
    this.refreshLog();
  }

  refreshLog() {
    if (!this.logEl) return;
    this.logEl.empty();

    const dm = this.plugin.dataManager;
    const sortedEntries = dm.getEntriesByDate(this.logDate);

    if (sortedEntries.length === 0) {
      const isToday = this.logDate === today();
      this.logEl.createEl('p', { text: isToday ? '今天还没有记录' : `${this.logDate} 没有记录`, cls: 'tig-empty' });
      return;
    }

    const newestFirst = this.plugin.settings.timelineOrder === 'newest-first';
    const dayStart = new Date(this.logDate + 'T00:00:00');
    const isToday = this.logDate === today();
    const dayEnd = isToday ? new Date() : new Date(this.logDate + 'T23:59:59');

    // 构建时间线：entries + gaps → segments 数组
    const segments = [];
    let prevEnd = dayStart;
    for (const e of sortedEntries) {
      const st = new Date(e.startTime);
      const et = new Date(e.endTime);
      // 钳制到当天范围（跨日事件只显示当天部分）
      const clampSt = st < dayStart ? dayStart : st;
      const clampEt = et > dayEnd ? dayEnd : et;
      if (clampSt > prevEnd) {
        const gapMin = Math.round((clampSt - prevEnd) / 60000);
        if (gapMin >= 1) segments.push({ type: 'gap', start: new Date(prevEnd), end: new Date(clampSt), duration: gapMin });
      }
      const clampedDur = Math.round((clampEt - clampSt) / 60000);
      if (clampedDur >= 1) segments.push({ type: 'entry', entry: e, start: clampSt, end: clampEt, duration: clampedDur });
      prevEnd = clampEt > prevEnd ? clampEt : prevEnd;
    }
    // 合并相邻同项目条目
    const merged = [];
    for (const seg of segments) {
      const last = merged[merged.length - 1];
      if (last && last.type === 'entry' && seg.type === 'entry' && last.entry.projectId === seg.entry.projectId) {
        last.end = seg.end;
        last.duration += seg.duration;
      } else {
        merged.push(seg);
      }
    }
    segments.length = 0; segments.push(...merged);

    // 今天不显示末尾间隙（未记录时间属于脚步计时池，非待分配）
    if (prevEnd < dayEnd && !isToday) {
      const gapMin = Math.round((dayEnd - prevEnd) / 60000);
      if (gapMin >= 1) segments.push({ type: 'gap', start: new Date(prevEnd), end: dayEnd, duration: gapMin });
    }

    if (newestFirst) segments.reverse();

    // 渲染竖轴
    const tl = this.logEl.createDiv('tig-timeline');
    if (newestFirst) tl.addClass('tig-tl-newest-first');

    // 计算全天最长事件时长（用于左边框比例）
    const maxDur = Math.max(...segments.filter(s => s.type === 'entry').map(s => s.duration), 1);
    let totalDay = 0;

    // ── 构建当前时间条（今日专属） ──
    // 新到旧模式：插在 segments 之前（紧跟最新事件之后，显示在顶部）
    // 旧到新模式：插在 segments 之后（end label 之前，显示在底部）
    let nowBarEl = null;
    if (isToday && segments.length > 0) {
      const nowTime = new Date();
      const targetIdx = newestFirst ? 0 : segments.length - 1;
      const targetSeg = segments[targetIdx];
      if (targetSeg.type === 'entry' && targetSeg.end && nowTime > targetSeg.end) {
        const nowDur = Math.round((nowTime - new Date(targetSeg.end)) / 60000);
        if (nowDur >= 1) {
          totalDay += nowDur;
          const nowRow = tl.createDiv('tig-tl-row');
          nowRow.createDiv('tig-tl-time').setText(fmtTime(targetSeg.end.toISOString()));
          const nowCard = nowRow.createDiv('tig-tl-card tig-tl-now-bar');
          const barFill = nowCard.createDiv('tig-tl-bar-fill');
          barFill.style.height = '100%';
          barFill.style.backgroundColor = 'var(--text-muted)';
          barFill.addClass('tig-tl-bar-full');
          nowCard.addClass('tig-tl-now-active');
          nowCard.createSpan({ text: `⏳ ${fmtDuration(nowDur)}`, cls: 'tig-tl-now-text' });
          nowBarEl = nowRow;
        }
      }
    }

    for (const seg of segments) {
      const row = tl.createDiv('tig-tl-row');
      const timeLabel = row.createDiv('tig-tl-time');
      timeLabel.setText(fmtTime(seg.start.toISOString()));

      if (seg.type === 'gap') {
        const card = row.createDiv('tig-tl-card tig-tl-gap');
        card.createSpan({ text: `未记录 · ${fmtDuration(seg.duration)}`, cls: 'tig-tl-gap-text' });
        card.createSpan({ text: '点击分配', cls: 'tig-tl-gap-hint' });
        card.addEventListener('click', () => {
          const gapInfo = { gapMinutes: seg.duration, isLongGap: seg.duration > 30, lastTime: seg.start.toISOString(), now: seg.end.toISOString() };
          // 间隙点击：不预设主项目，纯靠智能推荐
          new SplitRecordModal(this.app, this.plugin, gapInfo, null, () => { this.renderPanel('timer'); }, seg.start.toISOString()).open();
        });
      } else {
        const e = seg.entry;
        const segDur = seg.duration || e.duration || 0;
        totalDay += segDur;
        const p = e.projectId === '__blank__' ? null : dm.getProject(e.projectId);
        const sitColor = p?.color || '#9E9E9E';

        const card = row.createDiv('tig-tl-card');
        const fillPct = Math.round((segDur / maxDur) * 100);
        const barFill = card.createDiv('tig-tl-bar-fill');
        barFill.style.height = fillPct + '%';
        barFill.style.backgroundColor = sitColor;
        if (fillPct >= 95) barFill.addClass('tig-tl-bar-full');
        card.createSpan({ text: p?.name || '(已删除)', cls: 'tig-tl-name' });
        card.createSpan({ text: fmtDuration(segDur), cls: 'tig-tl-dur' });
        card.addEventListener('click', (evt) => { this._editLogEntry(e, evt); });
      }
    }

    // 旧到新模式：now bar 移到 segments 之后、end label 之前
    if (!newestFirst && nowBarEl) {
      tl.appendChild(nowBarEl);
    }

    // 结尾时间标记
    const lastRow = tl.createDiv('tig-tl-row');
    const endLabel = newestFirst ? '00:00' : (isToday ? '现在' : '24:00');
    lastRow.createDiv('tig-tl-time').setText(endLabel);

    // 总计
    const totalRow = this.logEl.createDiv('tig-log-total');
    totalRow.createSpan({ text: '今日总计' });
    totalRow.createSpan({ text: fmtDuration(totalDay), cls: 'tig-log-total-dur' });
  }

  _editLogEntry(entry, evt) {
    const dm = this.plugin.dataManager;
    const menu = new Menu();
    const projects = dm.getProjects();

    // 标题：正在编辑的条目
    const p = dm.getProject(entry.projectId);
    menu.addItem(item => item
      .setTitle(`✏️ 编辑: ${p?.name || '条目'} ${fmtDuration(entry.duration || 0)}`)
      .setDisabled(true));

    menu.addItem(item => item.setTitle('⏰ 改时间').setIcon('clock').onClick(() => {
      this._showTimeEdit(entry);
    }));

    menu.addSeparator();
    menu.addItem(item => item.setTitle('📝 改项目').setIcon('pencil'));
    for (const p of projects) {
      menu.addItem(item => item
        .setTitle(p.name === (dm.getProject(entry.projectId)?.name || '') ? `  ✅ ${p.name}` : `  ${p.name}`)
        .onClick(async () => {
          entry.projectId = p.id;
          await this._saveEntryEdit(entry);
        }));
    }
    menu.addSeparator();
    ['-15m', '+15m', '-30m', '+30m'].forEach(adj => {
      const delta = parseInt(adj);
      menu.addItem(item => item
        .setTitle(`${delta > 0 ? '+' : ''}${delta}分钟`)
        .onClick(async () => {
          entry.duration = Math.max(15, (entry.duration || 0) + delta);
          entry.endTime = new Date(new Date(entry.startTime).getTime() + entry.duration * 60000).toISOString();
          await this._saveEntryEdit(entry);
        }));
    });
    menu.addSeparator();
    menu.addItem(item => item.setTitle('🗑️ 删除').setIcon('trash').onClick(async () => {
      await this._deleteLogEntry(entry);
    }));
    menu.showAtMouseEvent(evt);
  }

  _showTimeEdit(entry) {
    const modal = new Modal(this.app);
    modal.contentEl.addClass('tig-time-edit');
    modal.contentEl.createEl('h4', { text: '编辑时间' });

    const startD = new Date(entry.startTime);
    const endD = new Date(entry.endTime);
    const sdStr = fmtDate(entry.startTime);
    const edStr = fmtDate(entry.endTime);

    // 开始日期 + 时间
    const row0 = modal.contentEl.createDiv('tig-time-row');
    row0.createSpan({ text: '开始' });
    const sd = row0.createEl('input', { type: 'date', cls: 'tig-time-inp', attr: { value: sdStr } });
    const sh = row0.createEl('input', { type: 'number', cls: 'tig-time-inp', attr: { min:'0', max:'23', value: String(startD.getHours()) } });
    row0.createSpan({ text: ':' });
    const sm = row0.createEl('input', { type: 'number', cls: 'tig-time-inp', attr: { min:'0', max:'59', value: String(startD.getMinutes()).padStart(2,'0') } });

    // 结束日期 + 时间
    const row2 = modal.contentEl.createDiv('tig-time-row');
    row2.createSpan({ text: '结束' });
    const ed = row2.createEl('input', { type: 'date', cls: 'tig-time-inp', attr: { value: edStr } });
    const eh = row2.createEl('input', { type: 'number', cls: 'tig-time-inp', attr: { min:'0', max:'23', value: String(endD.getHours()) } });
    row2.createSpan({ text: ':' });
    const em = row2.createEl('input', { type: 'number', cls: 'tig-time-inp', attr: { min:'0', max:'59', value: String(endD.getMinutes()).padStart(2,'0') } });

    const durEl = modal.contentEl.createDiv('tig-time-dur');
    durEl.setText(`时长: ${fmtDuration(entry.duration)}`);

    const updateDur = () => {
      const s = new Date(sd.value + 'T' + String(sh.value).padStart(2,'0') + ':' + String(sm.value).padStart(2,'0') + ':00');
      const e = new Date(ed.value + 'T' + String(eh.value).padStart(2,'0') + ':' + String(em.value).padStart(2,'0') + ':00');
      const d = Math.round((e - s) / 60000);
      durEl.setText(`时长: ${d > 0 ? fmtDuration(d) : '⚠️ 无效'}`);
    };
    [sd, sh, sm, ed, eh, em].forEach(el => el.addEventListener('input', updateDur));

    const btnRow = modal.contentEl.createDiv('tig-split-btns');
    const saveBtn = btnRow.createEl('button', { text: '保存', cls: 'tig-split-confirm' });
    saveBtn.addEventListener('click', async () => {
      const s = new Date(sd.value + 'T' + String(sh.value).padStart(2,'0') + ':' + String(sm.value).padStart(2,'0') + ':00');
      const e = new Date(ed.value + 'T' + String(eh.value).padStart(2,'0') + ':' + String(em.value).padStart(2,'0') + ':00');
      const d = Math.round((e - s) / 60000);
      if (d <= 0) { new Notice('结束时间必须在开始时间之后'); return; }
      entry.startTime = s.toISOString();
      entry.endTime = e.toISOString();
      entry.duration = d;
      await this._saveEntryEdit(entry);
      modal.close();
    });
    const cancelBtn = btnRow.createEl('button', { text: '取消', cls: 'tig-split-skip' });
    cancelBtn.addEventListener('click', () => modal.close());

    modal.open();
  }

  async _saveEntryEdit(entry) {
    const dm = this.plugin.dataManager;
    const all = dm.data.entries || [];
    const idx = all.findIndex(e => e.id === entry.id);
    if (idx !== -1) {
      all[idx] = entry;
      dm.data.entries = all;
    }
    await this.plugin.saveData();
    // 全量刷新：时间轴 + 日志列表 + 今日总计 + 脚步计时
    this.renderPanel('timer');
  }

  async _deleteLogEntry(entry) {
    const entries = (this.plugin.data.entries || []).filter(e => e.id !== entry.id);
    this.plugin.data.entries = entries;
    // 如果删除的是最后一条，更新 lastRecordTime
    if (entries.length === 0) {
      this.plugin.data.lastRecordTime = null;
    } else {
      this.plugin.data.lastRecordTime = entries[entries.length - 1].endTime;
    }
    await this.plugin.saveData();
    this.renderPanel('timer');
    new Notice('已删除');
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
    this.viewMode = this.plugin.settings.treeDefaultView || 'situation';
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
      
      // 视图切换按钮组
      const modeBtns = header.createDiv('tig-mode-btns');
      const hierBtn = modeBtns.createEl('button', { text: '🌿', cls: 'tig-btn tig-btn-sm tig-mode-active', attr: { title: '按层级' } });
      const sitBtn = modeBtns.createEl('button', { text: '📂', cls: 'tig-btn tig-btn-sm', attr: { title: '按情景' } });
      hierBtn.addEventListener('click', () => {
        this.viewMode = 'hierarchy';
        hierBtn.addClass('tig-mode-active');
        sitBtn.removeClass('tig-mode-active');
        this.refreshTree();
      });
      sitBtn.addEventListener('click', () => {
        this.viewMode = 'situation';
        sitBtn.addClass('tig-mode-active');
        hierBtn.removeClass('tig-mode-active');
        this.refreshTree();
      });
      
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

    if (this.viewMode === 'situation') {
      this._renderSitTree();
      return;
    }

    // 默认：层级视图
    const tree = this.plugin.dataManager.getProjectTree(null);

    if (tree.length === 0) {
      this.treeEl.createEl('p', { text: '🌱 创建你的第一个项目吧', cls: 'tig-empty' });
      return;
    }

    for (const node of tree) {
      this.renderTreeNode(this.treeEl, node, 0);
    }
  }

  // ── 情景分组视图 ──
  _renderSitTree() {
    const dm = this.plugin.dataManager;
    const projects = dm.getProjects();
    
    if (projects.length === 0) {
      this.treeEl.createEl('p', { text: '🌱 创建你的第一个项目吧', cls: 'tig-empty' });
      return;
    }

    const situations = Object.keys(this.plugin.settings.situationColors || SITUATION_COLORS);
    const sitMap = new Map();
    for (const p of projects) {
      const sit = p.situation || this.plugin.settings.defaultSituation || '默认';
      if (!sitMap.has(sit)) sitMap.set(sit, []);
      sitMap.get(sit).push(p);
    }

    const sortedSits = [...sitMap.keys()].sort((a, b) => {
      const ia = situations.indexOf(a), ib = situations.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b, 'zh-CN');
    });

    for (const sit of sortedSits) {
      const projs = sitMap.get(sit);
      const sitTotal = projs.reduce((s, p) => s + dm.getProjectTotalMinutes(p.id), 0);
      const color = this.plugin.settings.situationColors?.[sit] || SITUATION_COLORS[sit] || '#9E9E9E';
      
      const sitHeader = this.treeEl.createDiv('tig-scene-header');
      const toggle = sitHeader.createSpan('tig-tree-toggle');
      toggle.setText('▶');
      const dot = sitHeader.createSpan('tig-color-dot');
      dot.style.backgroundColor = color;
      const label = sitHeader.createSpan('tig-scene-label');
      label.setText(`${sit}（${projs.length}）`);
      const sitDur = sitHeader.createSpan('tig-scene-dur');
      sitDur.setText(fmtDuration(sitTotal));
      
      const sitBody = this.treeEl.createDiv('tig-scene-body');
      sitBody.style.display = 'none';
      
      sitHeader.addEventListener('click', () => {
        const hidden = sitBody.style.display === 'none';
        sitBody.style.display = hidden ? 'block' : 'none';
        toggle.setText(hidden ? '▼' : '▶');
      });
      
      for (const p of projs) {
        this.renderTreeNode(sitBody, { ...p, children: [], totalMinutes: dm.getProjectTotalMinutes(p.id) }, 0);
      }
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
    const nodeColor2 = (node.situation && this.plugin.settings.situationColors[node.situation]) || node.color || '#9E9E9E';
    dot.style.backgroundColor = nodeColor2;

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
    this.statsDate = today(); // 当前查看的日期
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
    // 日期导航
    const navRow = container.createDiv('tig-stats-nav');
    const prevBtn = navRow.createEl('button', { text: '◀', cls: 'tig-stats-nav-btn', attr: { title: '前一天' } });
    const dateEl = navRow.createEl('span', { text: this.statsDate, cls: 'tig-stats-nav-date' });
    const nextBtn = navRow.createEl('button', { text: '▶', cls: 'tig-stats-nav-btn', attr: { title: '后一天' } });
    const todayBtn = navRow.createEl('button', { text: '今天', cls: 'tig-stats-nav-today' });

    const navigate = (days) => {
      const d = new Date(this.statsDate + 'T00:00:00'); d.setDate(d.getDate() + days);
      this.statsDate = fmtDateLocal(d);
      dateEl.setText(this.statsDate);
      this.renderActiveTab();
    };
    prevBtn.addEventListener('click', () => navigate(-1));
    nextBtn.addEventListener('click', () => navigate(1));
    todayBtn.addEventListener('click', () => { this.statsDate = today(); dateEl.setText(this.statsDate); this.renderActiveTab(); });
    dateEl.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'date'; input.value = this.statsDate;
      input.style.cssText = 'width:130px;margin:0 8px';
      dateEl.replaceWith(input); input.focus();
      input.addEventListener('change', () => { this.statsDate = input.value; input.replaceWith(dateEl); dateEl.setText(this.statsDate); this.renderActiveTab(); });
      input.addEventListener('blur', () => { input.replaceWith(dateEl); });
    });
    dateEl.style.cursor = 'pointer';
    dateEl.title = '点击选择日期';

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
    const monday = getMonday(new Date(this.statsDate));
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
    const firstDay = getFirstOfMonth(new Date(this.statsDate));
    const entries = dm.getEntriesForStats(firstDay);
    const pm = {};
    for (const e of entries) {
      const p = dm.getProject(e.projectId); const k = p ? p.name : '(已删除)';
      pm[k] = (pm[k] || 0) + (e.duration || 0);
    }
    const totalMin = Object.values(pm).reduce((a,b)=>a+b,0);
    const sorted = Object.entries(pm).sort((a,b)=>b[1]-a[1]);
    const projects = dm.getProjects();
    const colors = sorted.map(([n]) => { const p = projects.find(pr => pr.name === n); return (p?.situation && this.plugin.settings.situationColors[p.situation]) || p?.color || '#9E9E9E'; });
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
    const entries = dm.getEntriesForStats(firstDay);
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
//  WebDAV 客户端（桌面端专属，Node.js http 模块）
// ═══════════════════════════════════════════

class WebDAVClient {
  constructor(settings) {
    this.url = settings.webdavUrl || '';
    this.username = settings.webdavUsername || '';
    this.password = settings.webdavPassword || '';
  }

  _authHeaders() {
    const headers = {};
    if (this.username || this.password) {
      const encoded = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  _request(method, body = null) {
    return new Promise((resolve, reject) => {
      try {
        const http = require('http');
        const https = require('https');
        const parsed = new URL(this.url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const headers = { ...this._authHeaders() };
        if (body) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(body).toString();
        }

        const req = mod.request({
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers,
          timeout: 10000
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, data, headers: res.headers });
            } else {
              resolve({ status: res.statusCode, data, headers: res.headers, error: `HTTP ${res.statusCode}` });
            }
          });
        });

        req.on('error', (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });

        if (body) req.write(body);
        req.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  /** GET 远程数据，返回解析后的 JSON 或 null */
  async getRemoteData() {
    try {
      const result = await this._request('GET');
      if (result.error || !result.data) return null;
      const parsed = JSON.parse(result.data);
      if (!parsed || typeof parsed !== 'object') return null;
      // 读取远程文件的时间戳
      const lastModified = result.headers['last-modified'];
      const remoteTime = lastModified ? new Date(lastModified).getTime() : Date.now();
      return { ...parsed, _remoteTime: remoteTime };
    } catch (e) {
      console.warn('时迹 WebDAV GET 失败:', e.message);
      return null;
    }
  }

  /** PUT 本地数据到远程，返回是否成功 */
  async putData(data) {
    try {
      const body = JSON.stringify({
        projects: data.projects || [],
        entries: data.entries || [],
        lastRecordTime: data.lastRecordTime || null
      }, null, 2);
      const result = await this._request('PUT', body);
      return !result.error;
    } catch (e) {
      console.warn('时迹 WebDAV PUT 失败:', e.message);
      return false;
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

    new Setting(containerEl)
      .setName('时间轴方向')
      .setDesc('日志列表的排列顺序')
      .addDropdown(dropdown => dropdown
        .addOption('newest-first', '新→旧 (24:00→00:00)')
        .addOption('oldest-first', '旧→新 (00:00→24:00)')
        .setValue(this.plugin.settings.timelineOrder || 'newest-first')
        .onChange(async (value) => {
          this.plugin.settings.timelineOrder = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        }));

    new Setting(containerEl)
      .setName('项目树默认视图')
      .setDesc('打开项目树时的默认分组方式')
      .addDropdown(dropdown => dropdown
        .addOption('situation', '按情景')
        .addOption('hierarchy', '按层级')
        .setValue(this.plugin.settings.treeDefaultView || 'situation')
        .onChange(async (value) => {
          this.plugin.settings.treeDefaultView = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
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

  _buildSituationEditor() {
    const containerEl = this.containerEl;
    const colors = this.plugin.settings.situationColors || {};
    const sitContainer = containerEl.createDiv('tig-sit-editor');

    for (const [name, color] of Object.entries(colors)) {
      const row = sitContainer.createDiv('tig-sit-row');
      row.createSpan({ text: name, cls: 'tig-sit-name' });
      const picker = row.createEl('input', { type: 'color', cls: 'tig-sit-picker' });
      picker.value = color;
      picker.addEventListener('input', async () => {
        this.plugin.settings.situationColors[name] = picker.value;
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
      });
      const delBtn = row.createEl('button', { text: '✕', cls: 'tig-sit-del' });
      delBtn.addEventListener('click', async () => {
        if (Object.keys(this.plugin.settings.situationColors).length <= 1) {
          new Notice('⚠️ 至少保留一个情境');
          return;
        }
        delete this.plugin.settings.situationColors[name];
        await this.plugin.saveSettings();
        this.plugin.refreshAllViews();
        new Notice(`🗑️ 已删除情境「${name}」`);
        containerEl.removeChild(sitContainer);
        this._buildSituationEditor();
      });
    }

    const addRow = sitContainer.createDiv('tig-sit-row tig-sit-add-row');
    const newNameInput = addRow.createEl('input', { type: 'text', placeholder: '新情境名', cls: 'tig-input tig-sit-new-name' });
    const newPicker = addRow.createEl('input', { type: 'color', cls: 'tig-sit-picker' });
    newPicker.value = '#9E9E9E';
    const addBtn = addRow.createEl('button', { text: '+ 添加', cls: 'tig-btn tig-btn-sm' });
    const doAdd = async () => {
      const n = newNameInput.value.trim();
      if (!n) { new Notice('⚠️ 请输入情境名称'); return; }
      if (this.plugin.settings.situationColors[n]) { new Notice(`⚠️ 情境「${n}」已存在`); return; }
      this.plugin.settings.situationColors[n] = newPicker.value;
      await this.plugin.saveSettings();
      new Notice(`✅ 已添加情境「${n}」`);
      newNameInput.value = '';
      containerEl.removeChild(sitContainer);
      this._buildSituationEditor();
    };
    addBtn.addEventListener('click', doAdd);
    newNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

    const resetRow = sitContainer.createDiv('tig-sit-reset-row');
    const resetBtn = resetRow.createEl('button', { text: '🔄 重置为默认情景', cls: 'tig-btn tig-btn-sm' });
    resetBtn.style.color = 'var(--text-error)';
    resetBtn.addEventListener('click', async () => {
      const modal = new (require('obsidian').Modal)(this.app);
      modal.titleEl.setText('⚠️ 重置情景颜色');
      modal.contentEl.createEl('p', { text: '将删除所有当前情景，已有项目颜色变为灰色（重建同名情景自动恢复）。确定重置？' });
      const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });
      const confirmed = await new Promise(resolve => {
        btnRow.createEl('button', { text: '取消' }).addEventListener('click', () => { modal.close(); resolve(false); });
        const confirmBtn = btnRow.createEl('button', { text: '确认重置', cls: 'mod-cta' });
        confirmBtn.style.backgroundColor = 'var(--text-error)';
        confirmBtn.addEventListener('click', () => { modal.close(); resolve(true); });
        modal.open();
      });
      if (!confirmed) return;
      this.plugin.settings.situationColors = { ...SITUATION_COLORS };
      await this.plugin.saveSettings();
      this.plugin.refreshAllViews();
      new Notice('🔄 已重置为默认情景');
      containerEl.removeChild(sitContainer);
      this._buildSituationEditor();
    });
  }

  async _buildFolderSetting(containerEl) {
    const current = this.plugin.settings.dataFolder || '时迹数据';

    const doSave = async (folder) => {
      folder = folder.trim();
      if (!folder || folder === this.plugin.settings.dataFolder) return;
      const old = this.plugin.settings.dataFolder;
      this.plugin.settings.dataFolder = folder;
      await this.plugin.saveSettings();
      if (old !== folder) {
        await this.plugin.loadSharedData();
        this.plugin.refreshAllViews();
        new Notice(`✅ 数据已迁移到「${folder}/」`);
      }
    };

    // 收集 Vault 一级文件夹
    const topFolders = new Set(['时迹数据']);
    try {
      const result = await this.app.vault.adapter.list('/');
      for (const name of (result.folders || [])) {
        const clean = name.replace(/\/$/, '');
        if (clean && !clean.startsWith('.')) topFolders.add(clean);
      }
    } catch(e) { /* 忽略 */ }
    if (current && !current.includes('/')) topFolders.add(current);
    const sorted = [...topFolders].sort();

    // 合并控件：文本输入 + 下拉填充 + 保存按钮
    const setting = new Setting(containerEl)
      .setName('数据文件夹')
      .setDesc('输入路径（支持考研/自律），或从下拉选一级文件夹填充')
      .addText(text => {
        text.setPlaceholder('时迹数据').setValue(current);
        text.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); doSave(text.inputEl.value); }
        });
        return text;
      })
      .addDropdown(dropdown => {
        dropdown.addOption('', '— 选文件夹填充 —');
        for (const f of sorted) dropdown.addOption(f, f);
        dropdown.setValue('');
        dropdown.onChange((value) => {
          if (!value) return;
          const input = setting.controlEl.querySelector('input');
          if (input) { input.value = value; input.focus(); }
        });
        return dropdown;
      })
      .addButton(btn => btn
        .setButtonText('保存')
        .setCta()
        .onClick(() => {
          const input = setting.controlEl.querySelector('input');
          if (input) doSave(input.value);
        }));

    // ── 情境颜色编辑器（新增/编辑/删除/重置） ──
    containerEl.createEl('h3', { text: '🎨 情境颜色' });
    containerEl.createEl('p', { text: '新增、编辑、删除情境。删除或重置后，已有项目的颜色变为灰色，重建同名情境自动恢复颜色。', cls: 'setting-item-description' });
    this._buildSituationEditor();

    // ── HTTP API ──
    containerEl.createEl('h3', { text: '🌐 HTTP API' });
    containerEl.createEl('p', { text: '开启后可通过 HTTP 接口远程记录（需 ZeroTier 局域网），See README', cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName('启用 HTTP Server')
      .setDesc('监听 0.0.0.0:18790，Bearer Token 认证')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.httpEnabled || false)
        .onChange(async (value) => {
          this.plugin.settings.httpEnabled = value;
          await this.plugin.saveSettings();
          if (value && this.plugin.settings.httpToken) {
            this.plugin._startHttpServer();
          } else {
            this.plugin._stopHttpServer();
          }
        }));

    new Setting(containerEl)
      .setName('API Token')
      .setDesc('所有请求需带 Authorization: Bearer <token>')
      .addText(text => text
        .setPlaceholder('输入 token...')
        .setValue(this.plugin.settings.httpToken || '')
        .onChange(async (value) => {
          this.plugin.settings.httpToken = value.trim();
          await this.plugin.saveSettings();
        }));

    // ── WebDAV 局域网同步 ──
    containerEl.createEl('h3', { text: '🔄 WebDAV 局域网同步' });
    containerEl.createEl('p', { text: '同步 time-traces.json 到 WebDAV 服务器（如 chezdav），实现局域网跨设备同步。桌面端专属。', cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName('启用 WebDAV 同步')
      .setDesc('保存时自动推送，启动时自动拉取')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.webdavEnabled || false)
        .onChange(async (value) => {
          this.plugin.settings.webdavEnabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('WebDAV URL')
      .setDesc('数据文件的完整 URL，如 http://192.168.1.100:8080/时迹数据/time-traces.json')
      .addText(text => text
        .setPlaceholder('http://192.168.1.100:8080/时迹/time-traces.json')
        .setValue(this.plugin.settings.webdavUrl || '')
        .onChange(async (value) => {
          this.plugin.settings.webdavUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('用户名')
      .setDesc('WebDAV 认证用户名（可选，chezdav 通常不需要）')
      .addText(text => text
        .setPlaceholder('留空则无认证')
        .setValue(this.plugin.settings.webdavUsername || '')
        .onChange(async (value) => {
          this.plugin.settings.webdavUsername = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('密码')
      .setDesc('WebDAV 认证密码（可选）')
      .addText(text => {
        text.setPlaceholder('留空则无认证')
          .setValue(this.plugin.settings.webdavPassword || '');
        text.inputEl.type = 'password';
        text.onChange(async (value) => {
          this.plugin.settings.webdavPassword = value;
          await this.plugin.saveSettings();
        });
        return text;
      });

    const syncStatusEl = containerEl.createEl('p', { text: this.plugin.settings.webdavLastSync
      ? `上次同步: ${new Date(this.plugin.settings.webdavLastSync).toLocaleString('zh-CN')}`
      : '尚未同步', cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName('手动同步')
      .setDesc('立即执行一次双向同步（先拉后推）')
      .addButton(btn => btn
        .setButtonText('🔄 立即同步')
        .onClick(async () => {
          if (isMobile(this.plugin)) {
            new Notice('⚠️ WebDAV 同步仅在桌面端可用');
            return;
          }
          if (!this.plugin.settings.webdavUrl) {
            new Notice('⚠️ 请先设置 WebDAV URL');
            return;
          }
          btn.setButtonText('同步中...');
          btn.setDisabled(true);
          try {
            const client = new WebDAVClient(this.plugin.settings);
            const result = await this.plugin._syncWithWebDAV(client);
            syncStatusEl.textContent = `上次同步: ${new Date().toLocaleString('zh-CN')} — ${result}`;
            new Notice(result);
          } catch (e) {
            syncStatusEl.textContent = `同步失败: ${e.message}`;
            new Notice('❌ 同步失败: ' + e.message);
          } finally {
            btn.setButtonText('🔄 立即同步');
            btn.setDisabled(false);
          }
        }));

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

    // ── WebDAV 拉取（启动时同步）──
    if (this.settings.webdavEnabled && this.settings.webdavUrl && !isMobile(this)) {
      const client = new WebDAVClient(this.settings);
      this._syncWithWebDAV(client).then(result => {
        console.log('🐾 时迹 WebDAV 启动同步:', result);
      }).catch(e => {
        console.warn('时迹 WebDAV 启动同步失败:', e.message);
      });
    }

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

    // ── HTTP API Server ──
    if (this.settings.httpEnabled && this.settings.httpToken) {
      this._startHttpServer();
    }
  }

  // 统一记录入口：检测长间隔自动弹分账面板
  maybeRecord(projectId, onDone) {
    const dm = this.dataManager;
    const gap = dm.getGapInfo();
    if (gap.isLongGap) {
      new SplitRecordModal(this.app, this, gap, projectId, onDone).open();
    } else {
      dm.recordEntry(projectId).then(entry => {
        new Notice(`🐾 ${dm.getProject(projectId)?.name || '项目'} — ${fmtDuration(entry.duration)}`);
        if (onDone) onDone();
      });
    }
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

    // ── 迁移旧文件名：time-is-gold.json → time-traces.json ──
    if (mode === 'vault' && !(await adapter.exists(relPath))) {
      const folder = this.settings?.dataFolder || '时迹数据';
      const oldPath = `${folder}/time-is-gold.json`;
      if (await adapter.exists(oldPath)) {
        const oldRaw = await adapter.read(oldPath);
        await adapter.write(relPath, oldRaw);
        console.log('🐾 时迹: 数据已从 time-is-gold.json 迁移到 time-traces.json');
      }
    }

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
          lastRecordTime: parsed.lastRecordTime || null,
          lastChainTime: parsed.lastChainTime || parsed.lastRecordTime || null
        };
        // 自动修复 lastRecordTime：取最新条目的 endTime
        if (this.data.entries.length > 0) {
          const latestEnd = this.data.entries.reduce((max, e) => e.endTime > max ? e.endTime : max, this.data.entries[0].endTime);
          if (!this.data.lastRecordTime || new Date(latestEnd) > new Date(this.data.lastRecordTime)) {
            this.data.lastRecordTime = latestEnd;
          }
        }
        // 兼容旧数据：lastChainTime 不存在时初始化为 lastRecordTime
        if (!this.data.lastChainTime) {
          this.data.lastChainTime = this.data.lastRecordTime;
        }
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
            lastRecordTime: parsed.lastRecordTime || null,
            lastChainTime: parsed.lastChainTime || parsed.lastRecordTime || null
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
            lastRecordTime: parsed.lastRecordTime || null,
            lastChainTime: parsed.lastChainTime || parsed.lastRecordTime || null
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

    // ── WebDAV 推送（保存后异步同步，不阻塞）──
    if (this.settings.webdavEnabled && this.settings.webdavUrl && !isMobile(this)) {
      const client = new WebDAVClient(this.settings);
      client.putData(this.data).then(ok => {
        if (ok) console.log('🐾 时迹 WebDAV 推送成功');
      }).catch(() => { /* 静默失败 */ });
    }
  }

  // 保存设置到 Vault 本地（永不丢失 dataLocation）
  async saveSettings() {
    return super.saveData({ settings: this.settings });
  }

  // ═══════════════════════════════════════════
  //  WebDAV 双向同步
  // ═══════════════════════════════════════════

  /** 合并远程数据到本地，返回合并后的 data */
  _mergeData(remote) {
    const local = this.data;
    const remoteProjects = remote.projects || [];
    const remoteEntries = remote.entries || [];
    const remoteLastRecord = remote.lastRecordTime || null;

    // 合并 projects（按 id 去重，远程新增的加入本地）
    const localProjectIds = new Set((local.projects || []).map(p => p.id));
    for (const rp of remoteProjects) {
      if (!localProjectIds.has(rp.id)) {
        local.projects.push(rp);
        localProjectIds.add(rp.id);
      }
    }

    // 合并 entries（按 id 去重 ∪）
    const localEntryIds = new Set((local.entries || []).map(e => e.id));
    const newEntries = [];
    for (const re of remoteEntries) {
      if (!localEntryIds.has(re.id)) {
        newEntries.push(re);
        localEntryIds.add(re.id);
      }
    }

    if (newEntries.length > 0) {
      local.entries = [...(local.entries || []), ...newEntries];
      // 按 startTime 排序
      local.entries.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    }

    // lastRecordTime 取最新
    if (remoteLastRecord && (!local.lastRecordTime || new Date(remoteLastRecord) > new Date(local.lastRecordTime))) {
      local.lastRecordTime = remoteLastRecord;
    }

    return local;
  }

  /** 执行双向同步：先拉后推。返回结果描述字符串 */
  async _syncWithWebDAV(client) {
    if (isMobile(this)) return '⚠️ 移动端不支持 WebDAV';

    // 1. 拉取远程数据
    const remote = await client.getRemoteData();
    if (!remote) return '⚠️ 服务器不可达';

    // 2. 比对：远程有本地没有的数据 → 合并
    const remoteEntries = remote.entries || [];
    const localEntryIds = new Set((this.data.entries || []).map(e => e.id));
    const newCount = remoteEntries.filter(e => !localEntryIds.has(e.id)).length;

    if (newCount > 0) {
      this._mergeData(remote);
      await this.saveData();
      this.refreshAllViews();
    }

    // 3. 推送到远程
    const ok = await client.putData(this.data);

    // 4. 记录同步时间
    this.settings.webdavLastSync = new Date().toISOString();
    await this.saveSettings();

    if (ok) {
      const msg = newCount > 0
        ? `✅ 同步完成（拉取 ${newCount} 条，推送成功）`
        : '✅ 同步完成';
      return msg;
    }
    return newCount > 0 ? `⚠️ 已拉取 ${newCount} 条，但推送失败` : '⚠️ 推送失败';
  }

  // ═══════════════════════════════════════════
  //  HTTP API Server（ZeroTier 局域网可达）
  // ═══════════════════════════════════════════

  _startHttpServer() {
    if (this._httpServer) return;
    try {
      const http = require('http');
      const port = 18790;
      this._httpServer = http.createServer((req, res) => this._handleApi(req, res));
      this._httpServer.listen(port, '0.0.0.0', () => {
        console.log(`🐾 时迹 API: http://0.0.0.0:${port}`);
      });
    } catch (e) {
      console.warn('时迹: HTTP Server 启动失败（移动端不支持）', e.message);
    }
  }

  _stopHttpServer() {
    if (this._httpServer) {
      this._httpServer.close();
      this._httpServer = null;
    }
  }

  _handleApi(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' });
      res.end(); return;
    }

    // 认证
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token !== this.settings.httpToken) {
      return send(401, { error: 'unauthorized' });
    }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/$/, '');
    const dm = this.dataManager;

    // 解析 body
    const readBody = () => new Promise(resolve => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    });

    // ── 路由 ──
    const route = async () => {
      try {
        if (req.method === 'POST' && path === '/record') {
          const b = await readBody();
          const pid = b.project && dm.findProjectByName(b.project)[0]?.id;
          if (!pid) return send(400, { error: 'project not found: ' + (b.project || '') });
          if (b.start && b.end) {
            await dm.recordGapEntry(pid, b.start, b.end, b.note || '');
          } else if (b.duration) {
            const start = new Date(Date.now() - b.duration * 60000);
            await dm.recordGapEntry(pid, start.toISOString(), new Date().toISOString(), b.note || '');
          } else {
            await dm.recordEntry(pid, b.note || '');
          }
          await this.saveData();
          this.refreshAllViews();
          return send(200, { ok: true });

        } else if (req.method === 'POST' && path === '/record/blank') {
          await dm.recordBlankEntry();
          await this.saveData();
          this.refreshAllViews();
          return send(200, { ok: true });

        } else if (req.method === 'POST' && path === '/project') {
          const b = await readBody();
          if (!b.name) return send(400, { error: 'name required' });
          const p = await dm.addProject(b.name, null, null, b.situation || null);
          return send(200, { project: p });

        } else if (req.method === 'DELETE' && path === '/record') {
          const id = url.searchParams.get('id');
          if (!id) return send(400, { error: 'id required as query param: /record?id=xxx' });
          const entry = (dm.data.entries || []).find(e => e.id === id);
          if (!entry) return send(404, { error: 'record not found: ' + id });
          dm.data.entries = (dm.data.entries || []).filter(e => e.id !== id);
          // 删除后更新指针：取剩余 entries 中最新的 endTime
          if (dm.data.entries.length === 0) {
            dm.data.lastRecordTime = null;
            dm.data.lastChainTime = null;
          } else {
            const latestEnd = dm.data.entries.reduce((max, e) => e.endTime > max ? e.endTime : max, dm.data.entries[0].endTime);
            dm.data.lastRecordTime = latestEnd;
            dm.data.lastChainTime = latestEnd;
          }
          await this.saveData();
          this.refreshAllViews();
          return send(200, { ok: true, deleted: { id, project: dm.getProject(entry.projectId)?.name || '?' } });

        } else if (req.method === 'GET' && (path === '/today' || path === '/day')) {
          const date = url.searchParams.get('date') || today();
          const entries = dm.getEntriesByDate(date);
          const projects = dm.getProjects();
          const totalMin = entries.reduce((s, e) => s + (e.duration || 0), 0);
          const detail = entries.map(e => {
            const p = dm.getProject(e.projectId);
            return { id: e.id, project: p?.name || '?', projectId: e.projectId, duration: e.duration, startTime: e.startTime, endTime: e.endTime, note: e.note };
          });
          return send(200, { date, totalMin, entries: detail, projects: projects.map(p => ({ id: p.id, name: p.name, situation: p.situation, color: p.color })) });

        } else if (req.method === 'GET' && path === '/projects') {
          return send(200, { projects: dm.getProjects().map(p => ({ id: p.id, name: p.name, situation: p.situation, color: p.color, goalHours: p.goalHours })) });

        } else if (req.method === 'GET' && path === '/stats') {
          const days = parseInt(url.searchParams.get('days') || '7');
          const daily = [];
          for (let i = days - 1; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const ds = fmtDate(d.toISOString());
            const es = dm.getEntriesByDate(ds);
            daily.push({ date: ds, totalMin: es.reduce((s, e) => s + (e.duration || 0), 0), count: es.length });
          }
          return send(200, { daily, totalMin: daily.reduce((s, d) => s + d.totalMin, 0), days });

        } else {
          return send(404, { error: 'not found' });
        }
      } catch (e) {
        console.error('时迹 API 错误:', e);
        return send(500, { error: e.message });
      }
    };
    route();
  }

  onunload() {
    this._stopHttpServer();
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
    // 只刷新实际可见的视图，避免重建隐藏视图的 DOM
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MAIN);
    for (const leaf of leaves) {
      if (!leaf.view || !(leaf.view instanceof TimeIsGoldMainView)) continue;
      if (leaf.getRoot()?.containerEl?.isShown?.() === false) continue; // 跳过隐藏标签页
      leaf.view.renderPanel(leaf.view.activeTab || 'timer');
    }

    const treeLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_TREE);
    for (const leaf of treeLeaves) {
      if (!leaf.view || !(leaf.view instanceof ProjectTreeView)) continue;
      if (leaf.getRoot()?.containerEl?.isShown?.() === false) continue;
      leaf.view.refreshTree();
    }

    const statsLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_STATS);
    for (const leaf of statsLeaves) {
      if (!leaf.view || !(leaf.view instanceof StatisticsView)) continue;
      if (leaf.getRoot()?.containerEl?.isShown?.() === false) continue;
      leaf.view.renderActiveTab();
    }
  }
}

module.exports = TimeIsGoldPlugin;

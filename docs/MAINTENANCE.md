# 时迹 · 维护指南

## 代码结构（单源真理）

```
~/下载/obsidian-time-traces/          ← Git 仓库（唯一代码源）
    ├── manifest.json
    ├── main.js
    ├── styles.css
    ├── README.md
    ├── .gitignore                     ← 排除 data.json
    └── docs/

~/.obsidian/plugins/time-is-gold/     ← 符号链接 → 上面
Obsidian Vault/.obsidian/.../          ← 符号链接 → 上面
```

**改代码**：只改 `~/下载/obsidian-time-traces/`，两个 Vault 自动同步。Obsidian 重载即生效。

## 发版流程

```bash
# 1. 改代码
vim ~/下载/obsidian-time-traces/main.js

# 2. 更新版本号（三处）
#    manifest.json: "version": "0.2.X"
#    main.js 顶部注释: v0.2.X
#    README.md 版本引用

# 3. 提交 + 打标签
cd ~/下载/obsidian-time-traces
git add -A && git commit -m "v0.2.X — 改动说明"
git tag v0.2.X
git push && git push --tags

# 4. 发 GitHub Release（BRAT 需要）
gh release create v0.2.X \
  --repo xiaoyiqiuya/obsidian-time-traces \
  --title "时迹 v0.2.X — 改动说明" \
  --notes "详细更新内容" \
  manifest.json main.js styles.css

# 5. iPad 端 BRAT → Update plugins
```

## 版本号规范

- `patch` (0.2.3→0.2.4): 修 Bug
- `minor` (0.2→0.3): 新功能
- `major` (0→1): 架构大改

## 注意事项

- `data.json` 被 .gitignore 排除，不会提交到仓库
- 不要在 Vault 插件目录里直接改文件——改 Git 仓库
- BRAT 用户每次发版后需要手动 Update

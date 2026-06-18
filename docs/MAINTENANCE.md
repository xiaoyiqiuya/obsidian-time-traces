# 时迹 · 维护指南

## 代码结构

```
obsidian-time-traces/                    ← Git 仓库（唯一代码源）
├── manifest.json
├── main.js
├── styles.css
├── README.md
├── .gitignore                   ← 排除 data.json
└── docs/
```

**注意事项**：
- `data.json` 被 .gitignore 排除，不会提交到仓库
- 插件设置中的 HTTP Token、Webhook URL 等敏感信息存储在 data.json 中，仅本地持有
- 发布前检查代码中无个人 Token、密钥、本地路径

## 发版流程

```bash
# 1. 改代码
vim main.js

# 2. 更新版本号（两处）
#    manifest.json: "version": "0.7.X"
#    README.md 版本引用

# 3. 提交 + 打标签
git add -A && git commit -m "v0.7.X — 改动说明"
git tag v0.7.X
git push && git push --tags

# 4. 发 GitHub Release
#    BRAT 用户可通过 GitHub Release 更新
```

## 安全检查清单（发版前必做）

- [ ] `grep -rnE "(token|secret|password|api[_-]?key)" src/` 仅含占位符
- [ ] `grep -rnE "(192\\.168|10\\.0\\.0|172\\.16\\.)" src/` 无内网地址
- [ ] `grep -rnE "~/\\.|~/下载|/Users/" src/` 无个人路径
- [ ] `data.json` 在 .gitignore 中
- [ ] 测试用数据文件不在 Git 跟踪中

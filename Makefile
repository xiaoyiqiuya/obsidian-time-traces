.PHONY: test deploy deploy-force push

# ── 配置 ──────────────────────────────────────────
# 生产插件目录（Obsidian Vault 插件路径）
PROD_DIR ?= /mnt/文件储存/Users/qiuzh/Documents/Obsidian Vault/.obsidian/plugins/time-is-gold

# 部署文件清单（只复制必要的文件，不含 .git data.json）
FILES = main.js manifest.json styles.css

# ── 工作流说明 ────────────────────────────────────
#   Step 1: 改代码 → make test   本地部署测试
#   Step 2: 改满意 → make push   发版到 GitHub + 本地同步
#
#   make deploy   = check + cp（仅本地）
#   make push     = check + 输版本号 + commit + tag + push + cp（本地+GitHub）

# ── 安全检查 ──────────────────────────────────────
check:
	@echo "🔍 安全检查中…"
	@! grep -nE "(7a80ab[0-9a-f]{32}|10c050b0[0-9a-f-]+|junchen|小邱|ou_[a-z0-9]{24,})" $(FILES) docs/*.md 2>/dev/null
	@echo "✅ 安全检查通过"

# ── Step 1: 本地测试 ──────────────────────────────
test: check
	@echo "📦 部署到本地 Obsidian…"
	cp $(FILES) "$(PROD_DIR)/"
	@echo ""
	@echo "✅ 已部署到本地。在 Obsidian 中:"
	@echo "   Ctrl+P → 输入「重载」→ 回车"
	@echo "   或 Ctrl+Shift+P → Developer: Reload Plugin"

deploy: test
	# deploy 是 test 的别名

deploy-force:
	@echo "⚠️  跳过安全检查"
	cp $(FILES) "$(PROD_DIR)/"
	@echo "✅ 已部署"

# ── Step 2: 发版（本地测试通过后再执行） ──────────
push: check
	@echo "📤 发布到 GitHub + 同步本地"
	@read -p "版本号 (如 0.7.6): " ver; \
	sed -i 's/"version": "[^"]*"/"version": "'$$ver'"/' manifest.json; \
	git add -A && git commit -m "v$$ver" && git tag v$$ver && git push && git push --tags; \
	cp $(FILES) "$(PROD_DIR)/"; \
	echo ""; \
	echo "✅ v$$ver 已发布到 GitHub + 本地同步完成"

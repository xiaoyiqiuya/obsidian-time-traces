.PHONY: deploy deploy-force check push

# ── 配置 ──────────────────────────────────────────
# 生产插件目录（Obsidian Vault 插件路径）
PROD_DIR ?= /mnt/文件储存/Users/qiuzh/Documents/Obsidian Vault/.obsidian/plugins/time-is-gold

# 部署文件清单（只复制必要的文件，不含 .git data.json）
FILES = main.js manifest.json styles.css

# ── 安全检查 ──────────────────────────────────────
check:
	@echo "🔍 安全检查中…"
	@! grep -nE "(7a80ab|10c050|junchen|小邱|ou_8b54431aeff58|feishu|open\\.feishu|token|secret|password)" $(FILES) docs/*.md 2>/dev/null | grep -v "httpToken" | grep -v "http\.token" | grep -v "api_token" | grep -v "Bearer" | grep -v "password"
	@echo "✅ 安全检查通过"

# ── 部署到生产 ────────────────────────────────────
deploy: check
	@echo "📦 部署到 $(PROD_DIR)"
	cp $(FILES) "$(PROD_DIR)/"
	@echo "✅ 已部署。Obsidian 中 Ctrl+P → 重载插件生效"

# ── 强制部署（跳过检查） ──────────────────────────
deploy-force:
	@echo "⚠️  跳过安全检查"
	cp $(FILES) "$(PROD_DIR)/"
	@echo "✅ 已部署"

# ── 发版（部署 + 提交 + 打标签） ──────────────────
push: check
	@read -p "版本号 (如 0.7.6): " ver; \
	sed -i 's/"version": "[^"]*"/"version": "'$$ver'"/' manifest.json; \
	git add -A && git commit -m "v$$ver" && git tag v$$ver && git push && git push --tags; \
	cp $(FILES) "$(PROD_DIR)/"; \
	echo "✅ v$$ver 已发布并部署"

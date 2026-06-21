#!/usr/bin/env python3
"""
LM Studio Qwen 3.5 9B 视觉问答助手
用法: python3 lm_vision.py <图片路径> [问题]
"""

import sys, base64, json, urllib.request, os, io
from PIL import Image

API_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "qwen3.5-9b"

# ── 推荐参数（视觉问答最佳实践） ──────────────────
PARAMS = {
    "temperature": 0.3,          # 低温度 → 精确描述，减少幻觉
    "top_p": 0.85,               # 核采样适度收紧
    "top_k": 40,                 # 限制候选词范围
    "repeat_penalty": 1.05,      # 轻微防止重复
    "max_tokens": 2048,          # 足够长的回复
    "presence_penalty": 0.1,     # 轻微鼓励新主题
    "frequency_penalty": 0.1,    # 轻微抑制高频词
}

# ── Vision 专用 System Prompt ────────────────────
SYSTEM_PROMPT = "你是一个精确的图片描述助手。描述要客观、结构化：先说场景，再说人物/主体，然后说细节（服饰、颜色、文字），最后说氛围。不要添加推测和想象。"


def ask(image_path, question="请详细描述这张图片的内容"):
    """发送图片到 Qwen 3.5 9B Vision 并返回回答"""
    # 读取并压缩图片
    img = Image.open(image_path)
    # 视觉模型最佳输入尺寸 1024px
    img.thumbnail((1024, 1024), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=85)
    img_b64 = base64.b64encode(buf.getvalue()).decode()

    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": question},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}}
            ]}
        ],
        **PARAMS
    }

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}
    )

    with urllib.request.urlopen(req, timeout=180) as resp:
        result = json.loads(resp.read())
        return result["choices"][0]["message"]["content"]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"用法: {sys.argv[0]} <图片路径> [问题]")
        sys.exit(1)

    path = sys.argv[1]
    question = sys.argv[2] if len(sys.argv) > 2 else "请详细描述这张图片的内容"

    if not os.path.exists(path):
        print(f"❌ 文件不存在: {path}")
        sys.exit(1)

    print(f"📷 分析中: {path}")
    print(f"🔧 参数: temp={PARAMS['temperature']}, top_p={PARAMS['top_p']}, top_k={PARAMS['top_k']}")
    print()

    answer = ask(path, question)
    print(answer)

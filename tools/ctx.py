# -*- coding: utf-8 -*-
"""在已清洗章节 JSON 中按关键词打印上下文，用于确定片段锚点。用法: python ctx.py chId 关键词 [半径]"""
import json, sys
from pathlib import Path
CH = Path(__file__).resolve().parents[1] / "content" / "chapters"
ch = json.loads((CH / f"{sys.argv[1]}.json").read_text(encoding="utf-8"))
text = "\n".join(ch["paragraphs"])
r = int(sys.argv[3]) if len(sys.argv) > 3 else 130
i = 0
while True:
    i = text.find(sys.argv[2], i)
    if i < 0:
        break
    print(f"@{i}: …{text[max(0,i-r):i+r+len(sys.argv[2])]}…")
    print("---")
    i += 1

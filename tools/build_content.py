# -*- coding: utf-8 -*-
"""书流 内容准备脚本
1. extract: 从 books/ 原始 html 清洗选定章节 -> content/chapters/*.json
2. passages: 按 passages.src.json 的锚点子串计算 code point 坐标并校验快照 -> content/passages.json
3. bundle: 将 content/*.json 合并为 content.js（window.CONTENT = {...}），支持 file:// 双击打开

字符计数口径：全程 Unicode code point（Python 字符即 code point），与 PRD 13.2 左闭右开 [start, end) 一致。
段落坐标：loc = {sp, so, ep, eo}，sp/ep 为段落下标，so/eo 为段内 code point 偏移（左闭右开）；
跨段快照以 \n 连接，校验时按同规则重建比对。
"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]           # find work/
BOOKS = ROOT / "books" / "resources"
APP = Path(__file__).resolve().parents[1]            # test/first_app/
CONTENT = APP / "content"
CH_DIR = CONTENT / "chapters"

# 选定承载章节：书 -> [(文件下标, chapterId, 回目序号)]
PLAN = {
    "hlm": {"dir": BOOKS / "世态人情" / "红楼梦", "ids": [(2, "hlm-03", 3), (22, "hlm-23", 23), (26, "hlm-27", 27), (31, "hlm-32", 32)]},
    "xyj": {"dir": BOOKS / "鬼怪神魔" / "西游记", "ids": [(0, "xyj-01", 1), (13, "xyj-14", 14), (26, "xyj-27", 27)]},
}

def clean_html(p: Path):
    raw = p.read_text(encoding="utf-8")
    raw = raw.replace("<br><br>", "\n").replace("<br>", "\n").replace("<br/>", "\n")
    paras = []
    for seg in raw.split("\n"):
        seg = seg.strip().strip("\u3000").strip()
        if seg:
            paras.append(seg)
    return paras

def cmd_extract():
    CH_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    for bookId, cfg in PLAN.items():
        info = json.loads((cfg["dir"] / "info.json").read_text(encoding="utf-8"))
        for fidx, chId, num in cfg["ids"]:
            paras = clean_html(cfg["dir"] / f"{fidx}.html")
            doc = {"chapterId": chId, "bookId": bookId, "fileIndex": fidx, "number": num,
                   "title": info["catalogues"][fidx], "paragraphs": paras, "cpLength": len("\n".join(paras))}
            (CH_DIR / f"{chId}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
            index.append({"chapterId": chId, "bookId": bookId, "number": num,
                          "title": info["catalogues"][fidx], "paragraphs": len(paras), "chars": doc["cpLength"]})
            print(f"{chId}: {len(paras)}段 / {doc['cpLength']}字")
    (CH_DIR / "_index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")

def para_starts(paras):
    starts, acc = [], 0
    for p in paras:
        starts.append(acc)
        acc += len(p) + 1          # +1 为段落间 \n 分隔符
    return starts

def locate(paras, starts, needle):
    text = "\n".join(paras)
    g = text.find(needle)
    if g < 0:
        return None
    ge = g + len(needle)           # 左闭右开
    def p_of(x):
        for i in range(len(paras)):
            if starts[i] <= x < starts[i] + len(paras[i]):
                return i
        return -1
    sp, ep = p_of(g), p_of(ge - 1)
    return sp, g - starts[sp], ep, ge - starts[ep]

def snapshot_of(paras, sp, so, ep, eo):
    if sp == ep:
        return paras[sp][so:eo]
    parts = [paras[sp][so:]] + paras[sp + 1:ep] + [paras[ep][:eo]]
    return "\n".join(parts)

def cmd_passages():
    src = json.loads((CONTENT / "passages.src.json").read_text(encoding="utf-8"))
    out, errors = [], []
    for p in src:
        ch = json.loads((CH_DIR / f"{p['chapterId']}.json").read_text(encoding="utf-8"))
        paras = ch["paragraphs"]
        loc = locate(paras, para_starts(paras), p["anchor"])
        if not loc:
            errors.append(f"{p['passageId']}: 锚点未找到 -> {p['anchor'][:24]}…")
            continue
        sp, so, ep, eo = loc
        snap = snapshot_of(paras, sp, so, ep, eo)
        if snap != p["anchor"]:
            errors.append(f"{p['passageId']}: 快照与锚点不一致")
            continue
        rec = {"passageId": p["passageId"], "bookId": ch["bookId"], "chapterId": p["chapterId"],
               "loc": {"sp": sp, "so": so, "ep": ep, "eo": eo}, "cpLength": len(snap),
               "text": snap, "intro": p["intro"], "topics": p["topics"]}
        n = len(snap)
        flag = "" if 60 <= n <= 220 else "  << 长度越界"
        print(f"{p['passageId']}: {n}字 [{sp}.{so}->{ep}.{eo}]{flag}")
        if flag:
            errors.append(f"{p['passageId']}: 长度 {n} 超出 60-220")
        out.append(rec)
    if errors:
        print("ERRORS:\n" + "\n".join(errors)); sys.exit(1)
    (CONTENT / "passages.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"passages.json: {len(out)} 条")

def cmd_bundle():
    data = {}
    for name in ["books", "passages", "demo-comments"]:
        f = CONTENT / f"{name}.json"
        if f.exists():
            data[name.replace("-", "_")] = json.loads(f.read_text(encoding="utf-8"))
    data["chapters"] = {}
    for f in sorted(CH_DIR.glob("*.json")):
        if not f.name.startswith("_"):
            doc = json.loads(f.read_text(encoding="utf-8"))
            data["chapters"][doc["chapterId"]] = doc
    js = "window.CONTENT=" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";"
    (CONTENT / "content.js").write_text(js, encoding="utf-8")
    print(f"content.js: {len(js)//1024}KB")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("extract", "all"): cmd_extract()
    if cmd in ("passages", "all"): cmd_passages()
    if cmd in ("bundle", "all"): cmd_bundle()

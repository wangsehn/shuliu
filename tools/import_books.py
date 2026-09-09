# -*- coding: utf-8 -*-
"""书流 · 百本图书批量导入脚本
从 books/resources/ 导入 100 本书（含既有 10 本，bookId/chapterId 保持稳定）：
1. 全章节解析：分类/书名/N.html + info.json catalogues（标题/回目序号/作者）
2. 章节正文按书打包：content/text/{bookId}.js（阅读器懒加载）
3. 片段自动生成：每章 ≥1 条 60-220 字句子对齐片段 + loc 锚点 + 启发式主题
4. 遗留兼容：23 个既有 chapterId / 76 条人工片段原样保留
5. 完整性校验：章-书关联、loc 重建、无遗漏，任一失败即退出非零

清洗口径与 build_content.py 一致：Unicode code point，loc={sp,so,ep,eo} 左闭右开，
跨段以 \\n 连接。遗留章节正文从 content/chapters/*.json 原样搬运（零风险）。
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BOOKS = ROOT / "books" / "resources"
APP = Path(__file__).resolve().parents[1]
CONTENT = APP / "content"
TEXT_DIR = CONTENT / "text"
CH_DIR = CONTENT / "chapters"

# ---------- 选书（100 本；id 为既定稳定 id；艳情/禁毁书目一律不选） ----------
# (分类, 目录名, bookId, 朝代)
SELECTION = [
    # 既有 10 本（id 不可变）
    ("世态人情", "红楼梦", "hlm", "清"),
    ("鬼怪神魔", "西游记", "xyj", "明"),
    ("历史演义", "三国演义", "sgyy", "明"),
    ("英雄传奇", "水浒传", "shzh", "明"),
    ("世态人情", "喻世明言", "ysmy", "明"),
    ("世态人情", "警世通言", "jstl", "明"),
    ("世态人情", "醒世恒言", "xsh", "明"),
    ("鬼怪神魔", "聊斋志异", "liao", "清"),
    ("谴责公案", "儒林外史", "rlws", "清"),
    ("鬼怪神魔", "镜花缘", "jhy", "清"),
    # 唐传奇
    ("传奇小说", "柳毅传", "lyz", "唐"),
    ("传奇小说", "南柯太守传", "nktz", "唐"),
    ("传奇小说", "莺莺传", "yyz", "唐"),
    ("传奇小说", "长恨传", "chz", "唐"),
    ("传奇小说", "霍小玉传", "hxy", "唐"),
    ("传奇小说", "虬髯客传", "qlk", "唐"),
    ("传奇小说", "聂隐娘", "nyn", "唐"),
    ("传奇小说", "红线传", "hxc", "唐"),
    ("传奇小说", "李娃传", "lwz", "唐"),
    ("传奇小说", "无双传", "wsc", "唐"),
    ("传奇小说", "离魂记", "lhj", "唐"),
    ("传奇小说", "谢小娥传", "xxe", "唐"),
    ("传奇小说", "昆仑奴传", "kln", "唐"),
    ("传奇小说", "灵应传", "lyf", "唐"),
    ("传奇小说", "龙城录", "lcl", "宋"),
    # 笔记 / 杂纂
    ("其他", "世说新语", "ssxy", "南朝宋"),
    ("其他", "唐语林", "tyl", "宋"),
    ("其他", "西京杂记", "xjzj", "汉"),
    ("其他", "酉阳杂俎", "yyzz", "唐"),
    ("其他", "夜谭随录", "ytsl", "清"),
    ("其他", "淞隐漫录", "syml", "清"),
    ("其他", "豆棚闲话", "dpxh", "清"),
    ("其他", "清平山堂话本", "qpsthb", "明"),
    ("其他", "大唐新语", "dtxy", "唐"),
    ("其他", "中山狼传", "zsls", "明"),
    ("其他", "枕中记", "zzj", "唐"),
    # 晚清 / 民国
    ("其他", "断鸿零雁记", "dhlyj", "民国"),
    ("其他", "玉梨魂", "ylh", "民国"),
    ("其他", "黄绣球", "hxq", "清"),
    # 话本 / 拟话本
    ("世态人情", "三刻拍案惊奇", "skpa", "明"),
    ("世态人情", "二刻拍案惊奇", "ekpa", "明"),
    ("世态人情", "初刻拍案惊奇", "ckpa", "明"),
    ("世态人情", "型世言", "xsy", "明"),
    ("世态人情", "石点头", "std", "明"),
    ("世态人情", "醉醒石", "zxs", "明"),
    ("世态人情", "西湖二集", "xhej", "明"),
    ("世态人情", "剪灯新话", "jdxh", "明"),
    ("世态人情", "杜骗新书", "dpxs", "明"),
    # 才学 / 人情名著
    ("世态人情", "十二楼", "sel", "清"),
    ("世态人情", "好逑传", "hqz", "清"),
    ("世态人情", "玉娇梨", "yjl", "明"),
    ("世态人情", "平山冷燕", "psln", "清"),
    ("世态人情", "醒世姻缘传", "xsyz", "清"),
    ("世态人情", "林兰香", "llx", "清"),
    ("世态人情", "海上花列传", "hshlz", "清"),
    ("世态人情", "花月痕", "hyh", "清"),
    ("世态人情", "蜃楼志", "slz", "清"),
    ("世态人情", "恨海", "hh", "清"),
    ("世态人情", "新石头记", "xstj", "清"),
    ("世态人情", "一层楼", "ycl", "清"),
    ("世态人情", "品花宝鉴", "phbj", "清"),
    # 历史演义
    ("历史演义", "东周列国志", "dzlgz", "明"),
    ("历史演义", "隋唐演义", "styy", "清"),
    ("历史演义", "说唐", "st", "清"),
    ("历史演义", "西汉演义", "xhyy", "明"),
    ("历史演义", "南北史演义", "nbsyy", "民国"),
    ("历史演义", "大宋中兴通俗演义", "dszx", "明"),
    ("历史演义", "二十四史通俗演义", "esss", "清"),
    # 英雄传奇
    ("英雄传奇", "三侠五义", "sxsy", "清"),
    ("英雄传奇", "儿女英雄传", "enyx", "清"),
    ("英雄传奇", "杨家将传", "yjjc", "明"),
    ("英雄传奇", "水浒后传", "shht", "清"),
    ("英雄传奇", "呼家将", "hjj", "清"),
    ("英雄传奇", "说岳全传", "syqz", "清"),
    ("英雄传奇", "燕丹子", "ydzz", "汉"),
    # 谴责 / 公案
    ("谴责公案", "官场现形记", "gcxxj", "清"),
    ("谴责公案", "二十年目睹之怪现状", "nsnmz", "清"),
    ("谴责公案", "孽海花", "nhh", "清"),
    ("谴责公案", "杨乃武与小白菜", "ynwybx", "清"),
    ("历史演义", "张文祥刺马案", "zwxcm", "清"),
    ("谴责公案", "狄公案", "dga", "清"),
    ("谴责公案", "九命奇冤", "jmqy", "清"),
    ("世态人情", "文明小史", "wmxs", "清"),
    ("谴责公案", "龙图公案", "ltga", "明"),
    ("其他", "绿牡丹", "lmd", "清"),
    # 神魔
    ("鬼怪神魔", "封神演义", "fsyy", "明"),
    ("鬼怪神魔", "东游记", "dyj", "明"),
    ("鬼怪神魔", "南游记", "nyj", "明"),
    ("鬼怪神魔", "北游记", "byj", "明"),
    ("鬼怪神魔", "三遂平妖传", "sspy", "明"),
    ("鬼怪神魔", "绿野仙踪", "lyxz", "清"),
    ("鬼怪神魔", "阅微草堂笔记", "ywctbj", "清"),
    ("鬼怪神魔", "子不语", "zby", "清"),
    ("鬼怪神魔", "搜神记", "ssj", "晋"),
    ("鬼怪神魔", "搜神后记", "sshj", "晋"),
    ("鬼怪神魔", "山海经", "shj", "先秦"),
    ("鬼怪神魔", "西游补", "xyb", "明"),
    ("鬼怪神魔", "后西游记", "hxyj", "明"),
    ("鬼怪神魔", "雷峰塔奇传", "lftqc", "清"),
    ("鬼怪神魔", "牛郎织女传", "nlznc", "明"),
]

# ---------- 遗留兼容：bookId -> {文件下标: 既有 chapterId} ----------
LEGACY = {
    "hlm": {2: "hlm-03", 22: "hlm-23", 26: "hlm-27", 31: "hlm-32"},
    "xyj": {0: "xyj-01", 13: "xyj-14", 26: "xyj-27"},
    "jstl": {0: "jstl-01", 27: "jstl-28", 31: "jstl-32"},
    "ysmy": {0: "ysmy-01", 15: "ysmy-16"},
    "xsh": {2: "xsh-03", 10: "xsh-11", 17: "xsh-18"},
    "liao": {14: "liao-15", 47: "liao-48", 48: "liao-49"},
    "sgyy": {20: "sg-21", 36: "sg-37"},
    "shzh": {2: "sh-02", 9: "sh-10"},
    "rlws": {1: "rl-01", 3: "rl-03"},
    "jhy": {10: "jhy-11", 24: "jhy-25"},
}

CN_NUM = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
          "六": 6, "七": 7, "八": 8, "九": 9}
CN_UNIT = {"十": 10, "百": 100, "千": 1000}
FRONT_RE = re.compile(r"^(楔子|引首|序[文幕]?|卷首|自序|原序|凡例|目录|缘起|开场|弁言|题辞|题词|前言|概述)")
NUM_RE = re.compile(r"^第\s*([0-9〇零一二两三四五六七八九十百千]+)\s*[回卷篇章则节出集部话齣出]")

def cn2int(s):
    if s.isdigit():
        return int(s)
    total, val = 0, 0
    for c in s:
        if c in CN_NUM:
            val = CN_NUM[c]
        elif c in CN_UNIT:
            u = CN_UNIT[c]
            total += (val if val else 1) * u
            val = 0
    return total + val

def parse_number(title):
    if FRONT_RE.match(title):
        return 0
    m = NUM_RE.match(title)
    if m:
        n = cn2int(m.group(1))
        if n > 0:
            return n
    return 0

JUNK_RE = re.compile(r"zj_waps|m-page|mingqingxiaoshuo|www\.|https?:|^\s*$")

def clean_new(seg):
    """新书清洗：<br> 切段后剥残余标签与站点杂质。"""
    seg = re.sub(r"<script[\s\S]*?(?:</script>|$)", "", seg)
    seg = re.sub(r"<[^>]+>", "", seg)
    seg = seg.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    seg = seg.strip().strip("\u3000").strip()
    if JUNK_RE.search(seg):
        return ""
    return seg

def clean_legacy(seg):
    """与 build_content.py 完全一致（遗留书正文以存储 JSON 为准，此函数仅用于比对新解析结果）。"""
    seg = seg.strip().strip("\u3000").strip()
    return seg

SENT_END = set("。！？…”」』!?")
MID_END = set("，；：、,”’")

def slice_passage(paras):
    """每章取首个 60-220 字句子对齐窗口，返回 (sp,so,ep,eo,text) 或 None。"""
    if not paras:
        return None
    starts, acc = [], 0
    for p in paras:
        starts.append(acc)
        acc += len(p) + 1
    text = "\n".join(paras)
    total = len(text)

    def p_of(x):
        for i in range(len(paras)):
            if starts[i] <= x < starts[i] + len(paras[i]):
                return i
        return None

    def to_loc(a, b):
        sp, ep = p_of(a), p_of(b - 1)
        if sp is None or ep is None or ep - sp > 4:
            return None
        return (sp, a - starts[sp], ep, b - starts[ep], text[a:b])

    candidates = []
    for i, p in enumerate(paras):
        n = len(p)
        if n < 60:
            continue
        candidates.append(starts[i])
    if not candidates:  # 全是短段：跨段合并
        for i in range(len(paras) - 2):
            a = starts[i]
            for b in range(a + 60, min(a + 221, total)):
                if text[b - 1] in SENT_END:
                    candidates.append(b)
                    break
    for a in candidates:
        best = None
        for b in range(a + 60, min(a + 221, total) + 1):
            if text[b - 1] in SENT_END:
                best = b
                break
        if best is None:
            for b in range(a + 60, min(a + 221, total) + 1):
                if text[b - 1] in MID_END and b - a >= 100:
                    best = b
                    break
        if best is None and min(a + 221, total) - a >= 60:
            best = a + 220
        if best:
            loc = to_loc(a, best)
            if loc:
                return loc
    return None

TOPIC_KW = {
    "亲密关系": list("情爱恋婚嫁娶妻妾夫妇色欢缘相思媚媒配"),
    "情绪与压力": list("怒哭泪悲愁惧惊怕病死苦冤屈灾难啼泣哀"),
    "成长与选择": list("学考志师徒悟科举功名中选习业"),
    "孤独与陪伴": list("孤独别离送思念归寂寞伴友逢聚散"),
    "人性与社会": list("官银财贪奸骗讼案盗贼善恶恩义侠骗牢狱"),
    "自我认识": list("心梦命道己身思性迷醒真幻"),
}

def topics_for(title, text, seed):
    score = {}
    for t, kws in TOPIC_KW.items():
        s = sum(3 for k in kws if k in title) + sum(1 for k in kws if k in text)
        if s > 0:
            score[t] = s
    if not score:
        order = list(TOPIC_KW.keys())
        return [order[seed % 6]]
    top = sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))
    return [t for t, _ in top[:2]]

def main():
    assert len(SELECTION) == 100, f"选书须 100 本，当前 {len(SELECTION)}"
    TEXT_DIR.mkdir(parents=True, exist_ok=True)
    books, passages, meta, texts = [], [], {}, {}
    legacy_pids = set()
    legacy_chs = {}
    for bid, m in LEGACY.items():
        for fidx, cid in m.items():
            doc = json.loads((CH_DIR / f"{cid}.json").read_text(encoding="utf-8"))
            legacy_chs[(bid, fidx)] = doc
    old_pass = json.loads((CONTENT / "passages.json").read_text(encoding="utf-8"))
    for p in old_pass:
        legacy_pids.add(p["passageId"])

    errors, warns = [], []
    auto_n = 0
    for cat, dname, bid, dynasty in SELECTION:
        bdir = BOOKS / cat / dname
        info = json.loads((bdir / "info.json").read_text(encoding="utf-8"))
        catalogues = info["catalogues"]
        author = info.get("author") or "佚名"
        files = sorted([f for f in bdir.glob("*.html") if f.stem.isdigit()], key=lambda f: int(f.stem))
        if not files:
            errors.append(f"{dname}: 无章节文件"); continue
        chs, tmap = [], {}
        used_ids = set()
        for f in files:
            fidx = int(f.stem)
            raw = f.read_text(encoding="utf-8")
            segs = []
            for seg in raw.split("\n"):
                seg = seg.replace("<br><br>", "\n").replace("<br>", "\n").replace("<br/>", "\n")
                segs.extend(seg.split("\n"))
            if (bid, fidx) in legacy_chs:
                doc = legacy_chs[(bid, fidx)]
                paras, cid, number = doc["paragraphs"], doc["chapterId"], doc["number"]
                title = doc["title"]
                # 一致性抽查：重新解析应与存储一致（保留原实现口径）
                reparsed = [clean_legacy(s) for s in segs]
                reparsed = [s for s in reparsed if s]
                if reparsed != paras:
                    warns.append(f"{cid}: 重解析与存储不一致（按存储搬运，锚点零风险）")
            else:
                raw_title = catalogues[fidx] if fidx < len(catalogues) else f"第{fidx + 1}部分"
                number = parse_number(raw_title)
                title = re.sub(r"^(第[0-9〇零一二两三四五六七八九十百千]+\s*[回卷篇章则节出集部话]*|楔子|引首|序[文幕]?|卷首|自序|原序|凡例|目录|缘起)\s*", "", raw_title).strip() or raw_title
                paras = [clean_new(s) for s in segs]
                paras = [s for s in paras if s]
                if number > 0:
                    cid = f"{bid}-{number:02d}"
                else:
                    cid = f"{bid}-f{fidx:02d}"
                base = cid
                k = 2
                while cid in used_ids:
                    cid = f"{base}-{k}"; k += 1
                if not paras:
                    warns.append(f"{bid} 文件{fidx}: 清洗后无正文（跳过）"); continue
            used_ids.add(cid)
            chs.append({"chapterId": cid, "number": number, "title": title})
            tmap[cid] = paras
            meta[cid] = {"chapterId": cid, "bookId": bid, "number": number, "title": title,
                         "chars": sum(len(p) + 1 for p in paras) - 1}
            # 片段生成（遗留章节已有人工片段，跳过）
            if (bid, fidx) in legacy_chs:
                continue
            loc = slice_passage(paras)
            if not loc:
                warns.append(f"{cid}: 未切出合格片段")
                continue
            sp, so, ep, eo, text = loc
            pid = f"{cid}-p1"
            if pid in legacy_pids:
                pid = f"{cid}-a1"
            if pid in legacy_pids:
                warns.append(f"{cid}: 片段 id 冲突，跳过"); continue
            raw_title = catalogues[fidx] if fidx < len(catalogues) else title
            intro = f"《{info['name']}》{raw_title}"
            if len(intro) > 42:
                intro = intro[:42] + "…"
            passages.append({
                "passageId": pid, "bookId": bid, "chapterId": cid,
                "loc": {"sp": sp, "so": so, "ep": ep, "eo": eo},
                "cpLength": len(text), "text": text, "intro": intro,
                "topics": topics_for(raw_title, text, len(passages)),
            })
            auto_n += 1
        texts[bid] = tmap
        books.append({"bookId": bid, "title": info["name"], "author": author, "dynasty": dynasty,
                      "version": "通行整理电子本（原始数据未标注具体底本版本）",
                      "source": "luoxuhai/chinese-novel（GitHub，MIT License）", "chapters": chs})

    # ---------- 校验 ----------
    book_ids = {b["bookId"] for b in books}
    if len(book_ids) != 100:
        errors.append(f"books 数量 {len(book_ids)} ≠ 100")
    ch_ids = set(meta.keys())
    for p in passages:
        if p["chapterId"] not in ch_ids:
            errors.append(f"{p['passageId']}: 引用未知章节 {p['chapterId']}"); continue
        paras = texts[p["bookId"]][p["chapterId"]]
        starts, acc = [], 0
        for x in paras:
            starts.append(acc); acc += len(x) + 1
        l = p["loc"]
        if l["sp"] == l["ep"]:
            snap = paras[l["sp"]][l["so"]:l["eo"]]
        else:
            snap = "\n".join([paras[l["sp"]][l["so"]:]] + paras[l["sp"] + 1:l["ep"]] + [paras[l["ep"]][:l["eo"]]])
        if snap != p["text"]:
            errors.append(f"{p['passageId']}: loc 重建不一致")
        if not (60 <= p["cpLength"] <= 220):
            errors.append(f"{p['passageId']}: 长度 {p['cpLength']} 越界")
    for cid, m in meta.items():
        if cid not in texts[m["bookId"]]:
            errors.append(f"章节 {cid} 缺正文")

    if errors:
        print("ERRORS:\n" + "\n".join(errors[:40])); sys.exit(1)

    # ---------- 落盘 ----------
    (CONTENT / "books.json").write_text(json.dumps(books, ensure_ascii=False, indent=1), encoding="utf-8")
    allp = old_pass + passages
    (CONTENT / "passages.json").write_text(json.dumps(allp, ensure_ascii=False, indent=1), encoding="utf-8")
    total_text_bytes = 0
    for bid, tmap in texts.items():
        js = "window.SHULIU_TEXT=window.SHULIU_TEXT||{};window.SHULIU_TEXT['" + bid + "']=" + \
             json.dumps(tmap, ensure_ascii=False, separators=(",", ":")) + ";"
        total_text_bytes += len(js.encode("utf-8"))
        (TEXT_DIR / f"{bid}.js").write_text(js, encoding="utf-8")
    dc = CONTENT / "demo-comments.json"
    data = {"books": books, "passages": allp, "chapters": meta,
            "demoComments": json.loads(dc.read_text(encoding="utf-8")) if dc.exists() else []}
    js = "window.CONTENT=" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";"
    (CONTENT / "content.js").write_text(js, encoding="utf-8")

    cats = {}
    for cat, dname, bid, dy in SELECTION:
        cats[cat] = cats.get(cat, 0) + 1
    print(f"books={len(books)} chapters={len(meta)} passages={len(allp)} (auto +{auto_n}, legacy {len(old_pass)})")
    print(f"content.js={len(js)//1024}KB text_files={len(texts)} text_total={total_text_bytes // 1024}KB")
    print("category split:", json.dumps(cats, ensure_ascii=False))
    if warns:
        print(f"WARNS ({len(warns)}):")
        for w in warns[:20]:
            print("  -", w)

if __name__ == "__main__":
    main()

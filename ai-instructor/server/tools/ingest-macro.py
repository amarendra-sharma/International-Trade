#!/usr/bin/env python3
"""ingest-micro.py - turn the Intro Microeconomics textbook HTML into retrieval chunks for the ma_ai_* tables. No network, no dependencies.

  python3 tools/ingest-micro.py <path/to/macronations-textbook.html> [outDir=content-macro]

Keeps lesson text, key terms, examples, worked examples (question and steps), insights, pitfalls and the "decide first" prompts.
DROPS interactive charts, sliders, read-outs, buttons, navigation and the chapter quizzes (generated in the browser; never stored), scripts and styles.
Writes outDir/ma-textbook.chunks.json and one SQL file per chapter (outDir/sql/chNN.sql) that calls ma_ai_upsert_chunks(). Run those AFTER migration 107."""
import hashlib, json, re, sys, os
from html.parser import HTMLParser
from html import unescape

SOURCE = "ma-textbook"; TITLE = "Macroeconomics (MacroNations textbook)"; MAX = 1200
SKIP = {"tb-quiz", "tb-chart-box", "tb-chart-wrap", "tb-chart-title", "tb-controls", "tb-readout", "tb-chapter-nav", "tb-mark-complete", "tb-cover-badge", "tb-header-btn"}
SKIP_TAGS = {"script", "style", "button", "canvas", "svg", "select", "input", "nav", "noscript", "head"}
SPECIAL = {"tb-keyterm": "term", "tb-example": "example", "tb-worked": "worked", "tb-insight": "insight", "tb-pitfall": "pitfall", "tb-decision": "decision"}
# the database allows only these chunk kinds; the original label stays in the heading
DBKIND = {"term": "term", "example": "example", "worked": "example", "insight": "notes", "pitfall": "warning", "decision": "lesson", "lesson": "lesson"}
VOID = {"br", "img", "hr", "input", "meta", "link", "col", "wbr", "source"}

class P(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True); s.stack = []; s.skip = 0; s.chapter = 0; s.ctitle = ""; s.section = None; s.heading = ""
        s.items = []; s.buf = None; s.bufkind = None; s.cur = []; s.in_title = False; s.in_eyebrow = False; s.in_h2 = False; s.in_sub = False; s.sub = []
    def classes(s, attrs): return set((dict(attrs).get("class") or "").split())
    def handle_starttag(s, tag, attrs):
        if tag in VOID: return
        c = s.classes(attrs); skip = tag in SKIP_TAGS or bool(c & SKIP)
        special = next((SPECIAL[k] for k in c if k in SPECIAL), None)
        s.stack.append((tag, skip, special))
        if skip: s.skip += 1; return
        if s.skip: return
        if "tb-chapter-eyebrow" in c: s.in_eyebrow = True; s.cur = []
        if "tb-chapter-title" in c: s.in_title = True; s.cur = []
        if tag == "h2" and "tb-section" in c: s.in_h2 = True; s.cur = []
        if tag in ("h3", "h4") and (c & {"tb-subsection", "tb-sub4"}): s.in_sub = True; s.sub = []
        if special and s.buf is None: s.flush_text(); s.buf = []; s.bufkind = special
        if tag in ("p", "li", "div", "br", "tr") and s.buf is not None: s.buf.append("\n")
    def handle_endtag(s, tag):
        if tag in VOID or not s.stack: return
        while s.stack and s.stack[-1][0] != tag: s.stack.pop()   # tolerate sloppy HTML
        if not s.stack: return
        _, skip, special = s.stack.pop()
        if skip: s.skip -= 1; return
        if s.skip: return
        if s.in_eyebrow and tag == "div":
            s.in_eyebrow = False; m = re.match(r"\s*Chapter\s+(\d+)", "".join(s.cur))
            if m: s.chapter = int(m.group(1)); s.section = None; s.heading = ""
        if s.in_title and tag == "div": s.in_title = False; s.ctitle = re.sub(r"\s+", " ", "".join(s.cur)).strip() if s.chapter else s.ctitle
        if s.in_h2 and tag == "h2":
            s.in_h2 = False; t = re.sub(r"\s+", " ", "".join(s.cur)).replace(" ", " ").strip(); m = re.match(r"(\d+\.\d+)\s*(.*)", t)
            s.flush_text(); s.section = m.group(1) if m else t; s.heading = (m.group(2) if m else t).strip(" -—")
        if s.in_sub and tag in ("h3", "h4"): s.in_sub = False; s.flush_text(); s.heading = re.sub(r"\s+", " ", "".join(s.sub)).strip()
        if special and s.buf is not None and not any(x[2] for x in s.stack):
            txt = clean("".join(s.buf)); kind = s.bufkind; s.buf = None; s.bufkind = None
            if txt: s.items.append(dict(kind=kind, text=txt, chapter=s.chapter, ctitle=s.ctitle, section=s.section, heading=s.heading))
        elif s.buf is not None and tag in ("p", "li", "div", "tr"): s.buf.append("\n")
        if tag in ("p", "li") and s.buf is None and s.text is not None: s.text.append("\n")
    text = None
    def handle_data(s, d):
        if s.skip: return
        if s.in_eyebrow or s.in_title or s.in_h2: s.cur.append(d)
        if s.in_sub: s.sub.append(d)
        if s.buf is not None: s.buf.append(d)
        elif s.chapter and s.section and not (s.in_eyebrow or s.in_title or s.in_h2 or s.in_sub):
            if s.text is None: s.text = []
            s.text.append(d)
    def flush_text(s):
        if s.text:
            t = clean("".join(s.text))
            if t: s.items.append(dict(kind="lesson", text=t, chapter=s.chapter, ctitle=s.ctitle, section=s.section, heading=s.heading))
        s.text = None

def clean(t):
    t = t.replace(" ", " "); t = re.sub(r"[ \t]+", " ", t); t = re.sub(r" *\n *", "\n", t); t = re.sub(r"\n{2,}", "\n", t); return t.strip()

def split(text, n=MAX):
    parts, cur = [], ""
    for para in text.split("\n"):
        while len(para) > n:
            cut = para.rfind(". ", 0, n); cut = cut + 1 if cut > 200 else n
            if cur: parts.append(cur); cur = ""
            parts.append(para[:cut].strip()); para = para[cut:].strip()
        if len(cur) + len(para) + 1 > n and cur: parts.append(cur); cur = ""
        cur = (cur + "\n" + para).strip() if cur else para
    if cur: parts.append(cur)
    return parts

def main(path, out):
    html = open(path, encoding="utf-8").read(); p = P(); p.feed(html); p.flush_text()
    rows = []; ords = {}
    # merge consecutive lesson items of the same section/heading; each special block stands alone
    merged = []
    for it in p.items:
        if merged and it["kind"] == "lesson" and merged[-1]["kind"] == "lesson" and (merged[-1]["section"], merged[-1]["heading"]) == (it["section"], it["heading"]):
            merged[-1]["text"] += "\n" + it["text"]
        else: merged.append(dict(it))
    for it in merged:
        for part in split(it["text"]):
            ch = it["chapter"]; ords[ch] = ords.get(ch, 0) + 1; sec = it["section"] or f"{ch}.0"
            head = it["heading"] or {"term": "Key term", "example": "Example", "worked": "Worked example", "insight": "Insight", "pitfall": "Common pitfall", "decision": "Decide first"}.get(it["kind"], "Overview")
            if it["kind"] == "term":
                m = re.match(r"([^\n:]{2,60})\n(.*)", part, re.S)
                if m: head = m.group(1).strip(); part = f"{m.group(1).strip()}: {m.group(2).strip()}"
            rows.append(dict(chunk_key=f"{SOURCE}:{sec}#{ords[ch]}", source_key=f"{SOURCE}:{sec}", chapter=ch, section=sec, heading=head[:160], kind=DBKIND[it["kind"]], ord=ords[ch],
                             title=f"Chapter {ch}, {it['ctitle']} — {sec} {head}"[:300], body=part, chapterTitle=it["ctitle"]))
    os.makedirs(os.path.join(out, "sql"), exist_ok=True)
    ver = hashlib.sha256(json.dumps([r["body"] for r in rows]).encode()).hexdigest()[:12]
    json.dump(dict(source=SOURCE, title=TITLE, version=ver, chunks=rows), open(os.path.join(out, "ma-textbook.chunks.json"), "w"), ensure_ascii=False)
    chapters = sorted({r["chapter"] for r in rows})
    for ch in chapters:
        cr = [{k: r[k] for k in ("chunk_key", "source_key", "chapter", "section", "heading", "kind", "ord", "title", "body")} for r in rows if r["chapter"] == ch]
        js = json.dumps(cr, ensure_ascii=False); assert "$aim_json$" not in js
        open(os.path.join(out, "sql", f"ch{ch:02d}.sql"), "w").write(f"-- ma-textbook chapter {ch} ({len(cr)} chunks), version {ver}. Replaces only this chapter. Run AFTER migration 107.\nselect public.ma_ai_upsert_chunks('{SOURCE}', '{ver}', {ch}, $aim_json${js}$aim_json$::jsonb, '{TITLE}');\n")
    print(f"{len(rows)} chunks in {len(chapters)} chapters, version {ver}")
    kinds = {}
    for r in rows: kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    print(kinds); print("chars:", sum(len(r["body"]) for r in rows))
if __name__ == "__main__": main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "content-macro")

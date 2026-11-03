#!/usr/bin/env python3
"""ingest-eq.py - turn the Econometrics textbook HTML into retrieval chunks for the eq_ai_* tables. No network, no dependencies.

  python3 tools/ingest-eq.py <path/to/econometrics-curriculum.html> [outDir=content]

Keeps lede, section text, tables (as text), definitions, propositions, key ideas, "Sharma's take", reading-the-output notes, derivations, assumptions, code listings.
DROPS exercises and their solutions, chapter quizzes, references, the run-your-own-data tool, arena banners, python cells (scripts), buttons, nav.
Writes outDir/eq-textbook.chunks.json: {source, title, version, chunks:[...]} with chunk_key, source_key, chapter, section, heading, kind, ord, title, body."""
import hashlib, json, re, sys, os
from html.parser import HTMLParser

SOURCE = "eq-textbook"; TITLE = "Econometrics: The Applied Curriculum (MacroNations textbook)"; MAX = 1200
SKIP = {"quiz", "exercises", "refs", "byod", "arena-banner", "python-cell", "soln", "sol-body", "crumb"}
SKIP_TAGS = {"script", "style", "button", "canvas", "svg", "select", "input", "nav", "noscript", "head", "textarea"}
SPECIAL = {"definition": "term", "key-idea": "notes", "sharma-take": "notes", "interp": "notes", "proposition": "lesson", "assumptions": "lesson", "maths": "lesson", "question-box": "lesson", "summary-box": "notes"}
LABEL = {"definition": "Definition", "key-idea": "Key idea", "sharma-take": "Instructor's take", "interp": "Reading the output", "proposition": "Proposition", "assumptions": "Assumptions", "maths": "Derivation", "question-box": "The question", "summary-box": "Chapter summary"}
VOID = {"br", "img", "hr", "input", "meta", "link", "col", "wbr", "source"}
BLOCK = {"p", "li", "div", "tr", "pre", "h1", "h2", "h3", "h4", "ul", "ol", "table", "summary", "details"}

def clean(t):
    t = t.replace(" ", " "); t = re.sub(r"[ \t]+", " ", t); t = re.sub(r" *\n *", "\n", t); t = re.sub(r"\n{2,}", "\n", t); return t.strip()

class P(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True)
        s.stack = []; s.skip = 0; s.chapter = 0; s.ctitle = ""; s.section = None; s.heading = ""
        s.items = []; s.buf = None; s.bufkey = None; s.text = None
        s.cap = None  # capture heading text: 'h1' | 'h2' | 'h3'
        s.cur = []
    def classes(s, attrs): return set((dict(attrs).get("class") or "").split())
    def handle_starttag(s, tag, attrs):
        if tag in VOID:
            if tag == "br" and not s.skip: s.add("\n")
            return
        c = s.classes(attrs); a = dict(attrs)
        if tag == "article" and "chapter" in c:   # sloppy HTML inside a skipped block must not swallow later chapters
            s.skip = 0; s.buf = None; s.bufkey = None; s.cap = None; s.stack = [(t, False, None) for t, _, _ in s.stack]
        skip = tag in SKIP_TAGS or bool(c & SKIP)
        special = next((k for k in SPECIAL if k in c), None)
        s.stack.append((tag, skip, special))
        if skip: s.skip += 1; return
        if s.skip: return
        if tag == "article" and "chapter" in c:
            s.flush_text(); s.chapter = int(a.get("data-ch") or (s.chapter + 1)); s.section = None; s.heading = ""; s.ctitle = ""; return
        if tag in ("h1", "h2", "h3") and s.chapter and s.buf is None:
            s.flush_text(); s.cap = tag; s.cur = []
        if special and s.buf is None:
            s.flush_text(); s.buf = []; s.bufkey = special
        if tag in BLOCK: s.add("\n")
    def add(s, d):
        if s.buf is not None: s.buf.append(d)
        elif s.chapter and not s.cap:
            if s.text is None: s.text = []
            s.text.append(d)
    def handle_endtag(s, tag):
        if tag in VOID or not s.stack: return
        while s.stack and s.stack[-1][0] != tag: s.stack.pop()
        if not s.stack: return
        _, skip, special = s.stack.pop()
        if skip: s.skip -= 1; return
        if s.skip: return
        if s.cap and tag == s.cap:
            t = re.sub(r"\s+", " ", "".join(s.cur)).strip(); s.cap = None
            if tag == "h1": s.ctitle = t; s.heading = ""
            elif tag == "h2":
                m = re.match(r"(\d+\.\d+)\s*(.*)", t); s.section = m.group(1) if m else t; s.heading = (m.group(2) if m else t).strip(" -—")
            elif tag == "h3":
                if not re.match(r"(Exercises|References|Chapter \d+ Quiz)", t): s.heading = t
            return
        if special and s.buf is not None and not any(x[2] for x in s.stack) and special == s.bufkey:
            txt = clean("".join(s.buf)); key = s.bufkey; s.buf = None; s.bufkey = None
            if txt: s.items.append(dict(kind=SPECIAL[key], label=LABEL[key], text=txt, chapter=s.chapter, ctitle=s.ctitle, section=s.section, heading=s.heading))
            return
        if tag in ("td", "th"): s.add(" | ")
        if tag in BLOCK: s.add("\n")
    def handle_data(s, d):
        if s.skip: return
        if s.cap: s.cur.append(d); return
        s.add(d)
    def flush_text(s):
        if s.text:
            t = clean("".join(s.text))
            if t: s.items.append(dict(kind="lesson", label=None, text=t, chapter=s.chapter, ctitle=s.ctitle, section=s.section, heading=s.heading))
        s.text = None

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
    p = P(); p.feed(open(path, encoding="utf-8").read()); p.flush_text()
    merged = []
    for it in p.items:
        if merged and it["kind"] == "lesson" and it["label"] is None and merged[-1]["kind"] == "lesson" and merged[-1]["label"] is None and (merged[-1]["chapter"], merged[-1]["section"], merged[-1]["heading"]) == (it["chapter"], it["section"], it["heading"]):
            merged[-1]["text"] += "\n" + it["text"]
        else: merged.append(dict(it))
    rows = []; ords = {}
    for it in merged:
        for part in split(it["text"]):
            ch = it["chapter"]; ords[ch] = ords.get(ch, 0) + 1; sec = it["section"] or f"{ch}.0"
            head = it["label"] or it["heading"] or "Overview"
            if it["label"] and it["heading"]: head = f"{it['label']} ({it['heading']})"
            rows.append(dict(chunk_key=f"{SOURCE}:{sec}#{ords[ch]}", source_key=f"{SOURCE}:{sec}", chapter=ch, section=sec, heading=head[:160], kind=it["kind"], ord=ords[ch],
                             title=f"Chapter {ch}, {it['ctitle']} — {sec} {head}"[:300], body=part))
    os.makedirs(out, exist_ok=True)
    ver = hashlib.sha256(json.dumps([r["body"] for r in rows]).encode()).hexdigest()[:12]
    json.dump(dict(source=SOURCE, title=TITLE, version=ver, chunks=rows), open(os.path.join(out, "eq-textbook.chunks.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    chapters = sorted({r["chapter"] for r in rows}); kinds = {}
    for r in rows: kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    print(f"{len(rows)} chunks in {len(chapters)} chapters, version {ver}"); print(kinds); print("chars:", sum(len(r["body"]) for r in rows))
    print({c: sum(1 for r in rows if r["chapter"] == c) for c in chapters})
if __name__ == "__main__": main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "content")

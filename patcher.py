"""FFT Patcher - local patch tool for the WallSpectrum bot. Standard library only.
Keep this file in the same folder as wallspectrum_local.py, index.html, tickchart.js, ui.js, app.css.
This file can patch itself too (tick "tool"); close and start the patcher again afterwards to use the new version.
Run: double-click start_patcher.bat (or: python patcher.py).
Self test (no bot files needed): python patcher.py --selftest
Check YOUR bot files against the lite logic: python patcher.py --check

Payload modes (same logic as the extension's patch workspace):
  U user instruction | P patch-format prompt | S source code | L lite (big files are not sent whole)
  - L on + big file + plain instruction  -> INDEX: a list of numbered parts, no code. Paste to the AI.
  - add @part3 / @functionName tags      -> LITE: only those parts (plus small files in full).
  - @auto                                -> LITE: the parts that best match the words of the instruction.
  - L off, or only small files           -> FULL: every selected file in full.
Patch blocks may start with a line  ==== FILE: name ====  to name the file they belong to."""
import os, sys, re, json, time, shutil, threading, subprocess, atexit, collections, webbrowser, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PATCHER = Path(__file__).resolve().name
FILES = ["wallspectrum_local.py", "index.html", "tickchart.js", "ui.js", "app.css", PATCHER]
BOT = "wallspectrum_local.py"
RUN_HASH = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()  # the version that is running now
BK = HERE / "backups"
PORT = 8800
BOOT = str(time.time())
SIG = "\u200b\u200b\u200b"
LOCK = threading.RLock()
S = {"proc": None, "port": None, "gen": 0, "reload": 0, "err": "", "log": collections.deque(maxlen=400)}
# Starts the bot unchanged, but blocks its automatic browser tab (the preview lives inside this app).
STUB = "import sys,runpy,webbrowser;webbrowser.open=lambda *a,**k:False;p=sys.argv[1];sys.argv=[p];runpy.run_path(p,run_name='__main__')"

SUPER = """Reply with ONLY code blocks of Find-and-Replace patches. Inside one code block put the OLD code, then a line with exactly ===SPLIT===, then the NEW code. For several independent changes separate each OLD===SPLIT===NEW pair with a line ===BLOCK=== (all in the same code block).
Rules:
- The files below are one project; each starts with "==== FILE: name ====". OLD must be copied EXACTLY (same indentation and spacing) and must match exactly ONE place. Add a few surrounding lines so it is unique.
- For every patch put a line ==== FILE: name ==== directly before its OLD code (inside the code block). OLD then only has to be unique inside that file. Never put FILE or PART header lines inside the OLD or NEW code itself.
- Large files may be shown only in parts ("=== PART n ..."). Copy OLD only from the code shown and never include PART lines.
- Python indentation is syntax: use 4 spaces like the file, never tabs, and keep NEW consistent with the code around it.
- Do not rewrite or reformat code you are not changing. All other behaviour must stay exactly as it is.
- If a name or value is shared between the Python backend and ui.js / tickchart.js / index.html, change every place so they stay in sync.
- Never declare the same variable twice in one scope. Make sure no bracket or parenthesis is left unclosed.
- No explanations, warnings or comments about the patch inside the code blocks. If you have a concern, write it in plain text BEFORE the code block.
Request:"""


# ───────────────────────── files / patch parsing ─────────────────────────
def load():
    files, crlf = {}, {}
    for n in FILES:
        t = (HERE / n).read_bytes().decode("utf-8")
        crlf[n] = "\r\n" in t
        files[n] = t.replace("\r\n", "\n")
    return files, crlf


FILE_HDR = re.compile(r"^[ \t]*={3,}\s*FILE:\s*(.+?)\s*={3,}[ \t]*\n?", re.I | re.M)
SPLIT_RE = re.compile(r"={3}\s*SPLIT\s*={3}")
BLOCK_RE = re.compile(r"={3}\s*BLOCK[^=\n]*={3}")


def parse(text):
    """-> list of (old, new, file_name_or_None, file_hint_or_None).
    file_name = a ==== FILE: x ==== line inside this block. file_hint = the last file named in an earlier block."""
    t = text.replace("\r\n", "\n").replace("\u200b", "")
    t = re.sub(r"//\s*(OLD|NEW)\s*CHUNK\s*", "", t, flags=re.I)
    t = re.sub(r"^```\w*\n?", "", t, flags=re.M)
    out, carry = [], None
    for unit in BLOCK_RE.split(t):
        fname = None
        fm = FILE_HDR.search(unit)
        if fm:
            fname = fm.group(1).strip()
            unit = unit[:fm.start()] + unit[fm.end():]
        m = SPLIT_RE.search(unit)
        if not m:
            if fname:
                carry = fname
            continue
        old, new = unit[:m.start()].strip("\n").rstrip(), unit[m.end():].strip("\n").rstrip()
        out.append((old, new, fname, carry))
        if fname:
            carry = fname
    return out


def resolve_name(files, nm):
    if not nm:
        return None
    base = nm.replace("\\", "/").split("/")[-1].strip().lower()
    for n in files:
        if n.lower() == base:
            return n
    return None


def locate(files, old, only=None):
    pool = {only: files[only]} if only else files
    hits = []
    for n, s in pool.items():
        i = s.find(old)
        while i != -1:
            hits.append((n, i, i + len(old)))
            i = s.find(old, i + 1)
    if hits:
        return hits
    rx = re.compile("[ \t]*\n".join(re.escape(l.rstrip()) for l in old.split("\n")))  # tolerate trailing spaces only
    for n, s in pool.items():
        hits += [(n, m.start(), m.end()) for m in rx.finditer(s)]
    return hits


def apply_blocks(files, blocks):
    """Applies every block to the files dict (in memory). Returns the set of changed file names."""
    changed = set()
    for k, (old, new, fname, hint) in enumerate(blocks, 1):
        if not old:
            raise ValueError("Block %d has an empty OLD part." % k)
        only = resolve_name(files, fname)
        hits, where = [], "any file"
        if only:
            hits, where = locate(files, old, only), only
        else:
            h = resolve_name(files, hint)
            if h:
                hits = locate(files, old, h)
            if not hits:
                hits = locate(files, old)
        if not hits:
            raise ValueError("Block %d: OLD text not found in %s:\n\"%s%s\"" % (k, where, old[:140], "..." if len(old) > 140 else ""))
        if len(hits) > 1:
            raise ValueError("Block %d: OLD text matches %d places (%s).\nSend a bigger, more unique chunk (or add a ==== FILE: name ==== line)." % (k, len(hits), ", ".join(sorted({h[0] for h in hits}))))
        n, a, b = hits[0]
        files[n] = files[n][:a] + new + files[n][b:]
        changed.add(n)
    return changed


def selfcheck(text):
    """New patcher.py must load (top-level code runs, main(), PAGE ... exist) before it replaces the running one."""
    tmp = HERE / ("_chk_" + PATCHER)
    code = ("import runpy,sys;g=runpy.run_path(sys.argv[1],run_name='fft_check');"
            "m=[k for k in ('main','PAGE','apply_patch','load','FILES','H') if k not in g];"
            "sys.exit('missing: '+', '.join(m) if m else 0)")
    try:
        tmp.write_bytes(text.encode("utf-8"))
        r = subprocess.run([sys.executable, "-c", code, str(tmp)], capture_output=True, text=True, timeout=30, cwd=str(HERE))
    except subprocess.TimeoutExpired:
        raise ValueError("%s did not finish loading in 30 s - nothing was changed." % PATCHER)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    if r.returncode != 0:
        raise ValueError("%s fails to load - nothing was changed.\n%s" % (PATCHER, (r.stderr or "").strip()[-600:]))


def stale():
    try:
        return hashlib.sha256((HERE / PATCHER).read_bytes()).hexdigest() != RUN_HASH
    except OSError:
        return False


def apply_patch(text):
    blocks = parse(text)
    if not blocks:
        raise ValueError("No valid patch found in the clipboard.\n\nExpected: [==== FILE: name ====] OLD code, a line ===SPLIT===, NEW code.\nSeveral patches: separate each pair with ===BLOCK===.")
    files, crlf = load()
    changed = apply_blocks(files, blocks)
    for n in changed:
        if n.endswith(".py"):
            try:
                compile(files[n], n, "exec")  # parse only, nothing is executed
            except SyntaxError as e:
                raise ValueError("%s would not parse - nothing was changed.\nLine %s: %s\n%s" % (n, e.lineno, e.msg, (e.text or "").strip()))
    if PATCHER in changed:
        selfcheck(files[PATCHER])
    ts = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % int(time.time() % 1 * 1000)
    d = BK / ts
    d.mkdir(parents=True)
    for n in changed:
        shutil.copy2(HERE / n, d / n)
        data = files[n].replace("\n", "\r\n") if crlf[n] else files[n]
        tmp = HERE / (n + ".tmp")
        tmp.write_bytes(data.encode("utf-8"))
        os.replace(tmp, HERE / n)
    return ts, sorted(changed)


def undo_last():
    dirs = sorted(d for d in BK.glob("*") if d.is_dir() and not d.name.startswith("_") and not d.name.endswith("_undone"))
    if not dirs:
        raise ValueError("Nothing to undo.")
    d = dirs[-1]
    names = [f.name for f in d.iterdir()]
    for n in names:
        tmp = HERE / (n + ".tmp")
        shutil.copy2(d / n, tmp)
        os.replace(tmp, HERE / n)
    d.rename(d.with_name(d.name + "_undone"))
    return names


# ───────────────────────── LITE MODE: big files are sent as parts ─────────────────────────
LITE_MIN_LINES = 400      # a file with this many lines (or LITE_MIN_CHARS characters) is "big"
LITE_MIN_CHARS = 30000
LITE_CHUNK_CHARS = 9000   # a part is also cut when it gets this large (keeps long-line CSS in sane pieces)
LITE_BUDGET = 60000       # max characters of auto-picked parts
LITE_STOP = set("the and for with that this from into make change please then when also should would could just have are was but you your its all any can will get need want".split())
_B_JS = re.compile(r"^\s*(<script\b|<style\b|<!--|/\*\s*[-=]{3,}|(async\s+)?function\s+\w|class\s+\w|(const|let|var)\s+\w+\s*=\s*(async\s*)?(function\b|\([^)]*\)\s*=>))")
_B_PY = re.compile(r"^(async\s+def\s+\w|def\s+\w|class\s+\w|@\w|#\s*[\u2500=\-]{3,})")
_B_CSS = re.compile(r"^/\*\s*[-=]{3,}")
_CLOSE = re.compile(r"</(script|style)>\s*$")
_NAME_RE = re.compile(r'function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\('
                      r'|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)'
                      r'|id="([\w$-]+)"'
                      r'|^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)'
                      r'|^[ \t]*class[ \t]+(\w+)'
                      r'|^([A-Z_][A-Z0-9_]{2,})[ \t]*=', re.M)
_LC = {"key": None, "chunks": []}  # cache: the parts are rebuilt only when file contents change


def _bound_for(name):
    if name.endswith(".py"):
        return _B_PY
    if name.endswith(".css"):
        return _B_CSS
    return _B_JS


def _names(fname, t):
    names = []

    def add(nm):
        if nm and nm not in names and len(names) < 10:
            names.append(nm)

    if fname.endswith(".css"):
        for m in re.finditer(r"#([A-Za-z_][\w-]*)", t):
            if not re.fullmatch(r"[0-9A-Fa-f]{3,8}", m.group(1)):
                add(m.group(1))
    else:
        for m in _NAME_RE.finditer(t):
            add(next((g for g in m.groups() if g), None))
    return names


def lite_build(files):
    """Splits every big file into numbered parts: [{n, file, s, e, t, low, names}]."""
    key = tuple((n, hash(t)) for n, t in files.items())
    if _LC["key"] == key:
        return _LC["chunks"]
    out = []
    for fname, text in files.items():
        L = text.split("\n")
        N = len(L)
        if N < LITE_MIN_LINES and len(text) < LITE_MIN_CHARS:
            continue
        bound, use_close = _bound_for(fname), fname.endswith((".html", ".js"))
        cuts, st, acc = [0], 0, 0
        for i in range(1, N):
            acc += len(L[i - 1]) + 1
            ln = i - st
            edge = bound.match(L[i]) or (use_close and _CLOSE.search(L[i - 1]))
            if (edge and ln >= 40) or ln >= 150 or (acc >= LITE_CHUNK_CHARS and ln >= 8):
                cuts.append(i)
                st, acc = i, 0
        for c, s in enumerate(cuts):
            e = cuts[c + 1] if c + 1 < len(cuts) else N
            t = "\n".join(L[s:e])
            out.append({"n": len(out) + 1, "file": fname, "s": s + 1, "e": e, "t": t, "low": t.lower(), "names": _names(fname, t)})
    _LC["key"], _LC["chunks"] = key, out
    return out


def lite_words(instr):
    s = re.sub(r"@[\w$-]+", " ", instr or "").lower()
    out = []
    for w in re.findall(r"[a-z0-9_$#.\-]{3,}", s):
        w = w.strip(".-")
        if len(w) >= 3 and w not in out and w not in LITE_STOP:
            out.append(w)
    return out


def lite_tags(instr):
    return [x[1:].lower() for x in re.findall(r"@[\w$-]+", instr or "")]


def lite_index(files, instr):
    """INDEX MODE text: numbered parts with labels, no code."""
    chunks = lite_build(files)
    hit_info = {}
    for w in lite_words(instr):
        hit = [c for c in chunks if w in c["low"]]
        if not hit or len(hit) > len(chunks) * 0.25:
            continue
        for c in hit:
            hit_info.setdefault(c["n"], []).append(w)
    lines = []
    for c in chunks:
        label = ", ".join(c["names"][:8])
        if not label:
            first = next((x.strip() for x in c["t"].split("\n") if x.strip()), "")
            label = "(" + first[:60] + ")"
        h = hit_info.get(c["n"])
        lines.append("PART %d %s L%d-%d: %s%s" % (c["n"], c["file"], c["s"], c["e"], label, ("  <<MATCH: %s>>" % ", ".join(h[:4])) if h else ""))
    big = {c["file"] for c in chunks}
    small = ["%s (%d lines)" % (f, t.count("\n") + 1) for f, t in files.items() if f not in big]
    return ("[INDEX MODE: No code is attached on purpose. The request is the text above. Reply in plain text with ONE line only: the request copied exactly, "
            "followed by @partN tags for every part you must see to write the patch (parts marked MATCH contain words from the request). "
            "Pick as few parts as possible, but include every part where the edit or its dependencies live. Small files are always attached in full, "
            "so tag only PART numbers. Do not write any patch yet.]\n\n"
            "=== PARTS (%d total) ===\n%s\n\n=== SMALL FILES (attached in full later) ===\n%s" % (len(chunks), "\n".join(lines), "\n".join(small)))


def lite_source(files, instr):
    """LITE MODE text: tagged / best matching parts of big files, small files in full."""
    chunks = lite_build(files)
    tags = lite_tags(instr)
    forced = [c["n"] for c in chunks
              if ("part%d" % c["n"]) in tags or ("p%d" % c["n"]) in tags or any(x.lower() in tags for x in c["names"])]
    scores = {}
    for w in lite_words(instr):
        hit = [c for c in chunks if w in c["low"]]
        if not hit or len(hit) > len(chunks) * 0.25:
            continue
        for c in hit:
            scores[c["n"]] = scores.get(c["n"], 0) + min(c["low"].count(w), 5) / len(hit)
    rank = []
    if not forced:
        used = 0
        for c in sorted((c for c in chunks if scores.get(c["n"], 0) > 0), key=lambda c: -scores[c["n"]]):
            if used + len(c["t"]) > LITE_BUDGET:
                continue
            used += len(c["t"])
            rank.append(c["n"])
        rank = rank[:12]
    sel = forced + rank
    picked = set(sel)
    out = ["[LITE MODE: some files are large, so only the relevant parts of them are shown below (small files are shown in full). "
           "Reply with ==== FILE: name ==== headers and OLD===SPLIT===NEW blocks whose OLD text is copied exactly from the parts shown and is unique in that whole file "
           "(include a few surrounding lines). If you need a part that is not shown, reply in plain text with only its name from the list, like @functionName.]"]
    if not sel:
        out.append("(No part of the large files matched the instruction. Name one with @name.)")
    for fname, text in files.items():
        mine = [c for c in chunks if c["file"] == fname]
        if not mine:
            out.append("==== FILE: %s ====\n%s" % (fname, text.strip()))
            continue
        shown = [c for c in mine if c["n"] in picked]
        if not shown:
            continue
        out.append("==== FILE: %s (partial: only the parts below are shown) ====\n%s" % (
            fname, "\n\n".join("=== PART %d (lines %d-%d) ===\n%s" % (c["n"], c["s"], c["e"], c["t"]) for c in shown)))
    rest = ["%d %s L%d-%d: %s" % (c["n"], c["file"], c["s"], c["e"], ", ".join(c["names"][:5]))
            for c in chunks if c["n"] not in picked and c["names"]][:300]
    out.append("=== OTHER PARTS (names only) ===\n" + "\n".join(rest))
    return "\n\n".join(out)


def lite_auto_tags(files, instr, clip):
    """@tags found in the clipboard (the AI's reply to the index) that name real parts are added to the instruction."""
    if not clip or len(clip) > 4000 or any(k in clip for k in ("LITE MODE", "INDEX MODE", "==SPLIT")):
        return instr, 0
    found = re.findall(r"@[\w$-]+", clip)
    if not found:
        return instr, 0
    known = set()
    for c in lite_build(files):
        known.add("part%d" % c["n"])
        known.add("p%d" % c["n"])
        known.update(x.lower() for x in c["names"])
    have, add = set(lite_tags(instr)), []
    for t in found:
        k = t[1:].lower()
        if k in known and k not in have and k not in [a[1:].lower() for a in add]:
            add.append(t)
    if not add:
        return instr, 0
    return (instr.strip() + " " + " ".join(add)).strip(), len(add)


def build_payload_from(files, instr, user=True, sup=True, src=True, lite=True, clip=""):
    instr = (instr or "").strip()
    added = 0
    if lite and src and clip:
        instr, added = lite_auto_tags(files, instr, clip)
    tags = lite_tags(instr)
    auto = "auto" in tags
    has_tags = any(t != "auto" for t in tags)
    big = bool(src and lite and lite_build(files))
    idx = bool(big and user and instr and not has_tags and not auto)
    parts = []
    if sup and not idx:
        parts.append(SUPER)
        if user and instr:
            parts.append(instr)
    elif user and instr:
        parts.append("User Instruction: " + instr)
    if src:
        if idx:
            parts.append(lite_index(files, instr))
        elif big:
            parts.append(lite_source(files, instr))
        else:
            parts.append("\n\n".join("==== FILE: %s ====\n%s" % (n, t) for n, t in files.items()))
    if not parts:
        raise ValueError("Nothing to copy - turn on at least one of U / P / S.")
    text = "\n\n".join(p for p in parts if p) + SIG
    after = re.sub(r"\s*@[\w$-]+", "", instr).strip() if (has_tags or auto) else instr
    return {"text": text, "chars": len(text), "mode": "index" if idx else ("lite" if big else "full"), "instr": after, "added": added}


def build_payload(instr, names, user=True, sup=True, src=True, lite=True, clip=""):
    allf, _ = load()
    files = {n: allf[n] for n in FILES if n in (names or [])}
    if src and not files:
        raise ValueError("No files selected - tick at least one file letter.")
    return build_payload_from(files, instr, bool(user), bool(sup), bool(src), bool(lite), str(clip or ""))


# ───────────────────────── bot process ─────────────────────────
def pump(p):
    for line in p.stdout:
        line = line.rstrip()
        S["log"].append(line)
        m = re.search(r"WallSpectrum: http://[\d.]+:(\d+)", line)
        if m and S["proc"] is p:
            S["port"] = int(m.group(1))


def stop_bot():
    p = S["proc"]
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(5)
        except Exception:
            p.kill()


def start_bot():
    with LOCK:
        stop_bot()
        S["port"] = None
        S["gen"] += 1
        S["log"].append("--- starting %s ---" % BOT)
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        p = subprocess.Popen([sys.executable, "-u", "-c", STUB, BOT], cwd=str(HERE), env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
        S["proc"] = p
        threading.Thread(target=pump, args=(p,), daemon=True).start()


def after_change(changed, watch):
    """Python file changed -> restart the bot (and roll back if it dies on startup). Front-end only -> reload preview."""
    if any(n.endswith(".py") and n != PATCHER for n in changed):
        start_bot()
        if watch:
            t0 = time.time()
            while time.time() - t0 < 20:
                time.sleep(0.5)
                if S["proc"].poll() is not None:
                    tail = "\n".join(list(S["log"])[-15:])
                    try:
                        undo_last()
                    except Exception:
                        pass
                    start_bot()
                    S["err"] = "The new version crashed on startup. The previous version was restored and restarted.\n\n" + tail
                    return
    if any(n != PATCHER for n in changed):
        S["reload"] += 1
    if PATCHER in changed:
        restart_self()


def restart_self():
    try:
        time.sleep(1.5)
        stop_bot()
        env = dict(os.environ, FFT_PORT=str(S.get("hport") or PORT))
        args = [sys.executable, str(HERE / PATCHER)] + sys.argv[1:]
        if os.name == "nt":
            subprocess.Popen(args, cwd=str(HERE), env=env)
            os._exit(0)
        os.execve(sys.executable, args, env)
    except Exception as e:
        S["err"] = "The patcher could not restart itself (%s). Close the patcher window and start it again." % e
        start_bot()


# ---------------- GITHUB PUSH (button gp) ----------------
import base64, urllib.request, urllib.error
FB_CFG_URL = "https://system-data-bf026-default-rtdb.asia-southeast1.firebasedatabase.app/aicompiler/gh_config.json"
PUSH_FILES = ["wallspectrum_local.py", "requirements.txt", "index.html", "tickchart.js", "ui.js", "app.css"]
PUSH_ROOT = {"wallspectrum_local.py", "requirements.txt"}  # always at the repo top; the rest go to static/ when the repo already has static/index.html
PUSH_REPO = "888znq/mtty2k"
PUSH_REPO_HINT = "fftbot"  # only a repo whose name contains this is pushed to ("" = use the default repo of the config)


def _ssl_ctx():
    import ssl
    if os.environ.get("FFT_INSECURE_SSL") == "1":
        return ssl._create_unverified_context()
    try:
        import certifi
    except ImportError:
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "certifi"])
            import certifi
        except Exception:
            return None
    return ssl.create_default_context(cafile=certifi.where())


def _http(method, url, token=None, body=None):
    hdr = {"User-Agent": "fft-patcher", "Accept": "application/vnd.github+json"}
    data = None
    if token:
        hdr["Authorization"] = "Bearer " + token
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    ctx = None
    tried = False
    while True:
        try:
            with urllib.request.urlopen(req, timeout=40, context=ctx) as r:
                raw = r.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            msg = raw
            try:
                j = json.loads(raw)
                if isinstance(j, dict):
                    msg = j.get("message") or j.get("error") or raw
            except ValueError:
                pass
            raise ValueError("HTTP %d on %s %s: %s" % (e.code, method, url.split("?")[0][-70:], str(msg)[:300]))
        except urllib.error.URLError as e:
            if not tried and "CERTIFICATE_VERIFY_FAILED" in str(e.reason):
                tried = True
                ctx = _ssl_ctx()
                if ctx is not None:
                    continue
            raise ValueError("Network error: %s" % e.reason)
    return json.loads(raw) if raw.strip() else None


def _pick(cfg, names):
    low = {str(k).lower(): v for k, v in cfg.items()}
    for n in names:
        v = low.get(n.lower())
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _gh_cfg():
    cfg = _http("GET", FB_CFG_URL)
    if not isinstance(cfg, dict):
        raise ValueError("Firebase has no data at aicompiler/gh_config.")
    token = _pick(cfg, ["token", "ghToken", "pat", "accessToken"])
    if not token:
        raise ValueError("No token found in the Firebase config. Keys there: %s" % ", ".join(sorted(str(k) for k in cfg.keys())))
    user = _pick(cfg, ["user", "username", "ghUser", "owner"])
    want = _pick(cfg, ["branch", "ghBranch"])
    if PUSH_REPO:
        return token, PUSH_REPO, want
    repos = []
    for v in cfg.values():
        items = list(v.values()) if isinstance(v, dict) else (v if isinstance(v, list) else [])
        items = [x for x in items if x]
        if items and all(isinstance(x, dict) and x.get("name") for x in items):
            repos = items
            break
    name = ""
    if repos:
        hint = PUSH_REPO_HINT.lower()
        if hint:
            for x in repos:
                if hint in str(x["name"]).lower():
                    name = str(x["name"])
                    break
            if not name:
                raise ValueError("No repo with '%s' in its name. Repos in the config: %s" % (PUSH_REPO_HINT, ", ".join(str(x["name"]) for x in repos)))
        else:
            d = next((x for x in repos if x.get("isDefault")), repos[0])
            name = str(d["name"])
    else:
        name = _pick(cfg, ["repo", "repository"])
    name = name.strip().strip("/")
    if not name:
        raise ValueError("No repo found in the Firebase config. Keys there: %s" % ", ".join(sorted(str(k) for k in cfg.keys())))
    if "/" not in name:
        if not user:
            raise ValueError("Repo '%s' has no owner and the config has no username." % name)
        name = user + "/" + name
    return token, name, want


def gh_push(dry=False):
    token, repo, want = _gh_cfg()
    api = "https://api.github.com/repos/" + repo
    info = _http("GET", api, token)
    note = ""
    branch = want or info.get("default_branch") or "main"
    try:
        ref = _http("GET", api + "/git/ref/heads/" + branch, token)
    except ValueError as e:
        if want and "HTTP 404" in str(e):
            branch = info.get("default_branch") or "main"
            note = " (branch '%s' not found, used '%s')" % (want, branch)
            ref = _http("GET", api + "/git/ref/heads/" + branch, token)
        else:
            raise
    head = ref["object"]["sha"]
    commit = _http("GET", api + "/git/commits/" + head, token)
    base_tree = commit["tree"]["sha"]
    tree = _http("GET", api + "/git/trees/" + base_tree + "?recursive=1", token)
    have = {t["path"]: t["sha"] for t in tree.get("tree", []) if t.get("type") == "blob"}
    pre = "static/" if "static/index.html" in have else ""
    ents, same, plan = [], 0, []
    for n in PUSH_FILES:
        p = HERE / n
        if not p.is_file():
            if n == "requirements.txt":
                continue
            raise ValueError("%s is missing next to the patcher." % n)
        data = p.read_bytes().replace(b"\r\n", b"\n")
        path = n if n in PUSH_ROOT else pre + n
        sha1 = hashlib.sha1((b"blob %d\0" % len(data)) + data).hexdigest()
        if have.get(path) == sha1:
            same += 1
            plan.append("  same     " + path)
            continue
        plan.append("  %-8s %s" % ("UPDATE" if path in have else "NEW", path))
        if dry:
            continue
        blob = _http("POST", api + "/git/blobs", token, {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})
        ents.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    if dry:
        lay = "static/ folder" if pre else "repo top level"
        warn = []
        if "wallspectrum_local.py" not in have:
            warn.append("This repo has no bot files yet - this will be the first push.")
        return "Target: %s@%s%s\n%s\nLast commit: %s (%s)\nFront-end files go to: %s\n\n%s\n\n%d to push, %d identical%s" % (
            repo, branch, note, info.get("html_url", ""), str(commit.get("message", "")).split("\n")[0][:80],
            str(commit.get("author", {}).get("date", ""))[:10], lay, "\n".join(plan), len(plan) - same, same,
            ("\n\n" + "\n".join(warn)) if warn else "")
    if not ents:
        return "%s@%s is already identical (%d files) - nothing to push.%s" % (repo, branch, same, note)
    nt = _http("POST", api + "/git/trees", token, {"base_tree": base_tree, "tree": ents})
    nc = _http("POST", api + "/git/commits", token, {"message": "Update from FFT Patcher " + time.strftime("%Y-%m-%d %H:%M:%S"), "tree": nt["sha"], "parents": [head]})
    _http("PATCH", api + "/git/refs/heads/" + branch, token, {"sha": nc["sha"]})
    return "Pushed %d file(s) to %s@%s (%s) - Render will redeploy.%s" % (len(ents), repo, branch, ", ".join(e["path"] for e in ents), note)


def gh_pull(dry=False):
    token, repo, want = _gh_cfg()
    api = "https://api.github.com/repos/" + repo
    info = _http("GET", api, token)
    note = ""
    branch = want or info.get("default_branch") or "main"
    try:
        ref = _http("GET", api + "/git/ref/heads/" + branch, token)
    except ValueError as e:
        if want and "HTTP 404" in str(e):
            branch = info.get("default_branch") or "main"
            note = " (branch '%s' not found, used '%s')" % (want, branch)
            ref = _http("GET", api + "/git/ref/heads/" + branch, token)
        else:
            raise
    commit = _http("GET", api + "/git/commits/" + ref["object"]["sha"], token)
    tree = _http("GET", api + "/git/trees/" + commit["tree"]["sha"] + "?recursive=1", token)
    have = {t["path"]: t["sha"] for t in tree.get("tree", []) if t.get("type") == "blob"}
    pre = "static/" if "static/index.html" in have else ""
    todo, same, plan = [], 0, []
    for n in PUSH_FILES:
        path = n if n in PUSH_ROOT else pre + n
        if path not in have:
            plan.append("  not in repo  " + path)
            continue
        p = HERE / n
        if p.is_file():
            data = p.read_bytes().replace(b"\r\n", b"\n")
            if hashlib.sha1((b"blob %d\0" % len(data)) + data).hexdigest() == have[path]:
                same += 1
                plan.append("  same         " + n)
                continue
        plan.append("  %-12s %s" % ("REPLACE" if p.is_file() else "NEW", n))
        todo.append((n, path))
    head = "%s@%s%s" % (repo, branch, note)
    if not todo:
        return "Nothing to pull from %s: %d identical, the others are not in the repo.\n\n%s" % (head, same, "\n".join(plan)), []
    if dry:
        return "Pull from %s\n\n%s\n\n%d file(s) will be replaced in this folder (old versions are saved first)." % (head, "\n".join(plan), len(todo)), []
    got = {}
    for n, path in todo:
        blob = _http("GET", api + "/git/blobs/" + have[path], token)
        data = base64.b64decode(blob["content"])
        if hashlib.sha1((b"blob %d\0" % len(data)) + data).hexdigest() != have[path]:
            raise ValueError("Download of %s is corrupt - nothing was changed." % n)
        if n.endswith(".py"):
            compile(data.decode("utf-8"), n, "exec")
        got[n] = data
    bdir = HERE / "pull_backups" / time.strftime("%Y%m%d_%H%M%S")
    bdir.mkdir(parents=True, exist_ok=True)
    for n in got:
        if (HERE / n).is_file():
            shutil.copy2(str(HERE / n), str(bdir / n))
    for n, data in got.items():
        (HERE / n).write_bytes(data)
    return "Pulled %d file(s) from %s: %s. Old versions saved in pull_backups\\%s" % (len(got), head, ", ".join(got), bdir.name), list(got)


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--status":
    try:
        print(gh_push(True).encode("ascii", "replace").decode("ascii"))
    except Exception as e:
        print("ERROR: %s" % e)
    sys.exit(0)


ALOG = collections.deque(maxlen=500)


def alog(msg):
    line = time.strftime("%H:%M:%S") + "  " + str(msg).replace("\r", "").strip()
    ALOG.append(line)
    try:
        with open(HERE / "patcher_log.txt", "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d ") + line.replace("\n", " | ") + "\n")
    except OSError:
        pass


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, ctype="application/json", code=200):
        if self.command == "POST" and code == 200 and self.path not in ("/api/clearerr", "/api/logclear"):
            try:
                j = json.loads(body)
                if j.get("ok"):
                    det = j.get("msg") or (", ".join(j["files"]) if j.get("files") else "") or (j.get("mode") or "")
                    alog("%s ok %s" % (self.path[5:], str(det).split("\n")[0][:300]))
                else:
                    alog("%s ERROR %s" % (self.path[5:], str(j.get("error", "")).replace("\n", " ")[:300]))
            except Exception:
                pass
        b = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            return self.send(PAGE.replace("__FILES__", json.dumps(FILES)), "text/html")
        if path == "/api/log":
            return self.send(json.dumps({"log": "\n".join(ALOG)}))
        if path == "/api/status":
            p = S["proc"]
            return self.send(json.dumps({"running": bool(p and p.poll() is None), "port": S["port"], "gen": S["gen"],
                                         "reload": S["reload"], "err": S["err"], "stale": stale(), "boot": BOOT, "log": "\n".join(S["log"])}))
        self.send("{}", code=404)

    def do_POST(self):
        if self.headers.get("X-FFT") != "1" or not re.match(r"^(127\.0\.0\.1|localhost)(:\d+)?$", self.headers.get("Host", "")):
            return self.send("{}", code=403)
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
        d = json.loads(raw) if raw else {}
        try:
            if self.path == "/api/payload":
                r = build_payload(d.get("instr", ""), d.get("files", []), d.get("user", True), d.get("sup", True),
                                  d.get("src", True), d.get("lite", True), d.get("clip", ""))
                r["ok"] = True
                return self.send(json.dumps(r))
            if self.path == "/api/apply":
                with LOCK:
                    ts, changed = apply_patch(d.get("text", ""))
                S["err"] = ""
                threading.Thread(target=after_change, args=(changed, True), daemon=True).start()
                return self.send(json.dumps({"ok": True, "files": changed}))
            if self.path == "/api/undo":
                with LOCK:
                    names = undo_last()
                S["err"] = ""
                threading.Thread(target=after_change, args=(names, False), daemon=True).start()
                return self.send(json.dumps({"ok": True, "files": names}))
            if self.path == "/api/restart":
                threading.Thread(target=start_bot, daemon=True).start()
                return self.send(json.dumps({"ok": True}))
            if self.path == "/api/quit":
                self.send(json.dumps({"ok": True}))
                stop_bot()
                threading.Timer(0.3, os._exit, args=(0,)).start()
                return
            if self.path == "/api/ghcheck":
                return self.send(json.dumps({"ok": True, "msg": gh_push(True)}))
            if self.path == "/api/glcheck":
                return self.send(json.dumps({"ok": True, "msg": gh_pull(True)[0]}))
            if self.path == "/api/ghpull":
                with LOCK:
                    msg, changed = gh_pull()
                S["err"] = ""
                if changed:
                    threading.Thread(target=after_change, args=(changed, False), daemon=True).start()
                return self.send(json.dumps({"ok": True, "msg": msg}))
            if self.path == "/api/ghpush":
                return self.send(json.dumps({"ok": True, "msg": gh_push()}))
            if self.path == "/api/logclear":
                ALOG.clear()
                return self.send(json.dumps({"ok": True}))
            if self.path == "/api/clearerr":
                S["err"] = ""
                return self.send(json.dumps({"ok": True}))
            self.send("{}", code=404)
        except Exception as e:
            self.send(json.dumps({"ok": False, "error": str(e)}))


PAGE = r"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>FFT Patcher</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#000432;color:#fff;font:12px 'JetBrains Mono',Consolas,monospace;overflow:hidden}
#pv{position:fixed;left:0;top:0;width:100%;height:calc(100% - 36px);border:0;background:#000432}
#log{position:fixed;left:0;top:0;width:100%;height:calc(100% - 36px);display:none;overflow:auto;padding:12px;white-space:pre-wrap;word-break:break-all;line-height:1.5}
#bar{position:fixed;left:6px;right:6px;bottom:3px;height:30px;display:flex;gap:2px;border-radius:999px;overflow:hidden;background:#000432}
#bar>*{border:0;color:#000432;font-weight:800;font-size:12px;font-family:inherit;display:flex;align-items:center;padding:0 12px;white-space:nowrap}
#ins{flex:1;background:#E2E8F0;outline:0;min-width:80px}#fl{background:#7df5c0;gap:8px}#fl label{display:flex;gap:3px;align-items:center;cursor:pointer}
#tg{background:#ffb3c7;gap:8px}#tg label{display:flex;gap:3px;align-items:center;cursor:pointer;font-size:10px}
#tg input{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin:0;border:1.5px solid #000432;border-radius:4px;background:transparent;position:relative;cursor:pointer}
#tg input:checked{background:#000432}
#tg input:checked::after{content:"";position:absolute;left:3.5px;top:0.5px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
button{cursor:pointer;font-size:14px!important}button:hover{filter:brightness(1.15)}
#pay{background:#7eb8f7}#gp{background:#b5e88a}#gl{background:#8fd3f4}#app{background:#6ef0f0}#undo{background:#f9a875}#rs{background:#d47bff}#vw{background:#ffe066}#st{background:#b5e88a;font-size:11px}
#bar>#fl,#bar>#undo,#bar>#vw,#bar>#st,#bar>#rs{display:none!important}
#lg{background:#ffd27a}
#lgo{display:none;position:fixed;left:50%;top:8px;transform:translateX(-50%);width:min(760px,96vw);height:calc(100% - 56px);background:#000432;border:1px solid #fff;border-radius:10px;padding:12px;z-index:11;flex-direction:column;box-shadow:0 0 30px rgba(255,255,255,.25)}
#lgo button{background:#E2E8F0;border:0;border-radius:6px;padding:5px 12px;color:#000432;font-size:11px!important;font-weight:800}
#lb{flex:1;overflow:auto;white-space:pre-wrap;word-break:break-word;margin-top:8px;font-weight:400;line-height:1.5;min-height:0}
#toast{position:fixed;bottom:44px;left:50%;transform:translateX(-50%);background:#000432;border:1px solid #fff;padding:8px 18px;border-radius:20px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:9;max-width:94vw}
#toast.on{opacity:1}
#eo{display:none;position:fixed;bottom:48px;left:50%;transform:translateX(-50%);width:min(640px,94vw);background:#000432;border:1px solid #fff;border-radius:10px;padding:14px;z-index:10;box-shadow:0 0 30px rgba(255,255,255,.25)}
#eb{white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;margin:8px 0 10px;font-weight:400}#eo button{background:#E2E8F0;border:0;border-radius:6px;padding:5px 12px;margin-left:6px;color:#000432;font-size:11px!important;font-weight:800}
</style></head><body>
<iframe id="pv"></iframe><pre id="log"></pre>
<div id="bar"><input id="ins" placeholder="Instructions for AI... (@part3 / @name / @auto)"><div id="fl"></div><div id="tg"></div>
<button id="pay" title="Build and copy payload">▲</button><button id="app" title="Read clipboard and apply the patch">⌘</button>
<button id="gp" title="Push the bot files to GitHub (Render redeploys)">&#11014;</button><button id="gl" title="Pull the repo files into this folder (backup first)">&#11015;</button><button id="lg" title="Log">&#128220;</button><button id="undo" title="Undo last patch">↶</button><button id="rs" title="Restart bot">⟳</button><button id="vw" title="Preview / bot output">≡</button><span id="st">...</span></div>
<div id="toast"></div>
<div id="lgo"><div style="display:flex;gap:6px;align-items:center"><b style="margin-right:6px">LOG</b><button id="lt1">ACTIVITY</button><button id="lt2">BOT OUTPUT</button><span style="flex:1"></span><button id="lcp">COPY</button><button id="lcl">CLEAR</button><button id="lx">✕</button></div><pre id="lb"></pre></div>
<div id="eo"><b>⚠️ PATCH ERROR</b><div id="eb"></div><div style="text-align:right"><button id="ec">📋 Copy Error</button><button id="ed">✕ Dismiss</button></div></div>
<script>
const $=id=>document.getElementById(id);
const F=__FILES__,L=["py","html","tick","ui","css","tool"];
let sv={};try{sv=JSON.parse(localStorage.getItem("fftchk")||"null")||{}}catch(e){}
F.forEach((f,i)=>{const on=(f in sv)?sv[f]:i==0;$("fl").insertAdjacentHTML("beforeend",'<label title="'+f+'"><input type="checkbox" value="'+f+'"'+(on?" checked":"")+'>'+L[i]+'</label>')});
$("fl").onchange=()=>{const o={};document.querySelectorAll("#fl input").forEach(x=>o[x.value]=x.checked);try{localStorage.setItem("fftchk",JSON.stringify(o))}catch(e){}};
const TG=[["user","U","U - My prompt: include my instruction"],["sup","P","P - AI instruction: include the patch-format prompt"],["lite","L","L - Lite mode: big files are sent as an index, then only the parts you tag"],["src","S","S - Original source: include the file source code"]];
let tv={};try{tv=JSON.parse(localStorage.getItem("ffttg")||"null")||{}}catch(e){}
TG.forEach(t=>{const on=(t[0] in tv)?tv[t[0]]:true;$("tg").insertAdjacentHTML("beforeend",'<label title="'+t[2]+'"><input type="checkbox" data-k="'+t[0]+'"'+(on?" checked":"")+'></label>')});
function getTg(){const o={};document.querySelectorAll("#tg input").forEach(x=>o[x.dataset.k]=x.checked);return o}
$("tg").onchange=()=>{try{localStorage.setItem("ffttg",JSON.stringify(getTg()))}catch(e){}};
let tt;function toast(m,ms){$("toast").textContent=m;$("toast").classList.add("on");clearTimeout(tt);tt=setTimeout(()=>$("toast").classList.remove("on"),ms||2600)}
let curErr="";function showErr(m){curErr=m;$("eb").textContent=m;$("eo").style.display="block"}
$("ed").onclick=()=>{$("eo").style.display="none";api("/api/clearerr")};
async function api(p,b){const r=await fetch(p,{method:"POST",headers:{"X-FFT":"1"},body:JSON.stringify(b||{})});return r.json()}
async function copy(t){try{await navigator.clipboard.writeText(t);return true}catch(e){return false}}
$("ec").onclick=async()=>{await copy("PATCH ERROR - please fix and resend the patch.\n\nError: "+curErr);toast("📋 Error copied")};
$("pay").onclick=async()=>{const files=F.slice();
 const tg=getTg();let clip="";
 if(tg.lite&&tg.src){try{clip=await navigator.clipboard.readText()}catch(e){}}
 const r=await api("/api/payload",Object.assign({instr:$("ins").value.trim(),files,clip},tg));
 if(!r.ok){toast("⚠️ "+r.error,4000);return}
 if(typeof r.instr==="string")$("ins").value=r.instr;
 const ok=await copy(r.text);
 const lbl={index:"🧭 Index copied (no code, "+r.chars+" chars) - paste to Claude, copy its reply, then press ▲ again",lite:"🚀 Lite payload copied ("+r.chars+" chars) - paste into Claude",full:"🚀 Payload copied ("+r.chars+" chars) - paste into Claude"};
 toast(ok?lbl[r.mode]+(r.added?"  +"+r.added+" tag(s) from clipboard":""):"❌ Copy failed",4500)};
$("app").onclick=async()=>{let t="";try{t=await navigator.clipboard.readText()}catch(e){toast("❌ Cannot read clipboard - allow it in the browser");return}
 if(!t.trim()){toast("⚠️ Clipboard is empty");return}
 const r=await api("/api/apply",{text:t});if(r.ok){$("eo").style.display="none";toast("⚡ Patched: "+r.files.join(", "))}else showErr(r.error)};
$("undo").onclick=async()=>{const r=await api("/api/undo");if(r.ok)toast("↩ Restored: "+r.files.join(", "));else toast("ℹ "+r.error)};
$("rs").onclick=async()=>{await api("/api/restart");toast("⟳ Restarting bot...")};
$("gp").onclick=async()=>{$("gp").disabled=true;toast("\u2B06 Checking GitHub target...",60000);try{const c=await api("/api/ghcheck");if(!c.ok){$("gp").disabled=false;toast("\u274C Check failed",4000);showErr(c.error);return}toast("\u2B06 Pushing to GitHub...",60000);const r=await api("/api/ghpush");$("gp").disabled=false;if(r.ok){$("eo").style.display="none";toast("\u2705 "+r.msg,9000)}else{toast("\u274C Push failed",4000);showErr(r.error)}}catch(e){$("gp").disabled=false;toast("\u274C "+e,5000)}};
$("gl").onclick=async()=>{$("gl").disabled=true;toast("\u2B07 Checking the repo...",60000);try{const c=await api("/api/glcheck");if(!c.ok){$("gl").disabled=false;toast("\u274C Check failed",4000);showErr(c.error);return}if(c.msg.indexOf("Nothing to pull")===0){$("gl").disabled=false;toast(c.msg.split("\n")[0],7000);return}if(!confirm(c.msg+"\n\nPull now? Your current files are backed up first.")){$("gl").disabled=false;toast("Pull cancelled",2500);return}toast("\u2B07 Pulling...",60000);const r=await api("/api/ghpull");$("gl").disabled=false;if(r.ok){$("eo").style.display="none";toast("\u2705 "+r.msg,9000)}else{toast("\u274C Pull failed",4000);showErr(r.error)}}catch(e){$("gl").disabled=false;toast("\u274C "+e,5000)}};
let lgTab=1,lgTimer=0;
async function lgLoad(){try{const t=lgTab==1?(await (await fetch("/api/log")).json()).log:(await (await fetch("/api/status")).json()).log;const b=$("lb"),end=b.scrollTop+b.clientHeight>=b.scrollHeight-30;b.textContent=t||"(empty)";if(end)b.scrollTop=b.scrollHeight;$("lt1").style.opacity=lgTab==1?1:.5;$("lt2").style.opacity=lgTab==2?1:.5}catch(e){}}
function lgShow(on){$("lgo").style.display=on?"flex":"none";clearInterval(lgTimer);if(on){lgLoad();lgTimer=setInterval(lgLoad,1000)}}
$("lg").onclick=()=>lgShow($("lgo").style.display!=="flex");
$("lx").onclick=()=>lgShow(false);
$("lt1").onclick=()=>{lgTab=1;lgLoad();$("lb").scrollTop=$("lb").scrollHeight};
$("lt2").onclick=()=>{lgTab=2;lgLoad();$("lb").scrollTop=$("lb").scrollHeight};
$("lcp").onclick=async()=>{await copy($("lb").textContent);toast("📋 Log copied")};
$("lcl").onclick=async()=>{if(lgTab==1)await api("/api/logclear");lgLoad()};
let logv=false;$("vw").onclick=()=>{logv=!logv;$("log").style.display=logv?"block":"none";$("pv").style.display=logv?"none":"block"};
let key="",seen="",stl=0,bt="";
async function poll(){try{const s=await (await fetch("/api/status")).json();
 if(bt&&s.boot&&s.boot!==bt){location.reload();return}bt=s.boot||bt;
 $("st").textContent=s.running?(s.port?"● bot :"+s.port:"● starting..."):"○ bot stopped";
 const lg=$("log"),atEnd=lg.scrollTop+lg.clientHeight>=lg.scrollHeight-30;lg.textContent=s.log;if(atEnd)lg.scrollTop=lg.scrollHeight;
 const k=s.gen+"/"+s.port+"/"+s.reload;if(s.port&&k!==key){key=k;$("pv").src="http://127.0.0.1:"+s.port+"/?r="+Date.now()}
 if(s.stale&&!stl){stl=1;document.title="FFT Patcher (restart needed)";toast("\u26a0 patcher.py changed - restarting the patcher (if nothing happens, close this window and start it again)",9000)}
 if(!s.stale&&stl){stl=0;document.title="FFT Patcher"}
 if(s.err&&s.err!==seen){seen=s.err;showErr(s.err)}if(!s.err)seen=""}catch(e){}}
setInterval(poll,1000);poll();
</script></body></html>"""


# ───────────────────────── self test ─────────────────────────
def selftest():
    fails = []

    def check(name, cond):
        print(("  ok   " if cond else "  FAIL ") + name)
        if not cond:
            fails.append(name)

    animals = ["zebra", "yak", "walrus", "vulture", "urchin", "tapir", "snail", "raven", "quail", "panda", "otter", "newt"]
    py = ["# synthetic bot", "import os", ""]
    for a in animals:
        py.append("def handle_%s(x):" % a)
        for j in range(40):
            py.append("    v%d = x + %d  # filler %s %d" % (j, j, "line", j))
        py.append("    return 'marker_%s'" % a)
    files = {"big.py": "\n".join(py), "small.html": "<html><body>hello</body></html>"}

    print("chunking")
    ch = lite_build(files)
    check("big file split into parts, small file untouched", len(ch) >= 10 and all(c["file"] == "big.py" for c in ch))
    check("parts cover the file exactly", "\n".join(c["t"] for c in ch) == files["big.py"])
    check("function names found", any("handle_walrus" in c["names"] for c in ch))
    check("cache returns same list", lite_build(files) is ch)
    check("small files alone give no parts", lite_build({"s.html": files["small.html"]}) == [])

    print("index / lite source")
    idx = lite_index(files, "fix marker_walrus handler please")
    wal = next(c for c in ch if "handle_walrus" in c["names"])
    check("index marks the matching part", ("PART %d big.py" % wal["n"]) in idx and "<<MATCH: marker_walrus" in idx)
    check("index has no code", "v5 = x + 5" not in idx)
    check("index lists small files", "small.html (1 lines)" in idx)
    src = lite_source(files, "do it @handle_walrus")
    check("name tag shows that part only", "marker_walrus" in src and "marker_zebra'" not in src)
    check("small file sent in full", "==== FILE: small.html ====\n<html>" in src)
    src2 = lite_source(files, "@part%d" % wal["n"])
    check("@partN tag works", "marker_walrus" in src2)
    src3 = lite_source(files, "change marker_otter please")
    check("auto-match picks the matching part", "marker_otter" in src3 and "marker_zebra'" not in src3)

    print("payload modes")
    r = build_payload_from(files, "fix marker_walrus")
    check("big + plain instruction -> index (no prompt)", r["mode"] == "index" and "Reply with ONLY" not in r["text"] and "INDEX MODE" in r["text"])
    r = build_payload_from(files, "fix it @handle_walrus")
    check("tags -> lite with prompt, tags removed afterwards", r["mode"] == "lite" and "Reply with ONLY" in r["text"] and "@" not in r["instr"])
    r = build_payload_from(files, "fix marker_walrus @auto")
    check("@auto -> lite, tag removed", r["mode"] == "lite" and r["instr"] == "fix marker_walrus" and "marker_walrus" in r["text"])
    r = build_payload_from(files, "fix marker_walrus", lite=False)
    check("lite off -> full files", r["mode"] == "full" and "marker_zebra'" in r["text"] and "==== FILE: big.py ====" in r["text"])
    r = build_payload_from({"small.html": files["small.html"]}, "x")
    check("only small files -> full", r["mode"] == "full")
    r = build_payload_from(files, "x", sup=False, src=False)
    check("prompt + source off -> only the instruction", r["text"].startswith("User Instruction: x"))
    try:
        build_payload_from(files, "", user=False, sup=False, src=False)
        check("nothing selected raises", False)
    except ValueError:
        check("nothing selected raises", True)
    r = build_payload_from(files, "fix marker_walrus", clip="fix marker_walrus @handle_walrus @part99 @handle_walrus")
    check("clipboard tags auto-added (known only, once)", r["added"] == 1 and r["mode"] == "lite")
    r = build_payload_from(files, "fix marker_walrus", clip="x" * 5000 + " @handle_walrus")
    check("long clipboard ignored", r["added"] == 0)
    r = build_payload_from(files, "fix marker_walrus", clip="[LITE MODE: ...] @handle_walrus")
    check("own payload in clipboard ignored", r["added"] == 0)
    check("payload ends with the invisible signature", r["text"].endswith(SIG))

    print("patch parsing / applying")
    p = parse("```\n==== FILE: small.html ====\nhello\n===SPLIT===\nbye\n===BLOCK===\nv1 = x + 1\n===SPLIT===\nv1 = x + 100\n```")
    check("two blocks parsed", len(p) == 2)
    check("explicit file name read", p[0][2] == "small.html" and p[0][0] == "hello" and p[0][1] == "bye")
    check("later block gets the file as a hint", p[1][2] is None and p[1][3] == "small.html")
    p = parse("old\n===SPLIT===\nnew")
    check("plain block still works", p == [("old", "new", None, None)])
    check("zero-width marker ignored", parse("a\n===SPLIT===\nb" + SIG)[0][1] == "b")

    f2 = {"a.js": "x();\ny();\n", "b.js": "x();\nz();\n"}
    try:
        apply_blocks(dict(f2), parse("x();\n===SPLIT===\nq();"))
        check("duplicate across files rejected", False)
    except ValueError as e:
        check("duplicate across files rejected", "2 places" in str(e))
    g = dict(f2)
    ch2 = apply_blocks(g, parse("==== FILE: b.js ====\nx();\n===SPLIT===\nq();"))
    check("FILE header resolves the duplicate", ch2 == {"b.js"} and g["b.js"].startswith("q();") and g["a.js"].startswith("x();"))
    g = dict(f2)
    ch2 = apply_blocks(g, parse("==== FILE: a.js ====\ny();\n===SPLIT===\ny2();\n===BLOCK===\nx();\n===SPLIT===\nq();"))
    check("hint file used for the next block", ch2 == {"a.js"} and g["a.js"].startswith("q();") and g["b.js"].startswith("x();"))
    g = dict(f2)
    try:
        apply_blocks(g, parse("==== FILE: a.js ====\nz();\n===SPLIT===\nq();"))
        check("named file is searched only", False)
    except ValueError:
        check("named file is searched only", True)
    g = {"a.js": "keep;\ntail  \nend\n"}
    apply_blocks(g, parse("tail\nend\n===SPLIT===\nnew"))
    check("trailing-space tolerant match", g["a.js"] == "keep;\nnew\n")

    print("self patching")
    check("patcher.py is a patchable file, separate from the bot", PATCHER in FILES and BOT != PATCHER and BOT in FILES)
    check("page gets the file list injected", "__FILES__" in PAGE and '"tool"' in PAGE)
    check("running version is not reported as stale", not stale())
    try:
        selfcheck("x = (\n")
        check("selfcheck rejects a broken patcher", False)
    except ValueError:
        check("selfcheck rejects a broken patcher", True)
    try:
        selfcheck("x = 1\n")
        check("selfcheck rejects a patcher without main()", False)
    except ValueError:
        check("selfcheck rejects a patcher without main()", True)
    try:
        selfcheck((HERE / PATCHER).read_text(encoding="utf-8"))
        check("selfcheck accepts the current patcher", True)
    except ValueError as e:
        check("selfcheck accepts the current patcher: " + str(e)[:80], False)
    print("page")
    check("page has the four toggles and no triple quotes", all(k in PAGE for k in ('"user"', '"sup"', '"src"', '"lite"')))
    print("RESULT: %s" % ("ALL PASSED" if not fails else "%d FAILED" % len(fails)))
    return 1 if fails else 0


def check():
    """python patcher.py --check : tests YOUR real bot files against the lite / index / patch logic. Writes nothing."""
    import shutil as _sh
    bad = []

    def say(ok, msg):
        print(("  ok   " if ok else "  FAIL ") + msg)
        if not ok:
            bad.append(msg)

    print("FFT Patcher check - folder: %s" % HERE)
    miss = [n for n in FILES if not (HERE / n).is_file()]
    say(not miss, "all bot files present" + ("" if not miss else " - MISSING: " + ", ".join(miss)))
    if miss:
        return 1
    files, crlf = load()
    print("files")
    node = _sh.which("node")
    for n, t in files.items():
        msg = "%-22s %5d lines %7d chars%s" % (n, len(t.split("\n")), len(t), "  (CRLF)" if crlf[n] else "")
        if n.endswith(".py"):
            try:
                compile(t, n, "exec")
                say(True, msg + "  python syntax ok")
            except SyntaxError as e:
                say(False, msg + "  PYTHON SYNTAX ERROR line %s: %s" % (e.lineno, e.msg))
        elif n.endswith(".js") and node:
            tmp = HERE / ("_chk_" + n)
            try:
                tmp.write_text(t, encoding="utf-8")
                r = subprocess.run([node, "--check", str(tmp)], capture_output=True, text=True, timeout=30)
                say(r.returncode == 0, msg + ("  js syntax ok" if r.returncode == 0 else "  JS SYNTAX ERROR: " + r.stderr.strip()[:200]))
            finally:
                try:
                    tmp.unlink()
                except OSError:
                    pass
        else:
            say(True, msg)
    print("lite chunking")
    ch = lite_build(files)
    if not ch:
        say(True, "no file is big enough to split - payloads are always full (nothing to index)")
        return 1 if bad else 0
    for n in files:
        cs = [c for c in ch if c["file"] == n]
        if not cs:
            print("       %-22s small - always sent whole" % n)
            continue
        say("\n".join(c["t"] for c in cs) == files[n], "%-22s %3d parts, biggest %5d chars, %d without a name - parts cover the file exactly" % (
            n, len(cs), max(len(c["t"]) for c in cs), sum(1 for c in cs if not c["names"])))
    print("payload")
    full = build_payload_from(files, "check", lite=False)["chars"]
    nm = next((x for c in ch for x in c["names"]), "main")
    ix = build_payload_from(files, "change " + nm)
    say(ix["mode"] == "index" and ix["chars"] < full, "plain instruction -> INDEX mode, %d chars (full files would be %d chars, %d%% saved)" % (
        ix["chars"], full, 100 - ix["chars"] * 100 // max(full, 1)))
    au = build_payload_from(files, "change " + nm + " @auto")
    say(au["mode"] == "lite" and au["chars"] < full, "@auto -> LITE mode, %d chars" % au["chars"])
    miss_p = [c["n"] for c in ch if (lambda r: r["mode"] != "lite" or c["t"] not in r["text"])(build_payload_from(files, "x @part%d" % c["n"]))]
    say(not miss_p, "every @partN tag returns that exact part (%d parts tested)%s" % (len(ch), "" if not miss_p else " - FAILED: " + str(miss_p[:10])))
    print("patch round-trip (in memory, nothing is written)")
    fails, tested = [], 0
    for c in ch:
        pick = next((l for l in c["t"].split("\n") if len(l.strip()) >= 12 and files[c["file"]].count(l) == 1), None)
        if pick is None:
            continue
        tested += 1
        try:
            tmp = dict(files)
            apply_blocks(tmp, [(pick, pick + "  PATCHTEST", c["file"], None)])
            if "PATCHTEST" not in tmp[c["file"]]:
                raise ValueError("not applied")
        except Exception as e:
            fails.append("part %d (%s): %s" % (c["n"], c["file"], str(e)[:80]))
    say(not fails, "FILE-header patch applied cleanly in %d of %d parts%s" % (tested - len(fails), tested, "" if not fails else " - " + "; ".join(fails[:3])))
    print("RESULT: " + ("ALL OK - your files work with the lite logic" if not bad else "%d PROBLEM(S) - see FAIL lines above" % len(bad)))
    return 1 if bad else 0


def main():
    missing = [n for n in FILES if not (HERE / n).is_file()]
    if missing:
        print("Missing in %s: %s" % (HERE, ", ".join(missing)))
        input("Press Enter to close...")
        sys.exit(1)
    BK.mkdir(exist_ok=True)
    snap = BK / "_original"
    snap.mkdir(exist_ok=True)
    for n in FILES:
        if not (snap / n).exists():
            shutil.copy2(HERE / n, snap / n)
    srv = None
    want = int(os.environ.get("FFT_PORT") or 0)
    if want:
        time.sleep(0.8)
    for k in range(25 if want else 1):
        for p in ([want] if want and k < 24 else range(PORT, PORT + 20)):
            try:
                srv = ThreadingHTTPServer(("127.0.0.1", p), H)
                break
            except OSError:
                continue
        if srv:
            break
        time.sleep(0.4)
    if not srv:
        print("No free port for the patcher.")
        input("Press Enter to close...")
        sys.exit(1)
    atexit.register(stop_bot)
    start_bot()
    S["hport"] = srv.server_address[1]
    url = "http://127.0.0.1:%d" % srv.server_address[1]
    print("FFT Patcher: %s   (close this window to stop the patcher and the bot)" % url)
    if not want:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    if "--check" in sys.argv:
        sys.exit(check())
    main()

"""
WallSpectrum - single-pair REV scanner: Python backend + browser front-end
(grid chart + TICK chart with auto boxes and a tick/cross painted on every signal result).

Local:
  pip install -r requirements.txt
  python wallspectrum_local.py            # live Deriv feed, opens http://127.0.0.1:8765
  python wallspectrum_local.py --demo     # simulated ticks (no internet needed)

Options: --symbol frxXAUUSD --min-cycle 300 --max-cycle 300 --level 1 --min-pct 10 --session 7200
         --scan-interval 0 (auto) --start-utc HH:MM --host 127.0.0.1 --port 8765 --ws wss://... --demo

Trading config is hardcoded below (TRADE CONFIG). Environment variables, when set, override it:
  PORT           set by Render; makes the server listen on 0.0.0.0:$PORT and skips opening a browser
  DERIV_PAT      Deriv personal access token (DEMO account only)
  DERIV_APP_ID   Deriv app id
  DERIV_API_BASE Deriv REST base url
  MAX_STAKE      hard cap for one demo trade

The page has no login. Every trade expiry is forced to the signal cycle (--min-cycle / --max-cycle).
"""
import sys

if sys.version_info < (3, 10):
    print("Python 3.10 or newer is required (you have %d.%d). Install Python 3.12 from python.org." % sys.version_info[:2])
    input("Press Enter to close...")
    sys.exit(1)
import argparse
import asyncio
import collections
import base64
import hmac
import json
import math
import os
import random
import socket
import subprocess
import time
import traceback
import webbrowser
from pathlib import Path

try:
    from aiohttp import web, ClientSession, ClientTimeout, WSMsgType
except ImportError:
    print("First run: installing aiohttp ...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "aiohttp"])
    except Exception:
        print("Auto-install failed. Run this yourself:  %s -m pip install aiohttp" % sys.executable)
        input("Press Enter to close...")
        sys.exit(1)
    from aiohttp import web, ClientSession, ClientTimeout, WSMsgType

PAIR = "frxXAUUSD"
MIN_CYCLE, MAX_CYCLE = 300, 300
MIN_PCT = 10
SESSION_SECS = 7200
MISSING = -1.0
HERE = Path(__file__).resolve().parent
STATIC_DIR = HERE / "static" if (HERE / "static" / "index.html").is_file() else HERE
ASSET_V = str(int(time.time()))  # cache-buster for /static files, changes on every start


def _js_round(x):
    return math.floor(x + 0.5)  # JS Math.round (Python round() is banker's rounding)


# ───────────────────────── scanner ─────────────────────────
def apply_cumulative(hist, max_s):
    cum, res = 0, {}
    for i in range(max_s, 0, -1):
        v = hist.get(i)
        if v:
            cum += v
        if cum > 0:
            res[i] = cum
    return res


def compute_gap_map(events):
    cur, peaks = {}, {}
    for L in events:
        for s in range(1, L):
            cur[s] = cur.get(s, 0) + 1
        if cur.get(L, 0) > 0:
            peaks.setdefault(L, []).append(cur[L])
        cur[L] = 0
    mode_run, mode_count, freq_map = {}, {}, {}
    top = max(max(cur, default=0), max(peaks, default=0))
    for s in range(1, top + 1):
        freq = {}
        for v in peaks.get(s, ()):
            if v >= 1:
                freq[v] = freq.get(v, 0) + 1
        live = cur.get(s, 0)
        if live >= 1:
            freq[live] = freq.get(live, 0) + 1
        if not freq:
            continue
        best_len = best_cnt = 0
        for ln, cnt in freq.items():
            if cnt > best_cnt or (cnt == best_cnt and ln > best_len):
                best_cnt, best_len = cnt, ln
        mode_run[s], mode_count[s], freq_map[s] = best_len, best_cnt, freq
    return mode_run, cur, mode_count, freq_map


def scan_cycle(prices, base_ts, c, s_start, s_end, pair=PAIR):
    rc, rs, rcol = [0] * c, [0] * c, [-2] * c
    sh, term, mx = ({}, {}), ({}, {}), ([0] * c, [0] * c)

    def rec(k, row, s):
        d = sh[k].setdefault(row, {})
        d[s] = d.get(s, 0) + 1
        if s > mx[k][row]:
            mx[k][row] = s
        term[k].setdefault(row, []).append(s)

    for i in range(s_start, s_end):
        p = prices[i]
        pp = prices[i - c] if i >= s_start + c else MISSING
        t = base_ts + i
        col, row = t // c, t % c
        oc, os_ = rc[row], rs[row]
        if pp == MISSING:
            nc, ns = (0, 0) if p == MISSING else (1, 1)
        elif p == MISSING:
            nc, ns = 0, 0
        elif p > pp:
            nc = 1
            ns = os_ + 1 if (rcol[row] == col - 1 and oc == 1 and os_ > 0) else 1
        elif p < pp:
            nc = 2
            ns = os_ + 1 if (rcol[row] == col - 1 and oc == 2 and os_ > 0) else 1
        else:
            nc, ns = oc, 0
        if ns == 1 and os_ > 0 and oc != 0 and rcol[row] == col - 1:
            rec(0 if oc == 1 else 1, row, os_)
        rc[row], rs[row], rcol[row] = nc, ns, col

    for row in range(c):  # live edge injection
        if rs[row] >= 1 and rc[row] != 0:
            rec(0 if rc[row] == 1 else 1, row, rs[row])

    revs = []
    for r in range(c):
        gaps = (compute_gap_map(term[0].get(r, [])), compute_gap_map(term[1].get(r, [])))
        for ci in (0, 1):
            raw, max_s = sh[ci].get(r), mx[ci][r]
            if not raw or max_s == 0:
                continue
            gmode, gcur, gcnt, gfreq = gaps[ci]
            cum = apply_cumulative(raw, max_s)
            for s in sorted(cum):
                c1, c2 = cum[s], cum.get(s + 1, 0)
                pct = 100 - _js_round(c2 / c1 * 100) if c1 > 0 else 0
                revs.append({"pair": pair, "c": c, "r": r, "s1": s, "s2": s + 1, "c1": c1, "c2": c2,
                             "pct": pct, "col": "G" if ci == 0 else "R", "type": "REV",
                             "gap": gmode.get(s, 0), "curGap": gcur.get(s, 0),
                             "gapCount": gcnt.get(s, 0), "gapFreq": gfreq.get(s, {})})
    return revs


def scan(prices, base_ts, min_c=MIN_CYCLE, max_c=MAX_CYCLE, pair=PAIR):
    end = min(SESSION_SECS + 1, len(prices))
    out = []
    for c in range(min_c, max_c + 1):
        out += scan_cycle(prices, base_ts, c, 0, end, pair)
    return out


def top_signals(revs, min_pct=MIN_PCT, level=0, r0_only=False):
    ok = [x for x in revs if x["pct"] >= min_pct and (level == 0 or x["s1"] == level)
          and (not r0_only or x["r"] == 0)]
    ok.sort(key=lambda x: -(x["pct"] * x["c1"]))  # stable, like JS sort
    seen, uniq = {}, []
    for x in ok:
        n = seen.get(x["pair"], 0)
        if n < 10:
            seen[x["pair"]] = n + 1
            uniq.append(x)
    return uniq


# ───────────────────────── backend: price feed ─────────────────────────
S, CFG = {}, None
WS_URLS = ["wss://api.derivws.com/trading/v1/options/ws/public",
           "wss://ws.derivws.com/websockets/v3?app_id=1089",
           "wss://ws.binaryws.com/websockets/v3?app_id=1089"]


def now():
    return int(time.time())


def cur_start():
    base = CFG.start_ts or 0
    return base + CFG.session * ((now() - base) // CFG.session)


def new_session(st):
    S.update(start=st, prices=[MISSING] * CFG.session, maxidx=0, last_tick=0, scan=None, bot_pool=None)
    _bot_reset_session()


EVT = []
EVT_SEQ = [0]
EVT_BOOT = int(time.time())


def elog(level, msg):
    EVT_SEQ[0] += 1
    EVT.append({"id": EVT_SEQ[0], "t": int(time.time() * 1000), "l": level, "m": str(msg)[:400], "src": "SRV"})
    try:
        print("%s [%s] %s" % (time.strftime("%H:%M:%S"), level, str(msg)[:400]), flush=True)
    except Exception:
        pass
    if len(EVT) > 600:
        del EVT[:len(EVT) - 600]


def put(ts, p, live=False):
    i = ts - S["start"]
    if 0 <= i < len(S["prices"]):
        S["prices"][i] = float(p)
        S["maxidx"] = max(S["maxidx"], i)
        S["last_tick"] = ts
        if live:
            try:
                _bot_sample(ts)
                _bot_on_tick(i)
            except Exception:
                traceback.print_exc()


async def backfill(call):
    st, en = S["start"], min(S["start"] + CFG.session - 1, now())
    sym = CFG.symbol
    for s in range(st, en + 1, 901):
        d = await call({"ticks_history": sym, "start": s, "end": min(s + 900, en), "count": 1000, "style": "ticks"})
        if sym != CFG.symbol:
            break
        if "error" in d:
            S["error"] = d["error"].get("message", "history error")
            elog("ERROR", "history request failed: %s" % S["error"])
            continue
        h = d.get("history", {})
        for t, p in zip(h.get("times", []), h.get("prices", [])):
            put(t, p)
        await asyncio.sleep(0.15)
    S["error"] = None
    elog("INFO", "history loaded: %d ticks" % sum(1 for x in S["prices"] if x != MISSING))
    S["scan_now"].set()


def setst(msg):
    S["status"] = msg
    elog("ERROR" if msg.startswith("FAILED") else ("WARN" if msg.startswith("disconnected") else "INFO"), msg)


async def deriv_feed():
    urls, n = ([CFG.ws] if CFG.ws else WS_URLS), 0
    while True:
        url = urls[n % len(urls)]
        host = url.split("/")[2]
        try:
            setst("connecting to " + host)
            async with ClientSession() as sess:
                ws = await asyncio.wait_for(sess.ws_connect(url, heartbeat=20), 15)
                try:
                    setst("connected to %s - loading history" % host)
                    pending, rid = {}, [0]

                    async def call(req):
                        rid[0] += 1
                        req["req_id"] = rid[0]
                        fut = asyncio.get_running_loop().create_future()
                        pending[rid[0]] = fut
                        await ws.send_json(req)
                        return await asyncio.wait_for(fut, 30)

                    async def reader():
                        async for m in ws:
                            if m.type != WSMsgType.TEXT:
                                continue
                            d = json.loads(m.data)
                            f = pending.pop(d.get("req_id"), None)
                            if f and not f.done():
                                f.set_result(d)
                            elif d.get("msg_type") == "tick" and "tick" in d:
                                put(int(d["tick"]["epoch"]), d["tick"]["quote"], True)

                    rt = asyncio.create_task(reader())
                    try:
                        await backfill(call)
                        sub = CFG.symbol
                        await ws.send_json({"ticks": sub, "subscribe": 1})
                        setst("LIVE " + host)
                        while not rt.done():
                            if sub != CFG.symbol:
                                sub = CFG.symbol
                                await ws.send_json({"forget_all": "ticks"})
                                await ws.send_json({"ticks": sub, "subscribe": 1})
                                elog("INFO", "tick subscription switched to %s" % sub)
                            if S["resync"].is_set():
                                S["resync"].clear()
                                elog("INFO", "resync requested - reloading history")
                                await backfill(call)
                            await asyncio.sleep(1)
                        setst("disconnected from " + host)
                    finally:
                        rt.cancel()
                finally:
                    await ws.close()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            setst("FAILED %s: %s %s" % (host, type(e).__name__, str(e)[:120]))
            n += 1
        await asyncio.sleep(3)


async def demo_feed():
    S["status"] = "DEMO (simulated ticks)"
    price = 1.08000

    def step(t):
        nonlocal price
        price += random.choice([-0.0002, -0.0001, 0.0, 0.0001, 0.0002])
        if random.random() > 0.03:
            put(t, round(price, 5))

    while True:
        if S["resync"].is_set() or not S["last_tick"]:
            S["resync"].clear()
            for t in range(S["start"], min(now(), S["start"] + CFG.session)):
                step(t)
            S["scan_now"].set()
        await asyncio.sleep(1)
        step(now())


async def roller():
    while True:
        await asyncio.sleep(1)
        st = cur_start()
        if st != S["start"]:
            new_session(st)
            S["resync"].set()


async def scanner():
    loop = asyncio.get_running_loop()
    while True:
        try:
            await asyncio.wait_for(S["scan_now"].wait(), CFG.scan_interval)
        except asyncio.TimeoutError:
            pass
        S["scan_now"].clear()
        if not S["last_tick"]:
            continue
        prices, st, t0 = list(S["prices"]), S["start"], time.time()
        sig0 = _filter_sig()
        revs = await loop.run_in_executor(None, scan, prices, st, CFG.min_c, CFG.max_c, CFG.symbol)
        r0o = bool(getattr(CFG, "r0_only", False))
        top = top_signals(revs, CFG.min_pct, CFG.level, r0o)
        allq = sorted((x for x in revs if x["pct"] >= CFG.min_pct and (CFG.level == 0 or x["s1"] == CFG.level)
                       and (not r0o or x["r"] == 0) and x["c2"] == 0),
                      key=lambda x: -(x["pct"] * x["c1"]))
        keep = ("c", "r", "s1", "s2", "c1", "c2", "pct", "col", "gap", "curGap")
        BOT["seq"] += 1
        S["bot_pool"] = {"at": BOT["seq"], "sig": sig0,
                         "list": [{k: x[k] for k in keep} for x in sorted(allq, key=lambda x: -_wilson(x["pct"], x["c1"]))[:60]]}
        S["scan"] = {"at": now(), "ms": int((time.time() - t0) * 1000), "total": len(revs), "qualified": len(allq),
                     "wall": [{k: x[k] for k in keep} for x in top[:1]],
                     "top": [{k: x[k] for k in keep} for x in allq[:40]]}
        elog("INFO", "SCAN DONE in %dms: %d signals, %d qualified (min%%=%s level=%s r0=%s)" % (S["scan"]["ms"], len(revs), len(allq), CFG.min_pct, CFG.level, r0o))


# ───────────────────────── backend: http api ─────────────────────────
APP_USER = "admin"
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")  # empty = no login on the page


@web.middleware
async def auth_mw(request, handler):
    """HTTP Basic auth, only active when APP_PASSWORD is not empty (/health stays open)."""
    if not APP_PASSWORD or request.path == "/health":
        return await handler(request)
    hdr = request.headers.get("Authorization", "")
    if hdr.startswith("Basic "):
        try:
            user, _, pw = base64.b64decode(hdr[6:]).decode("utf-8").partition(":")
            if (hmac.compare_digest(user.encode(), APP_USER.encode())
                    and hmac.compare_digest(pw.encode(), APP_PASSWORD.encode())):
                return await handler(request)
        except Exception:
            pass
    return web.Response(status=401, text="Authentication required",
                        headers={"WWW-Authenticate": 'Basic realm="WallSpectrum", charset="UTF-8"'})


async def api_state(request):
    since = int(_num(request.query.get("evt"), 0))
    if since > EVT_SEQ[0]:
        since = 0
    p = S["prices"]
    resp = web.json_response({
        "evt": [e for e in EVT if e["id"] > since], "evtSeq": EVT_SEQ[0], "evtBoot": EVT_BOOT,
        "symbol": CFG.symbol, "start": S["start"], "len": len(p), "now": now(), "status": S["status"],
        "error": S.get("error"), "ticks": sum(1 for x in p if x != MISSING), "lastTick": S["last_tick"],
        "maxidx": S["maxidx"], "scan": S["scan"], "prices": p,
        "cfg": {"level": CFG.level, "minC": CFG.min_c, "maxC": CFG.max_c, "minPct": CFG.min_pct,
                "interval": CFG.scan_interval, "intervalRaw": getattr(CFG, "interval_raw", CFG.scan_interval),
                "session": CFG.session, "autoStake": AUTO_STAKE, "auto": bool(AUTO["on"]),
                "r0Only": bool(getattr(CFG, "r0_only", False)),
                "canEdit": True},
        "bot": _bot_status()})
    resp.enable_compression()
    return resp


ASSETS = ("app.css", "ui.js", "tickchart.js")


# ───────────────────────── live settings (UI -> server -> GitHub config.json) ─────────────────────────
PAIR_LIST = ["frxAUDCAD", "frxAUDCHF", "frxAUDJPY", "frxAUDNZD", "frxAUDUSD", "cryBTCUSD", "cryETHUSD", "frxEURAUD",
             "frxEURCAD", "frxEURCHF", "frxEURGBP", "frxEURJPY", "frxEURNZD", "frxEURUSD", "frxGBPAUD", "frxGBPCAD",
             "frxGBPCHF", "frxGBPJPY", "frxGBPNZD", "frxGBPUSD", "frxNZDJPY", "frxNZDUSD", "frxUSDCAD", "frxUSDCHF",
             "frxUSDJPY", "frxUSDMXN", "frxUSDPLN", "frxXAGUSD", "frxXAUUSD", "frxXPDUSD", "frxXPTUSD", "1HZ10V",
             "1HZ15V", "1HZ25V", "1HZ30V", "1HZ50V", "1HZ75V", "1HZ90V", "1HZ100V"]
CFG_FILE = HERE / "config.json"
ADMIN_KEY = os.environ.get("ADMIN_KEY", "").strip()
GH_TOKEN = os.environ.get("GH_TOKEN", "").strip()
GH_REPO = os.environ.get("GH_REPO", "888znq/mtty2k").strip()
GH_BRANCH = os.environ.get("GH_BRANCH", "").strip()
GH_CFG_PATH = os.environ.get("GH_CFG_PATH", "config.json").strip()
GH_SKIP_RENDER = os.environ.get("GH_SKIP_RENDER", "1").strip() != "0"
FB_CFG_URL = "https://system-data-bf026-default-rtdb.asia-southeast1.firebasedatabase.app/aicompiler/gh_config.json"


def _fb_gh_token():
    try:
        import urllib.request
        req = urllib.request.Request(FB_CFG_URL, headers={"User-Agent": "wallspectrum"})
        with urllib.request.urlopen(req, timeout=10) as r:
            cfg = json.loads(r.read().decode("utf-8"))
    except Exception:
        return ""
    if not isinstance(cfg, dict):
        return ""
    low = {str(k).lower(): v for k, v in cfg.items()}
    for n in ("token", "ghtoken", "pat", "accesstoken"):
        v = low.get(n)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


if not GH_TOKEN:
    GH_TOKEN = _fb_gh_token()


def cfg_current():
    return {"level": CFG.level, "minC": CFG.min_c, "maxC": CFG.max_c, "minPct": CFG.min_pct,
            "interval": getattr(CFG, "interval_raw", CFG.scan_interval), "session": CFG.session,
            "autoStake": AUTO_STAKE, "auto": bool(AUTO["on"]), "symbol": CFG.symbol,
            "r0Only": bool(getattr(CFG, "r0_only", False))}


def cfg_validate(d):
    if not isinstance(d, dict):
        return None, "settings must be an object"
    out = cfg_current()
    try:
        for k in ("level", "minC", "maxC", "minPct", "interval", "session"):
            if d.get(k) not in (None, ""):
                out[k] = int(float(d[k]))
        if d.get("autoStake") not in (None, ""):
            out["autoStake"] = round(float(d["autoStake"]), 2)
    except (TypeError, ValueError):
        return None, "a value is not a number"
    if "auto" in d:
        out["auto"] = d["auto"] in (True, 1, "1", "true", "on")
    if "r0Only" in d:
        out["r0Only"] = d["r0Only"] in (True, 1, "1", "true", "on")
    if d.get("symbol"):
        out["symbol"] = str(d["symbol"]).strip()
    if out["symbol"] != CFG.symbol and out["symbol"] not in PAIR_LIST:
        return None, "unknown pair"
    if not 0 <= out["minPct"] <= 100:
        return None, "MIN % must be 0-100"
    if not 0 <= out["level"] <= 12:
        return None, "LEVEL must be 0-12"
    if not 1 <= out["minC"] <= out["maxC"] <= 3600:
        return None, "cycles must satisfy 1 <= min <= max <= 3600"
    if out["maxC"] - out["minC"] > 300:
        return None, "cycle range too wide (max 300 apart)"
    if not 0 <= out["interval"] <= 3600:
        return None, "SCAN SEC must be 0-3600"
    if not 600 <= out["session"] <= 86400:
        return None, "SESSION must be 600-86400 seconds"
    if out["session"] < out["maxC"] * 2:
        return None, "SESSION must be at least 2 x CYCLE MAX"
    if not 0.01 <= out["autoStake"] <= MAX_STAKE:
        return None, "AUTO STAKE must be 0.01-%s" % MAX_STAKE
    return out, None


def cfg_assign(c):
    global SESSION_SECS, AUTO_STAKE
    CFG.level, CFG.min_c, CFG.max_c, CFG.min_pct = c["level"], c["minC"], c["maxC"], c["minPct"]
    CFG.symbol = c["symbol"]
    CFG.interval_raw = c["interval"]
    CFG.scan_interval = c["interval"] if c["interval"] > 0 else max(1, (c["minC"] + c["maxC"]) // 2)
    CFG.session = c["session"]
    SESSION_SECS = c["session"]
    AUTO_STAKE = c["autoStake"]
    AUTO["on"] = c["auto"]
    CFG.r0_only = bool(c.get("r0Only", False))


def cfg_apply(c):
    changed = c["session"] != CFG.session or c["symbol"] != CFG.symbol
    cfg_assign(c)
    if changed:
        AUTO["session"] = None
        new_session(cur_start())
        S["resync"].set()
    S["scan_now"].set()


def cfg_load_local():
    try:
        if CFG_FILE.is_file():
            c, err = cfg_validate(json.loads(CFG_FILE.read_text(encoding="utf-8")))
            if c:
                cfg_assign(c)
                elog("INFO", "config.json loaded: %s" % json.dumps(c))
            else:
                elog("WARN", "config.json ignored: %s" % err)
    except Exception as e:
        elog("WARN", "config.json not loaded: %s" % e)


def _gh_cfg_url():
    return "https://api.github.com/repos/%s/contents/%s" % (GH_REPO, GH_CFG_PATH)


_GH_SSL = [None]


def _gh_ssl_make():
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


async def gh_api(method, url, body=None):
    try:
        return await _gh_api_once(method, url, body, _GH_SSL[0])
    except Exception as e:
        if _GH_SSL[0] is not None or "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
    ctx = await asyncio.get_running_loop().run_in_executor(None, _gh_ssl_make)
    if ctx is None:
        raise ValueError("SSL certificate check failed and certifi could not be installed")
    _GH_SSL[0] = ctx
    elog("INFO", "GitHub: certificate check failed with the system store, using certifi")
    return await _gh_api_once(method, url, body, ctx)


async def _gh_api_once(method, url, body, ctx):
    hdr = {"Authorization": "Bearer " + GH_TOKEN, "Accept": "application/vnd.github+json", "User-Agent": "wallspectrum"}
    async with ClientSession(timeout=ClientTimeout(total=15)) as sess:
        async with sess.request(method, url, headers=hdr, json=body, ssl=ctx) as r:
            txt = await r.text()
            try:
                j = json.loads(txt)
            except ValueError:
                j = {}
            if r.status >= 400:
                raise ValueError("GitHub HTTP %d: %s" % (r.status, str(j.get("message", txt))[:200]))
            return j


async def cfg_boot_remote():
    if not await gh_token_ensure():
        elog("WARN", "no GH_TOKEN (env or Firebase) - settings are not shared with GitHub")
        return
    try:
        url = _gh_cfg_url() + (("?ref=" + GH_BRANCH) if GH_BRANCH else "")
        j = await gh_api("GET", url)
        _CFG_SYNC["sha"] = j.get("sha")
        c, err = cfg_validate(json.loads(base64.b64decode(j["content"]).decode("utf-8")))
        if c:
            cfg_assign(c)
            elog("INFO", "config loaded from GitHub: %s" % json.dumps(c))
        else:
            elog("WARN", "GitHub config ignored: %s" % err)
    except Exception as e:
        elog("WARN", "GitHub config not loaded: %s" % str(e)[:160])


async def cfg_save_remote(c):
    _CFG_SYNC["saving"] += 1
    try:
        async with _CFG_LOCK:
            await _cfg_save_remote_raw(c)
    finally:
        _CFG_SYNC["saving"] -= 1
        _CFG_SYNC["ver"] += 1


async def _cfg_save_remote_raw(c):
    url = _gh_cfg_url()
    sha = None
    try:
        j = await gh_api("GET", url + (("?ref=" + GH_BRANCH) if GH_BRANCH else ""))
        sha = j.get("sha")
    except ValueError as e:
        if "HTTP 404" not in str(e):
            raise
    body = {"message": "config update" + (" [skip render]" if GH_SKIP_RENDER else ""),
            "content": base64.b64encode((json.dumps(c, indent=2) + "\n").encode("utf-8")).decode("ascii")}
    if sha:
        body["sha"] = sha
    if GH_BRANCH:
        body["branch"] = GH_BRANCH
    j = await gh_api("PUT", url, body)
    try:
        _CFG_SYNC["sha"] = j["content"]["sha"]
    except (KeyError, TypeError):
        pass


CFG_SYNC_SECS = 45
_CFG_SYNC = {"sha": None, "ver": 0, "saving": 0}
_CFG_LOCK = asyncio.Lock()


async def gh_token_ensure():
    global GH_TOKEN
    if not GH_TOKEN:
        tok = await asyncio.get_running_loop().run_in_executor(None, _fb_gh_token)
        if tok:
            GH_TOKEN = tok
            elog("INFO", "GH_TOKEN loaded from Firebase")
    return bool(GH_TOKEN)


async def cfg_sync_loop():
    while True:
        await asyncio.sleep(CFG_SYNC_SECS)
        try:
            if not await gh_token_ensure() or _CFG_SYNC["saving"]:
                continue
            v0 = _CFG_SYNC["ver"]
            j = await gh_api("GET", _gh_cfg_url() + (("?ref=" + GH_BRANCH) if GH_BRANCH else ""))
            if _CFG_SYNC["saving"] or _CFG_SYNC["ver"] != v0:
                continue
            sha = j.get("sha")
            if not sha or sha == _CFG_SYNC["sha"]:
                continue
            _CFG_SYNC["sha"] = sha
            c, err = cfg_validate(json.loads(base64.b64decode(j["content"]).decode("utf-8")))
            if not c:
                elog("WARN", "GitHub config change ignored: %s" % err)
                continue
            if c != cfg_current():
                cfg_apply(c)
                try:
                    CFG_FILE.write_text(json.dumps(c, indent=2) + "\n", encoding="utf-8")
                except Exception:
                    pass
                elog("INFO", "config synced from GitHub: %s" % json.dumps(c))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            elog("WARN", "GitHub config sync failed: %s" % str(e)[:160])


async def api_config(request):
    try:
        d = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad request"}, status=400)
    if not isinstance(d, dict):
        return web.json_response({"ok": False, "error": "bad request"}, status=400)
    c, err = cfg_validate(d.get("cfg") or {})
    if c is None:
        return web.json_response({"ok": False, "error": err}, status=400)
    old_c = cfg_current()
    cfg_apply(c)
    chg = ", ".join("%s %s->%s" % (k, old_c.get(k), c.get(k)) for k in c if old_c.get(k) != c.get(k)) or "no change"
    elog("INFO", "CONFIG REQUEST from page - changed: %s" % chg)
    elog("INFO", "config applied live: %s" % json.dumps(c))
    try:
        CFG_FILE.write_text(json.dumps(c, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass
    await gh_token_ensure()
    msg = "applied live (GH_TOKEN not set - resets on restart)"
    if not GH_TOKEN:
        elog("WARN", "GitHub save skipped: GH_TOKEN not set on this server")
    if GH_TOKEN:
        try:
            elog("INFO", "GitHub: pushing %s to %s ..." % (GH_CFG_PATH, GH_REPO))
            await cfg_save_remote(c)
            msg = "applied live + saved to GitHub"
            elog("INFO", "config saved to GitHub")
        except Exception as e:
            msg = "applied live, GitHub save FAILED: %s" % str(e)[:160]
            elog("ERROR", msg)
    return web.json_response({"ok": True, "cfg": cfg_current(), "msg": msg})


async def asset(request):
    name = request.match_info["name"]
    if name not in ASSETS:
        raise web.HTTPNotFound()
    return web.FileResponse(STATIC_DIR / name)


async def health(_):
    return web.Response(text="ok")


async def index(_):
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8").replace("__V__", ASSET_V)
    resp = web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-cache"})
    resp.enable_compression()
    return resp


# ───────────────────────── demo trading (Deriv, server-side) ─────────────────────────
# TRADE CONFIG (hardcoded; environment variables override it).
# Every trade is placed on the DEMO account only. Keep the GitHub repo private.
DERIV_PAT = os.environ.get("DERIV_PAT", "pat_6cddeac54082c26d64ed3c60bc47176bcbe299d1ae811641c712989075107726").strip()
DERIV_APP_ID = os.environ.get("DERIV_APP_ID", "33VdMoKptaW40mOpanwBg").strip()
DERIV_API_BASE = os.environ.get("DERIV_API_BASE", "https://api.derivws.com").strip().rstrip("/")
try:
    MAX_STAKE = float(os.environ.get("MAX_STAKE", "100000"))
except ValueError:
    MAX_STAKE = 100000.0
IS_HOSTED = bool(os.environ.get("PORT"))
_CREDS_SET = bool(DERIV_PAT and DERIV_APP_ID)
TRADE_ENABLED = _CREDS_SET
TRADE_KEEP = 30
TR = {"ws": None, "ready": False, "status": "connecting" if TRADE_ENABLED else "disabled", "error": None,
      "balance": None, "currency": "USD", "req": 1000, "pending": {}, "open": {}, "closed": []}


def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _api_err(js, fallback):
    try:
        return js["errors"][0]["message"] or fallback
    except Exception:
        return fallback


def _last_price(sym):
    if sym != CFG.symbol:
        return 0
    for x in reversed(S.get("prices") or []):
        if x != MISSING:
            return x
    return 0


async def _trade_send(obj):
    ws = TR["ws"]
    if ws is None or ws.closed:
        raise ConnectionError("account socket not open")
    await ws.send_str(json.dumps(obj))


def _trade_close(tr, pnl, exit_price):
    TR["open"].pop(str(tr["contract_id"]), None)
    tr["status"] = "CLOSED"
    tr["pnl"] = round(pnl, 2)
    tr["payout"] = round(max(0.0, tr["stake"] + pnl), 2)
    tr["exit_price"] = exit_price or 0
    tr["close_time"] = int(time.time())
    TR["closed"].insert(0, tr)
    del TR["closed"][TRADE_KEEP:]
    print("[trade] CLOSED %s %s id=%s %s pnl=%.2f" % (tr["type"], tr["symbol"], tr["contract_id"], "WIN" if pnl > 0 else "LOSS", pnl))
    elog("INFO" if pnl > 0 else "WARN", "TRADE CLOSED %s %s id=%s %s pnl=%.2f" % (tr["type"], tr["symbol"], tr["contract_id"], "WIN" if pnl > 0 else "LOSS", pnl))


async def _trade_msg(data):
    ec = data.get("echo_req") or {}
    rid = data.get("req_id", ec.get("req_id"))
    err = data.get("error")
    if err:
        if ec.get("ping") is not None:
            return
        text = "[%s] %s" % (err.get("code"), err.get("message"))
        if "buy" in ec:
            p = TR["pending"].pop(rid, None)
            print("[trade] BUY REJECTED %s" % text)
            elog("ERROR", "TRADE MISSED - BUY REJECTED by Deriv: %s" % text)
            if p and not p["fut"].done():
                p["fut"].set_result({"ok": False, "error": err.get("message") or "buy rejected"})
        elif "proposal" in ec:
            TR["quote"] = {"error": err.get("message") or "no quote", "sym": ec.get("underlying_symbol"),
                           "dur": ec.get("duration"), "t": time.time()}
        else:
            print("[trade] API error for %s: %s" % (",".join(ec.keys()), text))
            elog("WARN", "Deriv API error for %s: %s" % (",".join(ec.keys()), text))
        return
    bal = data.get("balance")
    if isinstance(bal, dict):
        _ob = TR["balance"]
        TR["balance"] = _num(bal.get("balance"), TR["balance"])
        if _ob != TR["balance"]:
            elog("INFO", "BALANCE %s -> %s %s" % (_ob, TR["balance"], TR["currency"] or ""))
        TR["currency"] = bal.get("currency") or TR["currency"]
    pq = data.get("proposal")
    if isinstance(pq, dict) and "proposal" in ec:
        pk_ask = _num(pq.get("ask_price"), 0.0)
        pk_pay = _num(pq.get("payout"), 0.0)
        if pk_ask > 0 and pk_pay > 0:
            TR["quote"] = {"pct": int(round((pk_pay - pk_ask) / pk_ask * 100)), "payout": round(pk_pay, 2), "stake": round(pk_ask, 2),
                           "sym": ec.get("underlying_symbol"), "dur": ec.get("duration"), "t": time.time()}
    pf = data.get("portfolio")
    if isinstance(pf, dict):
        got = 0
        for ct in (pf.get("contracts") or []):
            if not isinstance(ct, dict) or ct.get("contract_id") is None:
                continue
            cid = str(ct.get("contract_id"))
            if cid in TR["open"]:
                continue
            ot = int(_num(ct.get("purchase_time"), time.time()))
            et = int(_num(ct.get("expiry_time"), 0)) or ot + 3600
            stk = _num(ct.get("buy_price"), 0.0)
            pay = _num(ct.get("payout"), 0.0)
            TR["open"][cid] = {"contract_id": ct.get("contract_id"), "type": str(ct.get("contract_type") or "?").upper(),
                               "symbol": ct.get("underlying_symbol") or ct.get("symbol") or "?", "stake": stk,
                               "payout_amt": pay, "payout_pct": int(round((pay - stk) / stk * 100)) if stk > 0 and pay > 0 else 0,
                               "open_time": ot, "exp_time": et, "duration": max(0, et - ot), "entry_price": 0,
                               "exit_price": 0, "pnl": None, "payout": 0, "status": "OPEN", "bot": None}
            got += 1
            await _trade_send({"proposal_open_contract": 1, "contract_id": ct.get("contract_id"), "subscribe": 1})
        if got:
            elog("INFO", "BOT reconciled %d open contract(s) from the Deriv portfolio" % got)
    b = data.get("buy")
    if isinstance(b, dict):
        p = TR["pending"].pop(rid, None) or {}
        stake = _num(b.get("buy_price"), p.get("stake", 0.0))
        payout = _num(b.get("payout"), 0.0)
        start = int(_num(b.get("start_time"), time.time()))
        dur = int(p.get("exp") or 0)
        tr = {"contract_id": b.get("contract_id"), "type": p.get("type", "?"), "symbol": p.get("symbol", "?"),
              "stake": stake, "payout_amt": payout,
              "payout_pct": int(round((payout - stake) / stake * 100)) if stake > 0 and payout > 0 else 0,
              "open_time": start, "exp_time": start + dur, "duration": dur,
              "entry_price": p.get("entry", 0), "exit_price": 0, "pnl": None, "payout": 0, "status": "OPEN"}
        tr["bot"] = p.get("bot")
        TR["open"][str(tr["contract_id"])] = tr
        print("[trade] OPEN (DERIV CONFIRMED) %s %s id=%s stake=%.2f dur=%ss" % (tr["type"], tr["symbol"], tr["contract_id"], stake, dur))
        elog("INFO", "TRADE OPEN (DERIV CONFIRMED) %s %s id=%s stake=%.2f dur=%ss" % (tr["type"], tr["symbol"], tr["contract_id"], stake, dur))
        if p and not p["fut"].done():
            p["fut"].set_result({"ok": True, "trade": tr})
        await _trade_send({"proposal_open_contract": 1, "contract_id": tr["contract_id"], "subscribe": 1})
    c = data.get("proposal_open_contract")
    if isinstance(c, dict):
        tr = TR["open"].get(str(c.get("contract_id")))
        if tr is None:
            return
        ep = c.get("entry_tick") or c.get("entry_spot")
        if ep:
            tr["entry_price"] = ep
        if c.get("is_sold") or c.get("is_expired") or c.get("status") in ("won", "lost"):
            if c.get("profit") is not None:
                pnl = _num(c.get("profit"))
            else:
                pnl = _num(c.get("sell_price")) - tr["stake"]
            _trade_close(tr, pnl, c.get("exit_tick") or c.get("sell_spot") or c.get("current_spot"))
            try:
                _bot_result(tr, pnl)
            except Exception:
                traceback.print_exc()
            if c.get("id"):
                await _trade_send({"forget": c["id"]})


async def _trade_pinger():
    while True:
        await asyncio.sleep(25)
        try:
            await _trade_send({"ping": 1})
        except Exception:
            elog("WARN", "trade socket ping failed - connection lost")
            return
        t = time.time()
        for tr in list(TR["open"].values()):
            if t > tr["exp_time"] + 90:
                print("[trade] RESULT UNKNOWN id=%s (no settlement message) - check the Deriv balance" % tr["contract_id"])
                elog("WARN", "TRADE RESULT UNKNOWN id=%s (no settlement message) - check the Deriv balance" % tr["contract_id"])
                _trade_close(tr, 0.0, 0)
                tr["status"], tr["pnl"], tr["payout"] = "UNKNOWN", None, None
        for k, p in list(TR["pending"].items()):
            if t - p["t"] > 120:
                TR["pending"].pop(k, None)
                elog("WARN", "pending order %s dropped - no reply from Deriv in 120s (%s %s)" % (k, p.get("type"), p.get("symbol")))


async def _trade_session(http):
    hdr = {"Deriv-App-ID": DERIV_APP_ID, "Authorization": "Bearer " + DERIV_PAT}
    tmo = ClientTimeout(total=20)
    TR["status"] = "connecting"
    async with http.get(DERIV_API_BASE + "/trading/v1/options/accounts", headers=hdr, timeout=tmo) as r:
        js = await r.json(content_type=None)
        if r.status >= 400:
            raise RuntimeError(_api_err(js, "account list failed (HTTP %d) %s" % (r.status, str(js)[:160])))
    accts = js.get("data") if isinstance(js, dict) else None
    demo = next((a for a in (accts if isinstance(accts, list) else [])
                 if isinstance(a, dict) and a.get("account_type") == "demo"), None)
    if not demo or not demo.get("account_id"):
        raise RuntimeError("no demo account found for this token")
    async with http.post(DERIV_API_BASE + "/trading/v1/options/accounts/%s/otp" % demo["account_id"], headers=hdr, timeout=tmo) as r:
        js = await r.json(content_type=None)
        if r.status >= 400:
            raise RuntimeError(_api_err(js, "OTP request failed (HTTP %d) %s" % (r.status, str(js)[:160])))
    url = js["data"].get("url") if isinstance(js, dict) and isinstance(js.get("data"), dict) else None
    if not url:
        raise RuntimeError("OTP response had no websocket url")
    async with http.ws_connect(url) as ws:
        TR["ws"], TR["ready"], TR["status"], TR["error"] = ws, True, "connected", None
        print("[trade] connected to the Deriv DEMO account")
        elog("INFO", "trade socket connected to the Deriv DEMO account")
        await ws.send_str(json.dumps({"balance": 1, "subscribe": 1}))
        await ws.send_str(json.dumps({"portfolio": 1}))
        for tr in list(TR["open"].values()):
            await ws.send_str(json.dumps({"proposal_open_contract": 1, "contract_id": tr["contract_id"], "subscribe": 1}))
        pinger = asyncio.create_task(_trade_pinger())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except ValueError:
                        continue
                    if isinstance(data, dict):
                        try:
                            await _trade_msg(data)
                        except Exception:
                            traceback.print_exc()
                elif msg.type in (WSMsgType.CLOSED, WSMsgType.CLOSING, WSMsgType.ERROR):
                    break
        finally:
            elog("WARN", "trade socket closed")
            pinger.cancel()


async def trade_feed():
    delay = 5
    async with ClientSession() as http:
        while True:
            wait = 3
            try:
                await _trade_session(http)
                delay = 5
            except asyncio.CancelledError:
                raise
            except Exception as e:
                TR["error"] = str(e) or e.__class__.__name__
                wait = delay
                delay = min(delay * 2, 30)
                print("[trade] %s - retry in %ds" % (TR["error"], wait))
                elog("ERROR", "account socket: %s - retry in %ds" % (TR["error"], wait))
            finally:
                TR["ready"], TR["ws"], TR["status"] = False, None, "reconnecting"
                for p in list(TR["pending"].values()):
                    if not p["fut"].done():
                        p["fut"].set_result({"ok": False, "error": "account socket closed"})
                TR["pending"].clear()
            await asyncio.sleep(wait)


async def api_account(request):
    try:
        qdur = int(_num(request.query.get("dur")))
        qamt = round(_num(request.query.get("amt")), 2)
        qkey = (CFG.symbol, qdur, qamt)
        qws = TR["ws"]
        if (TRADE_ENABLED and TR["ready"] and qws is not None and not qws.closed and 1 <= qdur <= 86400
                and 0.01 <= qamt <= MAX_STAKE and (TR.get("qkey") != qkey or time.time() - TR.get("qt", 0) >= 8)):
            TR["qkey"], TR["qt"] = qkey, time.time()
            await _trade_send({"proposal": 1, "amount": qamt, "basis": "stake", "contract_type": "CALL",
                               "currency": TR["currency"] or "USD", "duration": qdur, "duration_unit": "s",
                               "underlying_symbol": CFG.symbol})
    except Exception:
        pass
    qt = TR.get("quote")
    if isinstance(qt, dict):
        qt = dict(qt)
        qt["age"] = int(time.time() - qt.get("t", 0))
    return web.json_response({
        "enabled": TRADE_ENABLED, "ready": TR["ready"], "status": TR["status"], "error": TR["error"],
        "account": "demo", "balance": TR["balance"], "currency": TR["currency"], "maxStake": MAX_STAKE,
        "open": list(TR["open"].values()), "closed": TR["closed"], "quote": qt})


async def api_trade(request):
    def fail(msg, code=400):
        elog("WARN", "TRADE REQUEST FAILED (%d): %s" % (code, msg))
        return web.json_response({"ok": False, "error": msg}, status=code)

    if not TRADE_ENABLED:
        return fail("Trading is off: DERIV_PAT / DERIV_APP_ID are empty", 503)
    try:
        body = await request.json()
    except Exception:
        return fail("bad request")
    if not isinstance(body, dict):
        return fail("bad request")
    typ = str(body.get("type", "")).upper()
    if typ not in ("CALL", "PUT"):
        return fail("type must be CALL or PUT")
    sym = str(body.get("symbol", ""))
    if sym != CFG.symbol:
        return fail("this dashboard only trades " + CFG.symbol)
    amt = round(_num(body.get("amount")), 2)
    if not (0.01 <= amt <= MAX_STAKE):
        return fail("stake must be between 0.01 and %g" % MAX_STAKE)
    d = _num(body.get("duration"))
    if not (1 <= d <= 86400):
        return fail("duration must be 1 to 86400 seconds")
    dur = int(d)
    if not TR["ready"] or TR["ws"] is None or TR["ws"].closed:
        return fail("Account socket not ready - reconnecting, try again in a few seconds", 503)
    TR["req"] += 1
    rid = TR["req"]
    fut = asyncio.get_running_loop().create_future()
    TR["pending"][rid] = {"type": typ, "symbol": sym, "stake": amt, "exp": dur, "entry": _last_price(sym),
                          "t": time.time(), "fut": fut}
    try:
        await _trade_send({
            "buy": "1", "price": round(amt * 2, 2),
            "parameters": {"amount": amt, "basis": "stake", "contract_type": typ, "currency": TR["currency"] or "USD",
                           "duration": dur, "duration_unit": "s", "underlying_symbol": sym},
            "req_id": rid})
    except Exception as e:
        TR["pending"].pop(rid, None)
        return fail("send failed: %s" % e, 502)
    print("[trade] BUY SENT %s %s stake=%.2f dur=%ds req=%d" % (typ, sym, amt, dur, rid))
    elog("INFO", "MANUAL BUY SENT %s %s stake=%.2f dur=%ds req=%d" % (typ, sym, amt, dur, rid))
    try:
        res = await asyncio.wait_for(asyncio.shield(fut), 15)
    except asyncio.TimeoutError:
        return fail("No confirmation from Deriv within 15s - check HIST before trying again", 504)
    return web.json_response(res, status=200 if res.get("ok") else 422)



# ───────────────────────── server-side AUTO TRADER ─────────────────────────
# Runs on the server, so trades are placed even when no browser page is open.
# Same rules as the browser tick chart: pick the best signal (pct x c1), watch its row,
# and fire the moment the row streak reaches exactly s1 in the signal colour.
AUTO_STAKE = _num(os.environ.get("AUTO_STAKE", "1"), 1.0)
class _AlwaysOn(dict):
    def __setitem__(self, k, v):
        dict.__setitem__(self, k, True if k == "on" else v)

    def update(self, *a, **kw):
        dict.update(self, *a, **kw)
        dict.__setitem__(self, "on", True)


AUTO = _AlwaysOn({"on": True, "sig": None, "fired": set(), "session": None, "count": 0, "last": "-"})


def _plan_fired(sig, prices, fin, base_ts):
    """Mirror of tcPlan() in tickchart.js. Returns the index of the FIRED tick, or -1."""
    c = sig["c"]
    r = ((sig["r"] - (base_ts % c)) % c + c) % c
    col_code = 1 if sig["col"] == "G" else 2
    color = streak = 0
    last_i = -1
    i = r
    while i <= fin:
        p = prices[i]
        q = prices[i - c] if i >= c else MISSING
        if q == MISSING:
            nc, ns = (0, 0) if p == MISSING else (1, 1)
        elif p == MISSING:
            nc, ns = 0, 0
        elif p > q:
            nc = 1
            ns = streak + 1 if (color == 1 and streak > 0) else 1
        elif p < q:
            nc = 2
            ns = streak + 1 if (color == 2 and streak > 0) else 1
        else:
            nc, ns = color, 0
        color, streak = nc, ns
        last_i = i
        i += c
    if color == col_code and streak == sig["s1"] and last_i >= 0:
        return last_i
    return -1


BOT_MIN_N, BOT_FLOOR, BOT_MARGIN, BOT_CONFIRM = 5, 55.0, 4.0, 3
BOT_MAX_AGE = 2
BOT_SESSION_BUFFER = int(_num(os.environ.get("BOT_SESSION_BUFFER"), 10))
BOT_MAX_LOSSES = int(_num(os.environ.get("BOT_MAX_LOSSES"), 5))
BOT_DAILY_LOSS_X = _num(os.environ.get("BOT_DAILY_LOSS_X"), 10.0)
BOT = {"champ": None, "strikes": 0, "chal_key": None, "chal_n": 0, "scan_at": None, "fsig": None, "seq": 0,
       "lock": None, "last_lock_id": "", "stale_id": "", "skip": None, "off": 0.0, "smp": collections.deque(maxlen=60),
       "stats": {}, "loss_run": 0, "day_pnl": 0.0, "day": int(time.time() // 86400), "halt": None, "qt": 0.0}


def _wilson(pct, n):
    if n <= 0:
        return 0.0
    p, z = pct / 100.0, 1.96
    z2 = z * z
    return 100.0 * (p + z2 / (2 * n) - z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n)


def _sig_key(x):
    return "%s|%s|%s|%s|%s|REV" % (x.get("pair") or CFG.symbol, x["c"], x["r"], x["s1"], x["col"])


def _filter_sig():
    return (CFG.symbol, CFG.min_pct, CFG.level, bool(getattr(CFG, "r0_only", False)), CFG.session, S.get("start"))


def _bot_reset(why):
    if BOT["champ"] is not None:
        elog("INFO", "BOT champion reset (%s)" % why)
    BOT.update(champ=None, strikes=0, chal_key=None, chal_n=0, scan_at=None)


def _bot_reset_session():
    BOT["lock"] = None
    BOT["fsig"] = None
    BOT.update(champ=None, strikes=0, chal_key=None, chal_n=0, scan_at=None)


def _bot_sample(epoch):
    BOT["smp"].append(epoch - time.time())
    BOT["off"] = max(-10.0, min(10.0, max(BOT["smp"])))


def _bot_now():
    return time.time() + BOT["off"]


def _bot_res(prices, i, c, p, col_code, lim):
    j = i + c
    if j > lim:
        return "pending"
    q = prices[j]
    if q == MISSING:
        return "none"
    if (col_code == 1 and q < p) or (col_code == 2 and q > p):
        return "win"
    return "loss"


def _bot_plan(sig, prices, lim, s_end, base_ts):
    c = int(sig["c"])
    r = ((sig["r"] - (base_ts % c)) % c + c) % c
    col_code = 1 if sig["col"] == "G" else 2
    color = streak = 0
    last_i = -1
    hist = []
    i = r
    while i <= lim:
        p = prices[i]
        q = prices[i - c] if i >= c else MISSING
        if q == MISSING:
            nc, ns = (0, 0) if p == MISSING else (1, 1)
        elif p == MISSING:
            nc, ns = 0, 0
        elif p > q:
            nc = 1
            ns = streak + 1 if (color == 1 and streak > 0) else 1
        elif p < q:
            nc = 2
            ns = streak + 1 if (color == 2 and streak > 0) else 1
        else:
            nc, ns = color, 0
        color, streak = nc, ns
        if p != MISSING and ns == sig["s1"] and nc == col_code:
            hist.append({"i": i, "res": _bot_res(prices, i, c, p, col_code, lim)})
        last_i = i
        i += c
    if color == col_code and streak == sig["s1"] and last_i >= 0:
        return {"kind": "FIRED", "idx": last_i, "need": 0, "hist": hist}
    if color == col_code and streak > sig["s1"]:
        return {"kind": "NONE", "idx": -1, "need": 0, "hist": hist, "missed": True}
    k = streak if color == col_code else 0
    need = max(1, sig["s1"] - k)
    i_next = r if last_i < 0 else last_i + c
    idx = i_next + (need - 1) * c
    if idx >= s_end:
        return {"kind": "NONE", "idx": -1, "need": 0, "hist": hist}
    return {"kind": "FUT", "idx": idx, "need": need, "hist": hist}


def _bot_list(pool):
    out = []
    for x in pool:
        y = dict(x)
        y["pair"] = CFG.symbol
        y["type"] = "REV"
        y["score"] = _wilson(y["pct"], y["c1"])
        out.append(y)
    out.sort(key=lambda z: -z["score"])
    return out[:10]


def _bot_crown(x, why):
    BOT["champ"] = {"key": _sig_key(x), "sig": x, "score": x["score"], "since": int(time.time())}
    BOT["strikes"], BOT["chal_key"], BOT["chal_n"] = 0, None, 0
    elog("INFO", "BOT CHAMPION %s C%s R%s X%s %s c1=%s pct=%s%% score=%.1f (%s)" % (
        _sig_key(x), x["c"], x["r"], x["s1"], x["col"], x["c1"], x["pct"], x["score"], why))


def _bot_dethrone(elig, why):
    ch = BOT["champ"]
    nxt = next((x for x in elig if _sig_key(x) != ch["key"]), None)
    elog("WARN", "BOT DETHRONED %s (%s)" % (ch["key"], why))
    if nxt is not None:
        _bot_crown(nxt, "replacement")
    else:
        BOT.update(champ=None, strikes=0, chal_key=None, chal_n=0)
        elog("WARN", "BOT champion seat vacant - no eligible signal")


def _champ_apply(lst):
    if not lst:
        return
    prices, start = S["prices"], S["start"]
    fin = max(0, min(int(_bot_now() - start) - 1, S["maxidx"], len(prices) - 1))
    elig = [x for x in lst if x["c1"] >= BOT_MIN_N and x["score"] >= BOT_FLOOR]
    ch = BOT["champ"]
    if ch is None:
        if elig:
            _bot_crown(elig[0], "seat was empty")
        return
    cur = next((x for x in lst if _sig_key(x) == ch["key"]), None)
    sg = cur or ch["sig"]
    plan = _bot_plan(sg, prices, fin, len(prices), start)
    inflight = plan["kind"] == "FIRED" or (plan["kind"] == "FUT" and plan["need"] <= 2)
    reason = None
    if cur is None:
        reason = "missing from the list"
    elif cur["c1"] < BOT_MIN_N:
        reason = "c1 %s below %d" % (cur["c1"], BOT_MIN_N)
    elif cur["score"] < BOT_FLOOR:
        reason = "score %.1f below floor %.0f" % (cur["score"], BOT_FLOOR)
    else:
        outs = [h["res"] for h in plan["hist"] if h["res"] in ("win", "loss")][-3:]
        if outs.count("loss") >= 2:
            reason = "lost %d of its last %d results" % (outs.count("loss"), len(outs))
    if cur is not None:
        ch["sig"], ch["score"] = cur, cur["score"]
    if not (CFG.min_c <= sg["c"] <= CFG.max_c):
        _bot_dethrone(elig, "cycle %s outside %s-%s" % (sg["c"], CFG.min_c, CFG.max_c))
        return
    if reason:
        BOT["strikes"] += 1
        elog("WARN", "BOT STRIKE %d/%d %s: %s%s" % (BOT["strikes"], BOT_CONFIRM, ch["key"], reason, " (in flight, protected)" if inflight else ""))
    else:
        BOT["strikes"] = 0
    if BOT["strikes"] >= BOT_CONFIRM and not inflight:
        _bot_dethrone(elig, "%d consecutive strikes" % BOT["strikes"])
        return
    top = next((x for x in elig if _sig_key(x) != ch["key"]), None)
    champ_score = cur["score"] if cur else 0.0
    if top is not None and top["score"] > champ_score + BOT_MARGIN:
        k = _sig_key(top)
        BOT["chal_n"] = BOT["chal_n"] + 1 if BOT["chal_key"] == k else 1
        BOT["chal_key"] = k
        if BOT["chal_n"] >= BOT_CONFIRM and not inflight:
            elog("INFO", "BOT CHALLENGER %s beat champion %s for %d scans" % (k, ch["key"], BOT["chal_n"]))
            _bot_crown(top, "challenger")
    else:
        BOT["chal_key"], BOT["chal_n"] = None, 0


def _bot_skip(fid, why):
    if BOT["skip"] != (fid, why):
        BOT["skip"] = (fid, why)
        elog("WARN", "BOT FIRE SKIPPED %s: %s" % (fid, why))


def _bot_payout_ok(champ):
    q = TR.get("quote")
    if not isinstance(q, dict) or "pct" not in q or q.get("sym") != CFG.symbol or time.time() - q.get("t", 0) > 90:
        elog("WARN", "BOT payout unknown (no fresh quote) - entering without the breakeven check")
        return True, ""
    be = 100.0 / (1.0 + q["pct"] / 100.0)
    if champ["score"] < be:
        return False, "score %.1f below breakeven %.1f (payout %s%%)" % (champ["score"], be, q["pct"])
    return True, ""


def _bot_try_fire(champ, plan, src):
    sig = champ["sig"]
    idx = plan["idx"]
    fid = "%s|%d" % (champ["key"], idx)
    if fid == BOT["last_lock_id"]:
        return
    start = S["start"]
    nowf = _bot_now()
    now_rel = nowf - start
    age = now_rel - idx
    if age > BOT_MAX_AGE:
        if BOT["stale_id"] != fid:
            BOT["stale_id"] = fid
            elog("WARN", "BOT stale fire ignored (%.1fs old) %s" % (age, fid))
        return
    c = int(sig["c"])
    if BOT["halt"]:
        return _bot_skip(fid, "bot halted: %s" % BOT["halt"])
    lk = BOT["lock"]
    if lk and now_rel < lk["end"]:
        return _bot_skip(fid, "locked by %s until +%ds" % (lk["id"], int(lk["end"] - now_rel)))
    if TR["open"] or TR["pending"]:
        return _bot_skip(fid, "a trade is still open")
    if idx + c + BOT_SESSION_BUFFER > len(S["prices"]):
        return _bot_skip(fid, "result would land inside the session-boundary buffer")
    ok, why = _bot_payout_ok(champ)
    if not ok:
        return _bot_skip(fid, why)
    end = idx + c
    dur = max(1, min(c, int(round(end - now_rel))))
    BOT["lock"] = {"key": champ["key"], "id": fid, "end": end, "t0": nowf}
    BOT["last_lock_id"] = fid
    typ = "CALL" if sig["col"] == "R" else "PUT"
    AUTO["sig"] = sig
    elog("INFO", "BOT FIRE %s %s via %s age=%.1fs dur=%ds score=%.1f" % (typ, fid, src, age, dur, champ["score"]))
    asyncio.create_task(_auto_place(typ, CFG.symbol, AUTO_STAKE, dur, fid, {"key": champ["key"], "score": round(champ["score"], 1)}))


def _bot_on_tick(i):
    ch = BOT["champ"]
    if ch is None or BOT["fsig"] != _filter_sig():
        return
    sig = ch["sig"]
    c = int(sig["c"])
    if i % c != ((sig["r"] - (S["start"] % c)) % c + c) % c:
        return
    plan = _bot_plan(sig, S["prices"], i, len(S["prices"]), S["start"])
    if plan["kind"] == "FIRED" and plan["idx"] == i:
        _bot_try_fire(ch, plan, "tick")


def _bot_result(tr, pnl):
    b = tr.get("bot")
    if not b:
        return
    st = BOT["stats"].setdefault(b["key"], {"w": 0, "l": 0})
    if pnl > 0:
        st["w"] += 1
        BOT["loss_run"] = 0
    else:
        st["l"] += 1
        BOT["loss_run"] += 1
    BOT["day_pnl"] = round(BOT["day_pnl"] + pnl, 2)
    elog("INFO", "BOT RESULT %s %s pnl=%.2f | this signal %dW/%dL | losses in a row %d | day pnl %.2f" % (
        "WIN" if pnl > 0 else "LOSS", b["key"], pnl, st["w"], st["l"], BOT["loss_run"], BOT["day_pnl"]))
    cap = BOT_DAILY_LOSS_X * AUTO_STAKE
    if BOT["halt"] is None and BOT_MAX_LOSSES > 0 and BOT["loss_run"] >= BOT_MAX_LOSSES:
        BOT["halt"] = "%d losses in a row" % BOT["loss_run"]
    if BOT["halt"] is None and cap > 0 and BOT["day_pnl"] <= -cap:
        BOT["halt"] = "daily loss %.2f reached cap %.2f" % (BOT["day_pnl"], cap)
    if BOT["halt"]:
        elog("ERROR", "BOT HALTED - %s. No new trades until the next UTC day or a server restart." % BOT["halt"])


def _bot_status():
    ch = BOT["champ"]
    lk = BOT["lock"]
    return {"champion": ch["key"] if ch else None, "score": round(ch["score"], 1) if ch else None, "strikes": BOT["strikes"],
            "challenger": BOT["chal_key"], "challengerScans": BOT["chal_n"],
            "lock": lk["id"] if lk else None, "lockEnd": lk["end"] if lk else None, "halt": BOT["halt"],
            "lossRun": BOT["loss_run"], "dayPnl": BOT["day_pnl"], "stats": BOT["stats"]}


async def _auto_place(typ, sym, amt, dur, tag, bot=None):
    """Same as api_trade() but called directly by the server."""
    if not TRADE_ENABLED:
        elog("WARN", "AUTO TRADE NOT PLACED - trading disabled (%s)" % tag)
        return
    if not TR["ready"] or TR["ws"] is None or TR["ws"].closed:
        print("[auto] SKIPPED %s - account socket not ready" % tag, flush=True)
        elog("ERROR", "TRADE MISSED - AUTO %s %s not placed: account socket not ready (%s)" % (typ, sym, tag))
        return
    TR["req"] += 1
    rid = TR["req"]
    fut = asyncio.get_running_loop().create_future()
    TR["pending"][rid] = {"type": typ, "symbol": sym, "stake": amt, "exp": dur, "entry": _last_price(sym),
                          "t": time.time(), "fut": fut, "bot": bot}
    try:
        await _trade_send({
            "buy": "1", "price": round(amt * 2, 2),
            "parameters": {"amount": amt, "basis": "stake", "contract_type": typ, "currency": TR["currency"] or "USD",
                           "duration": dur, "duration_unit": "s", "underlying_symbol": sym},
            "req_id": rid})
    except Exception as e:
        TR["pending"].pop(rid, None)
        print("[auto] SEND FAILED %s: %s" % (tag, e), flush=True)
        elog("ERROR", "TRADE MISSED - AUTO send failed (%s): %s" % (tag, e))
        return
    print("[auto] BUY SENT %s %s %s stake=%.2f dur=%ds" % (tag, typ, sym, amt, dur), flush=True)
    elog("INFO", "AUTO BUY SENT %s %s stake=%.2f dur=%ds (%s)" % (typ, sym, amt, dur, tag))
    try:
        res = await asyncio.wait_for(asyncio.shield(fut), 20)
        AUTO["count"] += 1 if res.get("ok") else 0
        AUTO["last"] = "%s %s %s" % (time.strftime("%H:%M:%S"), typ, "OK" if res.get("ok") else res.get("error"))
        print("[auto] RESULT %s -> %s" % (tag, "PLACED" if res.get("ok") else res.get("error")), flush=True)
        elog("INFO" if res.get("ok") else "ERROR", "AUTO RESULT %s -> %s" % (tag, "PLACED" if res.get("ok") else "TRADE MISSED - " + str(res.get("error"))))
    except asyncio.TimeoutError:
        print("[auto] NO CONFIRMATION within 20s for %s" % tag, flush=True)
        elog("WARN", "AUTO NO CONFIRMATION within 20s for %s - check HIST" % tag)


async def auto_trader():
    await asyncio.sleep(10)
    print("[auto] server-side bot STARTED (stake=%.2f, champion + lock logic, no browser needed)" % AUTO_STAKE, flush=True)
    elog("INFO", "bot started (stake=%.2f, max losses in a row=%d, daily loss cap=%.2f)" % (AUTO_STAKE, BOT_MAX_LOSSES, BOT_DAILY_LOSS_X * AUTO_STAKE))
    while True:
        await asyncio.sleep(1)
        try:
            _lt = S.get("last_tick")
            if _lt:
                _stale = now() - _lt > 15
                if _stale != AUTO.get("stale", False):
                    AUTO["stale"] = _stale
                    elog("WARN" if _stale else "INFO", ("TICK FEED STALE - no tick for %ds" % (now() - _lt)) if _stale else "TICK FEED RECOVERED")
            _day = int(time.time() // 86400)
            if BOT["day"] != _day:
                BOT.update(day=_day, day_pnl=0.0, loss_run=0, halt=None)
                elog("INFO", "BOT new UTC day - loss counters and halt cleared")
            if not AUTO["on"] or not S.get("last_tick") or not S.get("scan") or not S.get("bot_pool"):
                continue
            if AUTO["session"] != S["start"]:
                AUTO.update(session=S["start"], fired=set(), sig=None, sk=None)
                elog("INFO", "AUTO new session start=%s" % S["start"])
            fsig = _filter_sig()
            if BOT["fsig"] != fsig:
                if BOT["fsig"] is not None:
                    _bot_reset("filters or session changed")
                BOT["fsig"] = fsig
            pool = S["bot_pool"]
            if pool["sig"] == fsig and pool["at"] != BOT["scan_at"]:
                BOT["scan_at"] = pool["at"]
                _champ_apply(_bot_list(pool["list"]))
            start = S["start"]
            lk = BOT["lock"]
            if lk and _bot_now() - start >= lk["end"]:
                elog("INFO", "BOT LOCK released %s" % lk["id"])
                BOT["lock"] = None
            ch = BOT["champ"]
            if ch is None:
                continue
            AUTO["sig"] = ch["sig"]
            c = int(ch["sig"]["c"])
            q = TR.get("quote")
            if TR["ready"] and time.time() - BOT["qt"] > 5 and (
                    not isinstance(q, dict) or "pct" not in q or time.time() - q.get("t", 0) > 20
                    or q.get("dur") != c or q.get("sym") != CFG.symbol):
                BOT["qt"] = time.time()
                try:
                    await _trade_send({"proposal": 1, "amount": round(AUTO_STAKE, 2), "basis": "stake", "contract_type": "CALL",
                                       "currency": TR["currency"] or "USD", "duration": c, "duration_unit": "s",
                                       "underlying_symbol": CFG.symbol})
                except Exception:
                    pass
            nsec = int(_bot_now() - start)
            fin = min(nsec - 1, S["maxidx"], len(S["prices"]) - 1)
            if fin < 0:
                continue
            plan = _bot_plan(ch["sig"], S["prices"], fin, len(S["prices"]), start)
            if plan["kind"] == "FIRED":
                _bot_try_fire(ch, plan, "loop")
        except asyncio.CancelledError:
            raise
        except Exception:
            traceback.print_exc()
            elog("ERROR", "auto trader error: %s" % traceback.format_exc().strip().splitlines()[-1])


# ───────────────────────── app wiring ─────────────────────────
async def guard(factory):
    while True:
        try:
            return await factory()
        except asyncio.CancelledError:
            raise
        except Exception:
            traceback.print_exc()
            S["error"] = "internal error in %s - see the server log" % factory.__name__
            await asyncio.sleep(3)


def free_port(host, port):
    for p in range(port, port + 20):
        with socket.socket() as sk:
            try:
                sk.bind((host, p))
                return p
            except OSError:
                continue
    return port


async def on_start(app):
    S.update(status="starting", error=None, resync=asyncio.Event(), scan_now=asyncio.Event())
    await cfg_boot_remote()
    new_session(cur_start())
    app["tasks"] = [asyncio.create_task(guard(f)) for f in ((demo_feed if CFG.demo else deriv_feed), roller, scanner)]
    app["tasks"].append(asyncio.create_task(guard(cfg_sync_loop)))
    if TRADE_ENABLED:
        app["tasks"].append(asyncio.create_task(trade_feed()))
        app["tasks"].append(asyncio.create_task(guard(auto_trader)))
        print("[trade] demo trading ENABLED (expiry = signal cycle %ds)" % CFG.min_c)
    else:
        print("[trade] demo trading disabled - DERIV_PAT / DERIV_APP_ID are empty")
    if not IS_HOSTED:
        asyncio.get_running_loop().call_later(1.0, webbrowser.open, "http://%s:%d" % (CFG.host, CFG.port))


async def on_stop(app):
    for t in app["tasks"]:
        t.cancel()
    await asyncio.gather(*app["tasks"], return_exceptions=True)


def main():
    global CFG, SESSION_SECS
    a = argparse.ArgumentParser()
    a.add_argument("--symbol", default=PAIR)
    a.add_argument("--min-cycle", dest="min_c", type=int, default=MIN_CYCLE)
    a.add_argument("--max-cycle", dest="max_c", type=int, default=MAX_CYCLE)
    a.add_argument("--min-pct", dest="min_pct", type=int, default=MIN_PCT)
    a.add_argument("--session", type=int, default=7200)
    a.add_argument("--level", type=int, default=1, help="1 = X1-X2 only, 0 = all levels")
    a.add_argument("--scan-interval", dest="scan_interval", type=int, default=0, help="0 = auto (average of min and max cycle)")
    a.add_argument("--start-utc", dest="start_utc", default="")
    a.add_argument("--host", default="0.0.0.0" if IS_HOSTED else "127.0.0.1")
    a.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    a.add_argument("--ws", default="")
    a.add_argument("--demo", action="store_true")
    CFG = a.parse_args()
    SESSION_SECS = CFG.session
    CFG.interval_raw = max(0, CFG.scan_interval)
    if CFG.scan_interval <= 0:
        CFG.scan_interval = max(1, (CFG.min_c + CFG.max_c) // 2)
    cfg_load_local()
    if not (STATIC_DIR / "index.html").is_file():
        sys.exit("index.html not found next to %s - keep index.html, app.css, ui.js and tickchart.js with the script (or in a static/ folder)." % Path(__file__).name)
    if not IS_HOSTED:
        CFG.port = free_port(CFG.host, CFG.port)
    CFG.start_ts = None
    if CFG.start_utc:
        h, m = CFG.start_utc.split(":")
        CFG.start_ts = (now() // 86400) * 86400 + int(h) * 3600 + int(m) * 60
    elog("INFO", "server starting: symbol=%s session=%ds cycles=%d-%d min_pct=%d level=%d demo=%s" % (CFG.symbol, CFG.session, CFG.min_c, CFG.max_c, CFG.min_pct, CFG.level, bool(CFG.demo)))
    elog("INFO", "trading %s, auto stake=%.2f" % ("ENABLED (DEMO account)" if TRADE_ENABLED else "OFF (DERIV_PAT / DERIV_APP_ID empty)", AUTO_STAKE))
    app = web.Application(middlewares=[auth_mw])
    app.add_routes([web.get("/", index), web.get("/api/state", api_state), web.get("/health", health),
                    web.get("/api/account", api_account), web.post("/api/trade", api_trade),
                    web.post("/api/config", api_config),
                    web.get("/static/{name}", asset)])
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    web.run_app(app, host=CFG.host, port=CFG.port, access_log=None,
                print=lambda *_: print("WallSpectrum: http://%s:%d  (Ctrl+C to stop)" % (CFG.host, CFG.port)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

/* ===================================================================================
   TICK CHART  (single pair, REV only)
   - price line, zoom / pan, price + time axes, IST clock
   - REV signal plan: FUT (waiting for the expected point) -> FIRED (hit) -> result
   - the moment a signal hits its expected point a box is drawn over the next C seconds,
     and when the result tick arrives the box is painted WIN (tick) or LOSS (cross)
   - every box also shows the DEMO trade placed for it: OPEN / P&L, type + stake, entry -> exit
   - the chart is locked on TICK (the TICK/GRID button no longer switches back to the grid)
   =================================================================================== */
(function () {
    'use strict';

    var MONO = "'JetBrains Mono', monospace";
    var PADL = 10, PADT = 0, PADB = 20, PADR = 52;
    var ZOOMS = [0.1, 0.2, 0.5, 1, 2, 3, 5, 8, 12, 20, 30, 60, 120, 300, 600];
    var HOLD_MS = 220, HOLD_TOL = 14;
    var DIM = '#8890b8', TXT = '#E2E8F0';
    var TRADE_MATCH_SECS = 20;   /* a trade belongs to a box when it opened within this many seconds of the hit */
    var TRADE_LINE_H = 12;
    var SOLO_ICO_EXPAND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    var SOLO_ICO_EXIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
    var BTN_CSS = 'min-width:32px; height:22px; padding:0 9px; box-sizing:border-box; font-family:' + MONO + '; font-size:11px; font-weight:800; line-height:1; cursor:pointer; border-radius:0; border:1px solid #E2E8F0; background:#E2E8F0; color:#000432;';

    var TC = window.TC = {
        on: false, wrap: null, cv: null, ctx: null, tip: null,
        W: 0, H: 0, dpr: 1,
        spp: 3, left: 0, follow: true, yZ: 1, yOff: 0, axW: 52,
        hov: [], hits: [], mx: -1, my: -1,
        sig: null, sessStart: -1, seen: {}, flash: {}, banner: null, hitSeen: '', ready: false,
        ocSig: '', pulseOn: false, activeAt: 0, timer: null, pulseTimer: null, raf: 0, dec: 2
    };

    /* ------------------------------------------------------------------ helpers */
    function cGreen() { return window.accentGreenHex || '#2ED573'; }
    function cRed() { return window.accentRedHex || '#E63946'; }
    function cTickGreen() { return window.realGreenHex || '#2ED573'; }
    function cCrossRed() { return window.realRedHex || '#E63946'; }
    function cBg() { return window.systemThemeHex || '#000432'; }
    function cChart() { return window.CHART_BG || cBg(); }
    function startTs() { return (S && S.start) ? S.start : 0; }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function pairColor() { return (typeof tcPairColor === 'function' && S) ? tcPairColor(S.symbol) : '#E2E8F0'; }

    function tcOffset() { return (startTs() % 86400) + 19800; }
    function tcFmt(idx, withSec) {
        var ds = Math.floor(idx) + tcOffset();
        ds = ((ds % 86400) + 86400) % 86400;
        var h = Math.floor(ds / 3600), m = Math.floor((ds % 3600) / 60), s = ds % 60;
        var t = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
        if (withSec) t += ':' + (s < 10 ? '0' : '') + s;
        return t;
    }
    function tcFmtIn(sec) {
        if (sec <= 0) return 'NOW';
        var m = Math.floor(sec / 60), s = sec % 60;
        return m > 0 ? (m + 'm' + (s < 10 ? '0' : '') + s + 's') : (s + 's');
    }
    function tcLastReal(prices, from) {
        for (var i = from; i >= 0; i--) { if (prices[i] !== -1) return i; }
        return -1;
    }
    function tcClamp(plotW) {
        var span = plotW * TC.spp, sEnd = S ? S.len : 0;
        var minL = -span * 0.5, maxL = sEnd - span * 0.5;
        if (maxL < minL) maxL = minL;
        if (TC.left < minL) TC.left = minL;
        if (TC.left > maxL) TC.left = maxL;
    }
    function tcSigKey(s) { return s ? [s.c, s.r, s.s1, s.s2, s.col].join('|') : ''; }

    /* ------------------------------------------------------------------ trade details (painted inside the boxes) */
    /* the trade that was opened for the hit at session index idx (matched by symbol + open time) */
    function tcTradeFor(idx) {
        var a = window._trAcct, t0 = startTs() + idx, best = null, bd = 1e9, list, i, t, d;
        if (!a || !S) return null;
        list = (a.open || []).concat(a.closed || []);
        for (i = 0; i < list.length; i++) {
            t = list[i];
            if (!t || t.symbol !== S.symbol) continue;
            d = Math.abs((t.open_time || 0) - t0);
            if (d <= TRADE_MATCH_SECS && d < bd) { bd = d; best = t; }
        }
        return best;
    }
    function tcMoney(n) { return Math.abs(Number(n)).toFixed(2); }
    /* text lines for a trade: [P&L / OPEN], [type + stake], [entry -> exit] */
    function tcTradeLines(tr) {
        var L = [], dec = TC.dec + 1, known, pnl, ep, xp;
        if (!tr) return L;
        known = (tr.pnl !== null && tr.pnl !== undefined);
        pnl = known ? Number(tr.pnl) : 0;
        L.push({ t: (tr.type === 'CALL' ? '\u25B2 ' : '\u25BC ') + tr.type + ' $' + tcMoney(tr.stake), c: tr.type === 'CALL' ? cTickGreen() : cCrossRed() });
        if (tr.status === 'OPEN') L.push({ t: 'OPEN', c: window.pairColorHex || '#FFD700' });
        else if (known) {
            var pcol = pnl > 0 ? cTickGreen() : (pnl < 0 ? cCrossRed() : TXT);
            L.push({ t: (pnl > 0 ? '+ $' : (pnl < 0 ? '- $' : '  $')) + tcMoney(pnl), c: pcol });
        }
        else L.push({ t: 'RESULT ?', c: DIM });
        return L;
    }
    /* how many lines fit in a box of height avail (reserve = space kept for the tick / cross) */
    function tcInfoCount(lines, w, avail, reserve) {
        if (!lines.length || w < 44) return 0;
        return Math.max(0, Math.min(lines.length, Math.floor((avail - reserve) / TRADE_LINE_H)));
    }
    /* draw the first n lines, the first line centred on y0 */
    function tcDrawTradeInfo(lines, n, visL, visR, y0, bg) {
        var c = TC.ctx, w = visR - visL, cx = (visL + visR) / 2, k, y;
        if (!lines.length || n < 1) return;
        c.save();
        c.font = 'bold 13px ' + MONO; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.lineJoin = 'round'; c.lineWidth = 4; c.strokeStyle = bg;
        for (k = 0; k < n; k++) {
            var tcFsz = 13;
            c.font = 'bold ' + tcFsz + 'px ' + MONO;
            while (tcFsz > 8 && c.measureText(lines[k].t).width > w - 6) { tcFsz--; c.font = 'bold ' + tcFsz + 'px ' + MONO; }
            if (c.measureText(lines[k].t).width > w - 6) continue;
            y = y0 + k * Math.max(TRADE_LINE_H, 14);
            c.strokeText(lines[k].t, cx, y);
            c.fillStyle = lines[k].c;
            c.fillText(lines[k].t, cx, y);
        }
        c.restore();
    }

    /* ------------------------------------------------------------------ plan / result */
    function tcRes(prices, i, c, p, nc, fin) {
        var j = i + c;
        if (j > fin) return 'pending';
        var q = prices[j];
        if (q === -1 || q === undefined) return 'none';
        if ((nc === 1 && q > p) || (nc === 2 && q < p)) return 'cont';
        return 'rev';
    }
    /* REV signal: it wins when the next tick of the row REVERSES */
    function tcWin(res) {
        if (res === 'pending' || res === 'none') return res;
        return res === 'rev' ? 'win' : 'loss';
    }
    function tcPlan(sig, prices, lim, sEnd, fin) {
        var hist = [], c = sig.c;
        var r = (((sig.r - (startTs() % c)) % c) + c) % c;
        var colCode = sig.col === 'G' ? 1 : 2;
        var color = 0, streak = 0, lastI = -1, i, p, q, nc, ns;
        for (i = r; i <= lim; i += c) {
            p = prices[i];
            q = i >= c ? prices[i - c] : -1;
            if (q === -1) {
                nc = (p === -1) ? 0 : 1;
                ns = (p === -1) ? 0 : 1;
            } else if (p === -1) {
                nc = 0; ns = 0;
            } else if (p > q) {
                nc = 1; ns = (color === 1 && streak > 0) ? streak + 1 : 1;
            } else if (p < q) {
                nc = 2; ns = (color === 2 && streak > 0) ? streak + 1 : 1;
            } else {
                nc = color; ns = 0;
            }
            color = nc; streak = ns;
            if (p !== -1 && ns === sig.s1 && nc === colCode) {
                hist.push({ i: i, p: p, res: tcRes(prices, i, c, p, nc, fin), lo: p, hi: p });
            }
            lastI = i;
        }
        if (color === colCode && streak === sig.s1 && lastI >= 0) {
            return { kind: 'FIRED', idx: lastI, need: 0, ref: null, hist: hist };
        }
        if (color === colCode && streak > sig.s1) {
            return { kind: 'NONE', idx: -1, need: 0, ref: null, hist: hist, missed: true, streak: streak };
        }
        var k = (color === colCode) ? streak : 0;
        var need = sig.s1 - k;
        if (need < 1) need = 1;
        var iNext = lastI < 0 ? r : lastI + c;
        var idx = iNext + (need - 1) * c;
        if (idx >= sEnd) return { kind: 'NONE', idx: -1, need: 0, ref: null, hist: hist };
        var ref = (need === 1 && lastI >= 0 && prices[lastI] !== -1) ? prices[lastI] : null;
        return { kind: 'FUT', idx: idx, need: need, ref: ref, hist: hist };
    }
    /* price range covered by every box (entry -> result window) */
    function tcMeasure(plan, sig, prices, last) {
        var c = sig.c, ks = Math.max(1, Math.ceil(c / 300)), n, h, e, k, v;
        for (n = 0; n < plan.hist.length; n++) {
            h = plan.hist[n];
            e = Math.min(h.i + c, (last >= 0 ? last : h.i + c), prices.length - 1);
            for (k = h.i; k <= e; k += ks) {
                v = prices[k];
                if (v === -1 || v === undefined) continue;
                if (v < h.lo) h.lo = v;
                if (v > h.hi) h.hi = v;
            }
            v = prices[e];
            if (v !== -1 && v !== undefined) { if (v < h.lo) h.lo = v; if (v > h.hi) h.hi = v; }
        }
    }

    /* ------------------------------------------------------------------ signal selection */
    function tcSigList() {
        if (S && typeof lvlsOn !== 'undefined' && lvlsOn && typeof _lvPick === 'function') return _lvPick();
        var top = (S && S.scan && S.scan.top) ? S.scan.top : [];
        return top.map(function (x) { return Object.assign({ pair: S.symbol, type: 'REV' }, x); });
    }
    function tcFindSig(c, r, s1, s2, col) {
        var l = tcSigList(), i;
        for (i = 0; i < l.length; i++) {
            if (l[i].c === c && l[i].r === r && l[i].s1 === s1 && l[i].s2 === s2 && l[i].col === col) return l[i];
        }
        return TC.sig && tcSigKey(TC.sig) === [c, r, s1, s2, col].join('|') ? TC.sig : null;
    }
    function tcHasPending(sig, prices, fin, sEnd) {
        var pl = tcPlan(sig, prices, fin, sEnd, fin), i;
        for (i = 0; i < pl.hist.length; i++) { if (pl.hist[i].res === 'pending') return true; }
        return false;
    }
    function tcNearest(lst, nsec, start) {
        var bs = null, bd = 1e12, i, x, d;
        for (i = 0; i < lst.length; i++) {
            x = lst[i];
            d = (((x.r - start - nsec) % x.c) + x.c) % x.c;
            if (d < bd) { bd = d; bs = x; }
        }
        return bs;
    }
    function tcSigText(s) {
        return [getPairDisplayName(s.pair), 'C' + s.c, 'R' + s.r, 'X' + s.s1 + '-X' + s.s2, s.c1, s.c2, s.pct + '%'].join(' | ');
    }
    /* The selected signal stays until a challenger that passes the filters has a strictly higher pct x c1, or until it fails the filters.
       A signal with a trade still waiting for its result is kept until that result is painted. */
    function tcUpdateSignal(prices, fin, sEnd) {
        var start = startTs(), best = null, lst;
        if (TC.sessStart !== start) {
            TC.sessStart = start; TC.sig = null; TC.seen = {}; TC.flash = {}; TC.banner = null; TC.hitSeen = ''; TC.ready = false;
        }
        var scanAt = (S && S.scan) ? S.scan.at : null, inc = null, ki, sc0, sc1;
        try { lst = (typeof lvlsOn !== 'undefined' && lvlsOn && typeof _lvlBuild === 'function') ? tcSigList() : _buildTop10(tcSigList()); } catch (e) { lst = []; }
        var cur = TC.sig;
        if (cur && tcHasPending(cur, prices, fin, sEnd)) return;
        if (cur) {
            for (ki = 0; ki < lst.length; ki++) { if (tcSigKey(lst[ki]) === tcSigKey(cur)) { inc = lst[ki]; break; } }
        }
        best = lst.length ? (typeof _top1 === 'function' ? _top1(lst)[0] : lst[0]) : null;
        var chP = (S && S.bot && S.bot.champion) ? String(S.bot.champion).split('|') : [], chJ, chX;
        if (chP.length === 6) {
            for (chJ = 0; chJ < lst.length; chJ++) {
                chX = lst[chJ];
                if (+chP[1] === chX.c && +chP[3] === chX.s1 && chP[4] === chX.col && (chX.rs || [chX.r]).indexOf(+chP[2]) >= 0) { best = Object.assign({}, chX, { r: +chP[2] }); break; }
            }
        }
        if (inc && !(typeof lvlsOn !== 'undefined' && lvlsOn)) {
            sc0 = inc.pct * inc.c1;
            sc1 = best.pct * best.c1;
            if (!(sc1 > sc0)) best = inc;
        }
        TC.scanAt = scanAt;
        var okey = cur ? tcSigKey(cur) : '', nkey = best ? tcSigKey(best) : '';
        TC.sig = best;
        if (okey !== nkey) { try { if (typeof evtLog === 'function') evtLog(best ? 'INFO' : 'WARN', best ? 'SIGNAL SELECTED ' + tcSigText(best) : 'NO SIGNAL PASSES THE FILTERS'); } catch (eS) {} }
    }

    /* ------------------------------------------------------------------ result tracking (hit + win/loss events) */
    function tcTrack(plan, sig) {
        var kp = tcSigKey(sig) + '|', n, h, key, prev, win, now = Date.now(), up = (sig.col === 'R');
        for (n = 0; n < plan.hist.length; n++) {
            h = plan.hist[n];
            key = kp + h.i;
            prev = TC.seen[key];
            if (prev === 'pending' && h.res !== 'pending') {
                win = tcWin(h.res);
                TC.flash[key] = { t0: now, win: win };
                if (win === 'win' || win === 'loss') {
                    TC.banner = { kind: win, t0: now, dur: 8000, idx: h.i, sig: sig, up: up };
                    try { if (typeof evtLog === 'function') evtLog(win === 'win' ? 'INFO' : 'WARN', 'SIGNAL RESULT ' + win.toUpperCase() + ' ' + tcSigText(sig) + ' @' + tcFmt(h.i, true)); } catch (eW) {}
                }
            }
            TC.seen[key] = h.res;
        }
        if (plan.kind === 'FIRED') {
            var hk = kp + plan.idx;
            if (TC.hitSeen !== hk) {
                TC.hitSeen = hk;
                if (TC.ready) {
                    TC.banner = { kind: 'hit', t0: now, dur: 5000, idx: plan.idx, sig: sig, up: up }; TC.activeAt = now;
                    try { if (typeof evtLog === 'function') evtLog('INFO', 'SIGNAL HIT ' + tcSigText(sig) + ' @' + tcFmt(plan.idx, true) + ' result in ' + sig.c + 's'); } catch (eT) {}
                    try { if (window.afHit) window.afHit(now); } catch (eH) {}
                }
            }
        }
        if (plan.missed) {
            var mk = kp + 'miss';
            if (TC.hitSeen !== mk) {
                TC.hitSeen = mk;
                if (TC.ready) {
                    TC.banner = { kind: 'miss', t0: now, dur: 5000, idx: -1, sig: sig, up: up }; TC.activeAt = now;
                    try { if (typeof evtLog === 'function') evtLog('WARN', 'SIGNAL MISSED - streak already past X' + sig.s1 + ' (' + tcSigText(sig) + ')'); } catch (eY) {}
                    try { if (window.appFlash) window.appFlash('miss', 'SIGNAL MISSED (X' + plan.streak + ')'); } catch (eM) {}
                }
            }
        }
        var ek = startTs() + '|' + tcSigKey(sig), ex = TC.exp, mm = null;
        if (plan.kind === 'FIRED') {
            TC.exp = null;
        } else if (plan.kind === 'FUT') {
            if (ex && ex.k === ek && ex.idx !== plan.idx) mm = ex.idx;
            TC.exp = { k: ek, idx: plan.idx };
        } else {
            if (ex && ex.k === ek && !plan.missed) mm = ex.idx;
            TC.exp = null;
        }
        if (mm !== null && TC.ready) {
            var mmsg = 'TRADE MISSED - SIGNAL REQ NOT MET (' + tcSigText(sig) + ')';
            TC.banner = { kind: 'miss', t0: now, dur: 6000, idx: -1, sig: sig, up: up }; TC.activeAt = now;
            try { if (window.appFlash) window.appFlash('miss', mmsg); } catch (eN) {}
            try { if (typeof evtLog === 'function') evtLog('WARN', mmsg + ' @' + tcFmt(mm, true)); } catch (eL) {}
        }
        TC.ready = true;
    }

    /* ------------------------------------------------------------------ tooltip */
    function tcTipHtml(o) {
        var s = o.sig, dec = (o.dec !== undefined ? o.dec : TC.dec);
        var nowSec = Math.floor(Date.now() / 1000) - startTs();
        var GREEN = cGreen(), RED = cRed();
        var cc = s.col === 'G' ? GREEN : RED;
        var expUp = (s.col === 'R');
        var rows = [];
        var row = function (k, v, c) {
            rows.push('<div style="display:flex;justify-content:space-between;gap:14px;"><span style="color:#8890b8;">' + k + '</span><span style="color:' + (c || '#E2E8F0') + ';">' + v + '</span></div>');
        };
        var hc = [getPairDisplayName(s.pair), 'C' + s.c, 'R' + s.r, 'X' + s.s1 + '-X' + s.s2, String(s.c1), String(s.c2), s.pct + '%'], hw = [28, 11, 11, 18, 9, 9, 14], hh = '', hk;
        for (hk = 0; hk < hc.length; hk++) hh += '<span style="flex:0 0 ' + hw[hk] + '%;box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:' + (hk === 0 ? '6px 3px 6px 6px' : '6px 2px') + ';text-align:' + (hk === 0 ? 'left' : 'center') + ';' + (hk < hc.length - 1 ? 'border-right:1px solid #000432;' : '') + '">' + hc[hk] + '</span>';
        rows.push('<div style="display:flex;min-width:250px;background:' + (expUp ? GREEN : RED) + ';color:#000432;font-size:11px;font-weight:700;margin-bottom:5px;border-radius:4px;overflow:hidden;">' + hh + '</div>');
        row('Streak', 'X' + s.s1 + ' \u2192 X' + s.s2 + (s.col === 'G' ? ' (UP run)' : ' (DOWN run)'));
        row('Score', Math.round(s.pct * s.c1));
        row('Gap', 'F' + (s.gap || 0) + '  now ' + (s.curGap || 0));
        row('Expects', 'next row tick ' + (expUp ? 'UP' : 'DOWN'), expUp ? GREEN : RED);
        row('Wins if', 'next tick reverses');
        var nextIdx = o.idx + s.c;
        if (o.kind === 'MARK') {
            row('Triggered', tcFmt(o.idx, true) + ' IST');
            row('Price', o.p.toFixed(dec + 1));
            row('Next tick', tcFmt(nextIdx, true) + ' IST');
            if (o.win === 'win') row('Result', '\u2713 WIN (' + (o.res === 'cont' ? 'continued' : 'reversed') + ')', GREEN);
            else if (o.win === 'loss') row('Result', '\u2717 LOSS (' + (o.res === 'cont' ? 'continued' : 'reversed') + ')', RED);
            else if (o.win === 'none') row('Result', 'no tick at next slot', '#8890b8');
            else row('Result', 'PENDING \u2014 in ' + tcFmtIn(nextIdx - nowSec), '#FFFFFF');
            var tt = tcTradeFor(o.idx);
            if (tt) {
                var ttKnown = (tt.pnl !== null && tt.pnl !== undefined), ttPnl = ttKnown ? Number(tt.pnl) : 0;
                row('Trade', (tt.type === 'CALL' ? '\u25B2 ' : '\u25BC ') + tt.type + ' $' + tcMoney(tt.stake), '#FFFFFF');
                if (tt.status === 'OPEN') row('Trade status', 'OPEN', '#FFD700');
                else if (ttKnown) row('Trade P&L', (ttPnl > 0 ? '+$' : (ttPnl < 0 ? '-$' : '$')) + tcMoney(ttPnl), ttPnl > 0 ? GREEN : (ttPnl < 0 ? RED : '#E2E8F0'));
                else row('Trade P&L', 'unknown - check Deriv', '#8890b8');
                if (Number(tt.entry_price) > 0) row('Entry', Number(tt.entry_price).toFixed(dec + 1));
                if (Number(tt.exit_price) > 0) row('Exit', Number(tt.exit_price).toFixed(dec + 1));
            }
        } else if (o.kind === 'FIRED') {
            row('Status', '\u25CF HIT', '#FFFFFF');
            row('Triggered', tcFmt(o.idx, true) + ' IST');
            row('Result due', tcFmt(nextIdx, true) + ' IST  in ' + tcFmtIn(nextIdx - nowSec), '#FFFFFF');
        } else if (o.missed) {
            row('Status', 'MISSED', '#8890b8');
            row('Reason', 'Streak already past X' + s.s1, '#FFFFFF');
        } else {
            row('Trigger at', tcFmt(o.idx, true) + ' IST');
            row('In', tcFmtIn(o.idx - nowSec), '#FFFFFF');
            row('Ticks needed', o.need + (o.need === 1 ? '  (READY)' : ''), o.need === 1 ? GREEN : '#E2E8F0');
            if (o.ref !== null && o.ref !== undefined) row('Price must be', (s.col === 'G' ? '> ' : '< ') + o.ref.toFixed(dec + 1), '#FFFFFF');
        }
        return rows.join('');
    }
    function tcHideTip() {
        TC.mx = -1; TC.my = -1;
        if (TC.tip) TC.tip.style.display = 'none';
    }
    function tcHoverAt(mx, my) {
        var best = null, bd = Infinity, i, h, dx, dy, dd;
        for (i = TC.hov.length - 1; i >= 0; i--) {
            h = TC.hov[i];
            if (h.w) {
                if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) { best = h; break; }
            } else {
                dx = mx - h.x; dy = my - h.y;
                dd = Math.sqrt(dx * dx + dy * dy);
                if (dd <= h.r && dd < bd) { bd = dd; best = h; }
            }
        }
        if (!best) {
            if (TC.tip) TC.tip.style.display = 'none';
            return false;
        }
        if (!TC.tip) {
            TC.tip = document.createElement('div');
            TC.tip.style.cssText = "position:absolute; z-index:5; pointer-events:none; background:var(--bg-base); border:1px solid #FFFFFF; border-radius:2px; padding:6px 9px; font-family:'JetBrains Mono',monospace; font-size:11px; font-weight:700; line-height:1.45; min-width:210px; max-width:300px; white-space:nowrap; display:none;";
            TC.wrap.appendChild(TC.tip);
        }
        var tip = TC.tip;
        tip.innerHTML = tcTipHtml(best.o);
        tip.style.display = 'block';
        var tw = tip.offsetWidth, th = tip.offsetHeight;
        var lx = mx + 14, ty = my + 14;
        if (lx + tw > TC.W - 4) lx = mx - tw - 14;
        if (ty + th > TC.H - 4) ty = my - th - 14;
        if (lx < 2) lx = 2;
        if (ty < 2) ty = 2;
        tip.style.left = lx + 'px';
        tip.style.top = ty + 'px';
        return true;
    }
    function tcClick(mx, my) {
        var i, h, s;
        for (i = TC.hits.length - 1; i >= 0; i--) {
            h = TC.hits[i];
            if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) {
                s = h.sig;
                if (typeof manualSelectSignal === 'function') manualSelectSignal(s.pair, s.c, s.r, s.s1, s.s2, s.col, s.type, s.gap || 0, s.curGap || 0);
                return true;
            }
        }
        return false;
    }

    /* ------------------------------------------------------------------ small canvas helpers */
    function rrPath(ctx, x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }
    function fitFont(ctx, texts, widths, start, min) {
        var fs = start, n, ok;
        do {
            ctx.font = 'bold ' + fs + 'px ' + MONO;
            ok = true;
            for (n = 0; n < texts.length; n++) { if (ctx.measureText(texts[n]).width > widths[n]) { ok = false; break; } }
            if (!ok) fs -= 1;
        } while (!ok && fs > min);
        return fs;
    }
    function glyph(ctx, sym, x, y, fs, col, bg) {
        ctx.save();
        ctx.font = 'bold ' + fs + 'px ' + MONO;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, fs / 9); ctx.strokeStyle = bg;
        ctx.strokeText(sym, x, y + 1);
        ctx.fillStyle = col;
        ctx.fillText(sym, x, y + 1);
        ctx.restore();
    }

    /* ------------------------------------------------------------------ the draw */
    function tcDrawAll() {
        var W = TC.W, H = TC.H, dpr = TC.dpr, ctx = TC.ctx, i, k, n;
        var BG = cBg(), CBG = cChart(), GREEN = cGreen(), RED = cRed(), PC = pairColor(), TICKG = cTickGreen(), CROSSR = cCrossRed();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
        ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
        ctx.fillStyle = CBG; ctx.fillRect(0, 0, W, H);
        TC.hov = []; TC.hits = []; TC.pulseOn = false;
        if (S && S.scan) {
            var bgLeft = Math.max(0, ((S.cfg && S.cfg.interval) || 300) - ((S.now || Math.floor(Date.now() / 1000)) - S.scan.at));
            var bgTxt = bgLeft > 0 ? bgLeft + 's' : 'SCANNING';
            var bgFs = Math.max(24, Math.min(Math.round(W * (bgLeft > 0 ? 0.2 : 0.11)), Math.round(H * 0.38)));
            var bgX = (PADL + W - PADR) / 2, bgY = H * 0.46;
            ctx.save();
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.globalAlpha = 0.09; ctx.fillStyle = PC;
            ctx.font = 'bold ' + bgFs + 'px ' + MONO;
            ctx.fillText(bgTxt, bgX, bgY);
            ctx.font = 'bold ' + Math.max(10, Math.round(bgFs * 0.18)) + 'px ' + MONO;
            ctx.fillText('NEXT SCAN', bgX, bgY - bgFs * 0.62);
            ctx.restore();
        }

        var prices = (S && S.prices) ? S.prices : null;
        if (!prices || prices.length === 0) {
            ctx.fillStyle = '#FFFFFF'; ctx.font = 'bold 12px ' + MONO;
            ctx.fillText((S ? getPairDisplayName(S.symbol) : 'TICK') + ' - WAITING FOR DATA...', PADL, 20);
            return;
        }
        var pair = S.symbol, pname = getPairDisplayName(pair);
        var len = prices.length, sEnd = S.len;
        var nowSec = Math.floor(Date.now() / 1000) - S.start;
        var live = nowSec >= 0 && nowSec < sEnd;
        var last = tcLastReal(prices, Math.min(live ? nowSec : sEnd, len - 1));
        var fin = live ? Math.min(nowSec - 1, last) : last;
        var nowIdx = live ? nowSec : Math.max(0, last);

        tcUpdateSignal(prices, fin, sEnd);
        var sig = TC.sig;
        var plan = sig ? tcPlan(sig, prices, fin, sEnd, fin) : null;
        if (sig && plan) { tcMeasure(plan, sig, prices, last); tcTrack(plan, sig); }
        var expUp = sig ? (sig.col === 'R') : true;
        var dirCol = expUp ? GREEN : RED;

        /* ---- geometry + view ---- */
        PADR = clamp(Math.round(TC.axW || 52), 40, 86);
        var plotL = PADL, plotR = W - PADR, plotW = plotR - plotL, ptop = PADT, pbot = H - PADB, spp = TC.spp;
        try { document.documentElement.style.setProperty('--tc-padb', Math.max(0, H - Math.round(pbot) - 1) + 'px'); } catch (e0) {}

        var ocSigNow = lastClickedSigId + '|' + clickCycleIndex + '|' + currentInstanceIndex;
        if (TC.ocSig !== ocSigNow) {
            if (clickCycleIndex === -1) {
                TC.ocSig = ocSigNow; TC.follow = true;
            } else if (currentInstanceIndex >= 0 && currentInstanceIndex < currentInstances.length) {
                TC.ocSig = ocSigNow;
                var ocJ = currentInstances[currentInstanceIndex];
                TC.follow = false;
                TC.left = (ocJ.col * CYCLE + ocJ.row - _cycleOff()) - plotW * spp / 2;
            }
        }
        if (TC.follow) TC.left = nowIdx - plotW * spp * 0.4; else tcClamp(plotW);
        var left = TC.left, right = left + plotW * spp;
        var i0 = Math.max(0, Math.floor(left)), i1 = Math.min(len - 1, sEnd, Math.ceil(right));
        var xOf = function (ix) { return plotL + (ix - left) / spp; };

        /* ---- price range (auto) ---- */
        var lo = Infinity, hi = -Infinity, v, stp = Math.max(1, Math.floor(spp / 2));
        while ((i1 - i0) / stp > 9000) stp *= 2;
        for (i = i0; i <= i1; i += stp) {
            v = prices[i];
            if (v === -1) continue;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        if (!(hi >= lo)) {
            if (last >= 0) { lo = prices[last]; hi = lo; } else { lo = 0; hi = 1; }
        }
        if (!(hi > lo)) { var mm = Math.abs(lo) * 0.0002 || 0.0001; lo -= mm; hi += mm; }
        TC.dec = Math.max(0, Math.min(6, 3 - Math.floor(Math.log10(hi - lo))));
        var pad0 = (hi - lo) * 0.04; lo -= pad0; hi += pad0;
        if (plan) {  /* keep every box at most half the chart height */
            var bMax = 0, hh;
            for (n = 0; n < plan.hist.length; n++) {
                hh = plan.hist[n];
                if (hh.res === 'none' || hh.i > i1 || hh.i + sig.c < i0) continue;
                if (hh.hi - hh.lo > bMax) bMax = hh.hi - hh.lo;
            }
            var bNeed = bMax / 0.5;
            if (bNeed > hi - lo) { var bMid = (hi + lo) / 2; lo = bMid - bNeed / 2; hi = bMid + bNeed / 2; }
        }
        var zZ = TC.yZ || 1, zO = TC.yOff || 0;
        if (zZ !== 1 || zO !== 0) {
            var zA = hi - lo, zC = (hi + lo) / 2 + zO * zA, zR = zA / zZ;
            lo = zC - zR / 2; hi = zC + zR / 2;
        }
        var yOf = function (pv) { return ptop + (1 - (pv - lo) / (hi - lo)) * (pbot - ptop); };

        /* ---- price ticks ---- */
        var pxTicks = [], pxStep = 1;
        var gxRaw = (hi - lo) / 5, gxMag = Math.pow(10, Math.floor(Math.log10(gxRaw))), gxNorm = gxRaw / gxMag;
        pxStep = (gxNorm < 1.5 ? 1 : (gxNorm < 3 ? 2 : (gxNorm < 7 ? 5 : 10))) * gxMag;
        var gxFirst = Math.ceil(lo / pxStep), gxLastN = Math.floor(hi / pxStep), gxN;
        for (gxN = gxFirst; gxN <= gxLastN && gxN - gxFirst < 24; gxN++) {
            pxTicks.push({ v: gxN * pxStep, y: Math.round(yOf(gxN * pxStep)) + 0.5 });
        }
        var axDec = Math.max(0, Math.min(8, Math.ceil(-Math.log10(pxStep) - 1e-9)));
        var lastP = last >= 0 ? prices[last] : null;
        var axStrDec = 0;
        if (lastP !== null) { var axParts = String(lastP).split('.'); axStrDec = axParts[1] ? axParts[1].length : 0; }
        var axTagDec = (axDec === 0) ? 0 : Math.min(8, Math.max(axDec + 1, axStrDec));
        ctx.font = '10px ' + MONO;
        var axNeed = 0;
        for (k = 0; k < pxTicks.length; k++) axNeed = Math.max(axNeed, Math.ceil(ctx.measureText(pxTicks[k].v.toFixed(axDec)).width) + 12);
        if (lastP !== null) { ctx.font = 'bold 10px ' + MONO; axNeed = Math.max(axNeed, Math.ceil(ctx.measureText(lastP.toFixed(axTagDec)).width) + 12); }
        if (axNeed && Math.abs(axNeed - (TC.axW || 0)) > 2) { TC.axW = axNeed; tcRequest(); }

        /* ---- time ticks ---- */
        var steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
        var tstep = steps[steps.length - 1];
        for (k = 0; k < steps.length; k++) { if (steps[k] / spp >= 78) { tstep = steps[k]; break; } }
        var off = tcOffset();
        var firstT = Math.ceil((left + off) / tstep) * tstep - off, t;

        /* ================= PLOT (clipped) ================= */
        ctx.save();
        ctx.beginPath(); ctx.rect(plotL, ptop, plotW, pbot - ptop); ctx.clip();

        ctx.lineWidth = 1;
        for (k = 0; k < pxTicks.length; k++) {
            ctx.strokeStyle = PC; ctx.globalAlpha = 0.16;
            ctx.beginPath(); ctx.moveTo(plotL, pxTicks[k].y); ctx.lineTo(plotR, pxTicks[k].y); ctx.stroke();
        }
        for (t = firstT; t <= right; t += tstep) {
            if (t < 0 || t > sEnd) continue;
            var gx = Math.round(xOf(t)) + 0.5;
            ctx.strokeStyle = PC; ctx.globalAlpha = 0.12;
            ctx.beginPath(); ctx.moveTo(gx, ptop); ctx.lineTo(gx, pbot); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        var xe = xOf(sEnd);
        if (xe >= plotL && xe <= plotR) {
            ctx.strokeStyle = PC; ctx.setLineDash([2, 4]);
            ctx.beginPath(); ctx.moveTo(Math.round(xe) + 0.5, ptop); ctx.lineTo(Math.round(xe) + 0.5, pbot); ctx.stroke();
            ctx.setLineDash([]);
        }

        var now = Date.now();
        if (false && sig && plan && live && (plan.kind === 'FIRED' || plan.kind === 'FUT')) {
            var bgLbl = '', bgT = '', bgRf, bgRn;
            if (plan.kind === 'FIRED') {
                bgRf = (plan.idx + sig.c - nowSec) - ((now % 1000) / 1000);
                bgLbl = 'RESULT IN';
                bgT = bgRf > 0 ? bgRf.toFixed(1) + 's' : 'NOW';
            } else {
                bgRn = (plan.idx - nowSec) - ((now % 1000) / 1000);
                bgLbl = 'SIGNAL HITS IN';
                bgT = bgRn > 0 ? (bgRn >= 100 ? tcFmtIn(Math.ceil(bgRn)) : bgRn.toFixed(1) + 's') : 'NOW';
            }
            bgFs = clamp(Math.round(Math.min(plotW / (Math.max(bgT.length, 6) * 0.66), (pbot - ptop) * 0.45)), 24, 140);
            ctx.save();
            ctx.globalAlpha = 0.2; ctx.fillStyle = PC;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = 'bold ' + bgFs + 'px ' + MONO;
            ctx.fillText(bgT, (plotL + plotR) / 2, (ptop + pbot) / 2);
            ctx.font = 'bold ' + Math.max(12, Math.round(bgFs * 0.3)) + 'px ' + MONO;
            ctx.fillText(bgLbl, (plotL + plotR) / 2, (ptop + pbot) / 2 - bgFs * 0.72);
            ctx.restore();
        }
        /* ---- price line (bucket averaged when zoomed out) ---- */
        var st = Math.max(1, Math.floor(spp / 2)), lastI = -99999, started = false;
        var iEnd = last >= 0 ? Math.min(i1, last) : -1;
        ctx.strokeStyle = PC; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        for (i = i0 - (i0 % st); i <= iEnd; i += st) {
            var qs = 0, qn = 0, qk;
            for (qk = Math.max(0, i); qk < i + st && qk <= iEnd; qk++) {
                if (prices[qk] !== -1) { qs += prices[qk]; qn++; }
            }
            if (!qn) continue;
            var qc = i + (st - 1) / 2, qv = qs / qn;
            if (qc > last) { qc = last; qv = prices[last]; }
            var lx = xOf(qc), ly = yOf(qv);
            if (!started || i - lastI > 600) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
            started = true; lastI = i;
        }
        ctx.stroke();

        /* ---- boxes: auto drawn at every hit, painted tick / cross when the result tick lands,
               with the trade details (OPEN / P&L, type + stake, entry -> exit) inside ---- */
        if (plan && sig) {
            var kp = tcSigKey(sig) + '|';
            for (n = 0; n < plan.hist.length; n++) {
                var h = plan.hist[n];
                var j = h.i + sig.c;
                var mx = xOf(h.i), ex = xOf(j);
                if (ex < plotL - 2 || mx > plotR + 2) continue;
                var pend = (h.res === 'pending'), none = (h.res === 'none');
                var win = tcWin(h.res);
                var rCol = PC;
                var my = yOf(h.p);
                var bxL = mx, bxR = ex;
                var trLines = tcTradeLines(tcTradeFor(h.i));
                var boxMinH = trLines.length ? 56 : 18;
                var by1 = Math.max(ptop, yOf(h.hi) - 3), by2 = Math.min(pbot, yOf(h.lo) + 3);
                if (by2 - by1 < boxMinH) { var bm = (by1 + by2) / 2; by1 = Math.max(ptop, bm - boxMinH / 2); by2 = Math.min(pbot, bm + boxMinH / 2); }
                var bw = bxR - bxL;
                var visL = Math.max(bxL, plotL), visR = Math.min(bxR, plotR);
                var bxC = (bxL + bxR) / 2, byC = (by1 + by2) / 2, bxRad = Math.max(0, bw / 2), byRad = Math.max(1, (by2 - by1) / 2), boxR = 8;

                if (!none && bw > 1) {
                    ctx.save();
                    /* win zone (the side the price must end on) */
                    if (pend) {
                        ctx.globalAlpha = 0.14; ctx.fillStyle = PC;
                        rrPath(ctx, bxL, by1, bw, by2 - by1, boxR); ctx.fill();
                        ctx.globalAlpha = 0.10; ctx.fillStyle = PC;
                        ctx.save();
                        rrPath(ctx, bxL, by1, bw, by2 - by1, boxR); ctx.clip();
                        if (expUp) ctx.fillRect(bxL, by1, bw, Math.max(0, my - by1)); else ctx.fillRect(bxL, my, bw, Math.max(0, by2 - my));
                        ctx.restore();
                    } else {
                        ctx.globalAlpha = 0.17; ctx.fillStyle = rCol;
                        rrPath(ctx, bxL, by1, bw, by2 - by1, boxR); ctx.fill();
                    }
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = PC; ctx.lineWidth = pend ? 1.6 : 2;
                    if (pend) ctx.setLineDash([5, 3]);
                    rrPath(ctx, bxL + 0.5, by1 + 0.5, Math.max(0, bw - 1), Math.max(0, by2 - by1 - 1), boxR);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.restore();
                    /* entry level across the box */
                    ctx.save();
                    ctx.strokeStyle = PC; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.2;
                    ctx.setLineDash(pend ? [3, 3] : []);
                    ctx.beginPath(); ctx.moveTo(bxL, my); ctx.lineTo(bxR, my); ctx.stroke();
                    ctx.restore();
                }
                /* entry dot */
                rrPath(ctx, mx - 6.2, my - 6.2, 12.4, 12.4, 4);
                ctx.lineWidth = 1.6; ctx.strokeStyle = PC; ctx.stroke();
                rrPath(ctx, mx - 4, my - 4, 8, 8, 2.5);
                ctx.fillStyle = PC; ctx.fill();
                ctx.lineWidth = 1; ctx.strokeStyle = BG; ctx.stroke();
                TC.hov.push({ x: mx, y: my, r: 9, o: { sig: sig, idx: h.i, kind: 'MARK', res: h.res, win: win, p: h.p, dec: TC.dec } });

                if (pend) {
                    /* waiting for the result tick: pulse + remaining time + trade details */
                    TC.pulseOn = true;
                    var pp = 0.5 + 0.5 * Math.sin(now / 200);
                    rrPath(ctx, mx - (8 + 3 * pp), my - (8 + 3 * pp), 2 * (8 + 3 * pp), 2 * (8 + 3 * pp), 5 + 2 * pp);
                    ctx.lineWidth = 1.2; ctx.strokeStyle = PC; ctx.stroke();
                    if (ex >= plotL && ex <= plotR) {
                        rrPath(ctx, ex - 4.5, my - 4.5, 9, 9, 3);
                        ctx.lineWidth = 1.6; ctx.strokeStyle = PC; ctx.stroke();
                    }
                    if (trLines.length && trLines[0].t === 'OPEN' && bw > 1) {
                        ctx.save();
                        ctx.globalAlpha = 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(now / 180));
                        ctx.fillStyle = '#FFD700';
                        rrPath(ctx, bxL, by1, bw, by2 - by1, boxR); ctx.fill();
                        ctx.restore();
                        TC.pulseOn = true;
                    }
                    var pnLn = tcInfoCount(trLines, visR - visL, by2 - by1, 4);
                    if (pnLn > 0) tcDrawTradeInfo(trLines, pnLn, visL, visR, (by1 + by2) / 2 - (pnLn - 1) * TRADE_LINE_H / 2, BG);
                } else if (!none) {
                    /* result dot + big tick / cross (trade details sit under it) */
                    var q = prices[j];
                    if (q !== -1 && q !== undefined && ex >= plotL && ex <= plotR) {
                        var qy = yOf(q);
                        rrPath(ctx, ex - 4.5, qy - 4.5, 9, 9, 3);
                        ctx.fillStyle = rCol; ctx.fill();
                        ctx.lineWidth = 1.5; ctx.strokeStyle = BG; ctx.stroke();
                        TC.hov.push({ x: ex, y: qy, r: 9, o: { sig: sig, idx: h.i, kind: 'MARK', res: h.res, win: win, p: h.p, dec: TC.dec } });
                    }
                    var rsLn = tcInfoCount(trLines, visR - visL, by2 - by1, 20);
                    var infoH = rsLn * TRADE_LINE_H + (rsLn ? 2 : 0);
                    var ovLift = rsLn ? Math.round((by2 - by1) * 0.12) : 0;
                    var gcx = (visL + visR) / 2, gcy = (by1 + by2 - infoH - ovLift) / 2;
                    var gfs = clamp(Math.round(bw * 1.25), 14, 44);
                    if (rsLn > 0) gfs = clamp(Math.min(gfs, (by2 - by1) - infoH - ovLift - 6), 12, 44);
                    if (bw >= 5 && visR - visL > 2) {
                        glyph(ctx, win === 'win' ? '\u2713' : '\u2717', gcx, gcy, gfs, win === 'win' ? TICKG : CROSSR, BG);
                        TC.hov.push({ x: gcx, y: gcy, r: Math.max(9, gfs / 2), o: { sig: sig, idx: h.i, kind: 'MARK', res: h.res, win: win, p: h.p, dec: TC.dec } });
                    }
                    if (rsLn > 0) {
                        var ovY0 = by2 - infoH + TRADE_LINE_H / 2 - 1 - ovLift;
                        tcDrawTradeInfo(trLines, rsLn, visL, visR, ovY0, BG);
                    }
                    var fl = TC.flash[kp + h.i];
                    if (fl) {
                        var fa = (now - fl.t0) / 1600;
                        if (fa >= 1) { delete TC.flash[kp + h.i]; }
                        else {
                            TC.pulseOn = true;
                            if (bw > 1) {
                                ctx.save();
                                ctx.globalAlpha = 0.45 * (1 - fa) * (0.5 + 0.5 * Math.cos(fa * 6.2832 * 3));
                                ctx.fillStyle = win === 'win' ? TICKG : CROSSR;
                                rrPath(ctx, bxL, by1, bw, by2 - by1, boxR); ctx.fill();
                                ctx.restore();
                            }
                            ctx.save();
                            ctx.globalAlpha = 1 - fa; ctx.lineWidth = 3 * (1 - fa) + 1; ctx.strokeStyle = rCol;
                            rrPath(ctx, gcx - (10 + fa * 40), gcy - (10 + fa * 40), 2 * (10 + fa * 40), 2 * (10 + fa * 40), 6 + fa * 14); ctx.stroke();
                            ctx.restore();
                        }
                    }
                }
            }
        }

        /* ---- expected point (waiting for the signal) ---- */
        if (plan && plan.kind === 'FUT' && live) {
            var fx = xOf(plan.idx);
            var fyLast = last >= 0 ? yOf(prices[last]) : (ptop + pbot) / 2;
            var fxLast = last >= 0 ? xOf(last) : plotL;
            var fy = (plan.ref !== null && plan.ref !== undefined) ? yOf(plan.ref) : fyLast;
            ctx.save();
            ctx.strokeStyle = PC; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.85; ctx.setLineDash([5, 4]);
            ctx.beginPath(); ctx.moveTo(Math.max(plotL, fxLast), fyLast); ctx.lineTo(fx, fyLast); ctx.stroke();
            ctx.globalAlpha = 0.35; ctx.setLineDash([2, 4]);
            ctx.beginPath(); ctx.moveTo(fx, ptop); ctx.lineTo(fx, pbot); ctx.stroke();
            ctx.setLineDash([]); ctx.globalAlpha = 1;
            if (fx >= plotL && fx <= plotR) {
                var ready = (plan.need === 1);
                if (ready && plan.ref !== null && plan.ref !== undefined) {
                    /* the price has to end on this side of the reference to fire */
                    var ra = (sig.col === 'G') ? -1 : 1;
                    ctx.strokeStyle = PC; ctx.lineWidth = 1.6;
                    ctx.beginPath(); ctx.moveTo(fx - 16, fy); ctx.lineTo(fx + 16, fy); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(fx - 5, fy + ra * 8); ctx.lineTo(fx, fy + ra * 2); ctx.lineTo(fx + 5, fy + ra * 8); ctx.stroke();
                }
                var fcSec = (plan.idx - nowSec) - ((now % 1000) / 1000);
                var fcTxt = fcSec > 0 ? (fcSec >= 100 ? tcFmtIn(Math.ceil(fcSec)) : fcSec.toFixed(1) + 's') : 'NOW';
                if (fcSec > 0) TC.pulseOn = true;
                ctx.font = 'bold 16px ' + MONO;
                var fcW16 = ctx.measureText(fcTxt).width;
                var fcFull = Math.max(28, Math.ceil(fcW16 / 2) + 10);
                var fcT = clamp(fcSec / 10, 0, 1);
                var fcRad = 5 + (fcFull - 5) * fcT;
                if (fcSec > 0 && fcSec <= 3) {
                    var fcPh = (now % 600) / 600;
                    ctx.save();
                    ctx.globalAlpha = 1 - fcPh; ctx.lineWidth = 2; ctx.strokeStyle = PC;
                    ctx.beginPath(); ctx.arc(fx, fyLast, fcRad + 4 + fcPh * 14, 0, 6.2832); ctx.stroke();
                    ctx.restore();
                }
                ctx.beginPath(); ctx.arc(fx, fyLast, fcRad, 0, 6.2832);
                ctx.fillStyle = PC; ctx.fill();
                var fcFs = Math.floor(16 * Math.min(1, (fcRad * 1.7) / fcW16));
                if (fcFs >= 8 && fcSec > 0) {
                    ctx.font = 'bold ' + fcFs + 'px ' + MONO;
                    ctx.fillStyle = BG; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillText(fcTxt, fx, fyLast + 1);
                }

                TC.hov.push({ x: fx, y: fyLast, r: Math.max(10, fcRad), o: { sig: sig, idx: plan.idx, kind: 'FUT', need: plan.need, ref: plan.ref, dec: TC.dec } });

            }
            ctx.restore();
        }
        /* ---- fired: pulsing ring on the hit point ---- */
        if (plan && plan.kind === 'FIRED') {
            var fp = prices[plan.idx];
            if (fp !== -1 && fp !== undefined) {
                var hx = xOf(plan.idx), hy = yOf(fp);
                var flPh = (now % 1200) / 1200;
                TC.pulseOn = true; TC.activeAt = now;
                ctx.save();
                ctx.globalAlpha = 1 - flPh; ctx.lineWidth = 2; ctx.strokeStyle = PC;
                ctx.beginPath(); ctx.arc(hx, hy, 6 + flPh * 12, 0, 6.2832); ctx.stroke();
                ctx.restore();
                TC.hov.push({ x: hx, y: hy, r: 10, o: { sig: sig, idx: plan.idx, kind: 'FIRED', need: 0, ref: null, dec: TC.dec } });
            }
        }

        /* ---- grid instances of the clicked signal (purple rings, T = true / F = false) ---- */
        if (typeof lastClickedSigId === 'string' && lastClickedSigId && currentInstances.length > 0) {
            var ocP = lastClickedSigId.split('-');
            if (ocP.length === 7 && ocP[0] === pair && (+ocP[1]) === CYCLE) {
                var ocSg = tcFindSig(+ocP[1], +ocP[2], +ocP[3], +ocP[4], ocP[5]);
                var ocOff = _cycleOff(), ocPulse = 0.5 + 0.5 * Math.sin(now / 200), ocN;
                for (ocN = 0; ocN < currentInstances.length; ocN++) {
                    var ocInst = currentInstances[ocN];
                    var ocIdx = ocInst.col * CYCLE + ocInst.row - ocOff;
                    if (ocIdx < i0 || ocIdx > i1) continue;
                    var ocPv = prices[ocIdx];
                    if (ocPv === -1 || ocPv === undefined) continue;
                    var ocX = xOf(ocIdx), ocY = yOf(ocPv);
                    if (ocX < plotL || ocX > plotR) continue;
                    var ocSel = (ocN === currentInstanceIndex);
                    var ocLbl = ocInst.isFalse ? ('F' + (ocInst.falseSeq || 1)) : 'T';
                    var ocLy = (ocY - 17 < ptop + 6) ? ocY + 17 : ocY - 17;
                    ctx.save();
                    if (ocSel) {
                        ctx.strokeStyle = PC; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
                        ctx.beginPath(); ctx.moveTo(Math.round(ocX) + 0.5, ptop); ctx.lineTo(Math.round(ocX) + 0.5, pbot); ctx.stroke();
                        ctx.setLineDash([]); TC.pulseOn = true;
                    }
                    ctx.globalAlpha = 1;
                    ctx.beginPath(); ctx.arc(ocX, ocY, ocSel ? 10 + 3 * ocPulse : 9, 0, 6.2832);
                    ctx.lineWidth = ocSel ? 3 : 2; ctx.strokeStyle = PC; ctx.stroke();
                    ctx.font = 'bold 10px ' + MONO; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.lineWidth = 3; ctx.strokeStyle = BG; ctx.strokeText(ocLbl, ocX, ocLy);
                    ctx.fillStyle = PC; ctx.fillText(ocLbl, ocX, ocLy);
                    ctx.restore();
                    if (ocSg) {
                        var ocRes = (ocIdx + CYCLE > fin) ? 'pending' : ((!ocInst.isFalse) ? 'rev' : 'cont');
                        TC.hov.push({ x: ocX, y: ocY, r: 11, o: { sig: ocSg, idx: ocIdx, kind: 'MARK', res: ocRes, win: tcWin(ocRes), p: ocPv, dec: TC.dec } });
                    }
                }
            }
        }

        /* ---- last tick dot ---- */
        if (last >= 0 && last >= i0 && last <= i1) {
            var ex0 = xOf(last), ey0 = yOf(prices[last]);
            rrPath(ctx, ex0 - 4.5, ey0 - 4.5, 9, 9, 3);
            ctx.fillStyle = PC; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = BG; ctx.stroke();
        }
        ctx.restore();
        /* ================= end plot ================= */

        /* ---- axes ---- */
        ctx.save();
        ctx.fillStyle = CBG;
        ctx.fillRect(plotR, 0, W - plotR, H);
        ctx.fillRect(0, pbot + 1, W, H - pbot - 1);
        var axLine = PC;
        ctx.strokeStyle = axLine; ctx.lineWidth = 1; ctx.setLineDash([]);
        ctx.strokeStyle = PC;
        ctx.beginPath(); ctx.moveTo(Math.round(plotR) + 0.5, 0); ctx.lineTo(Math.round(plotR) + 0.5, pbot + 0.5); ctx.stroke();
        ctx.strokeStyle = axLine;
        ctx.beginPath(); ctx.moveTo(0, Math.round(pbot) + 0.5); ctx.lineTo(W, Math.round(pbot) + 0.5); ctx.stroke();

        var axLastY = (lastP !== null) ? clamp(yOf(lastP), ptop + 8, pbot - 10) : -1000;
        ctx.font = '10px ' + MONO; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (k = 0; k < pxTicks.length; k++) {
            var axT = pxTicks[k];
            if (axT.y < ptop + 14 || axT.y > pbot - 14 || Math.abs(axT.y - axLastY) < 14) continue;
            ctx.strokeStyle = axLine;
            ctx.beginPath(); ctx.moveTo(plotR, axT.y); ctx.lineTo(plotR + 3, axT.y); ctx.stroke();
            ctx.fillStyle = PC;
            ctx.fillText(axT.v.toFixed(axDec), plotR + 6, axT.y + 0.5);
        }
        if (lastP !== null) {
            var axTagW = PADR - 2, axGx = W - 2 - axTagW;
            var axLx = xOf(last);
            if (axLx >= plotL && axLx <= axGx) {
                ctx.save();
                ctx.beginPath(); ctx.rect(plotL, ptop, plotW, pbot - ptop); ctx.clip();
                ctx.strokeStyle = PC; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(axLx, axLastY); ctx.lineTo(plotR, axLastY); ctx.stroke();
                ctx.restore();
            }
            ctx.beginPath();
            ctx.moveTo(axGx + 3, axLastY - 9); ctx.lineTo(W - 4, axLastY - 9);
            ctx.arcTo(W - 1, axLastY - 9, W - 1, axLastY, 3); ctx.arcTo(W - 1, axLastY + 9, W - 4, axLastY + 9, 3);
            ctx.lineTo(axGx + 3, axLastY + 9); ctx.arcTo(axGx, axLastY + 9, axGx, axLastY, 3); ctx.arcTo(axGx, axLastY - 9, axGx + 3, axLastY - 9, 3);
            ctx.closePath(); ctx.fillStyle = PC; ctx.fill();
            ctx.fillStyle = BG; ctx.font = 'bold 10px ' + MONO; ctx.textAlign = 'center';
            ctx.fillText(lastP.toFixed(axTagDec), axGx + axTagW / 2, axLastY + 0.5);
        }
        var tbY = pbot + 3, tbH = Math.max(14, H - pbot - 5), tbM = tbY + tbH / 2;
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        for (var axTm = firstT; axTm <= right; axTm += tstep) {
            if (axTm < 0 || axTm > sEnd) continue;
            var axTx = xOf(axTm);
            if (axTx < plotL + 28 || axTx > plotR - 28) continue;
            var axSec = (((Math.floor(axTm) + off) % 86400) + 86400) % 86400;
            var axMajor = (axSec % 3600 === 0);
            ctx.strokeStyle = axLine; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(Math.round(axTx) + 0.5, pbot + 0.5); ctx.lineTo(Math.round(axTx) + 0.5, pbot + (axMajor ? 6 : 4)); ctx.stroke();
            if (last >= 0 && Math.abs(axTx - xOf(last)) < 60) continue;
            ctx.font = (axMajor ? 'bold ' : '') + '10px ' + MONO;
            ctx.fillStyle = PC;
            ctx.fillText(tcFmt(axTm, tstep < 60), axTx, tbM + 0.5);
        }
        if (last >= 0) {
            var axNx = xOf(last);
            if (axNx >= plotL && axNx <= plotR) {
                var axNt = tcFmt(last, true);
                ctx.font = 'bold 10px ' + MONO;
                var axNw = ctx.measureText(axNt).width + 12;
                var axNl = Math.max(plotL + 3, Math.min(plotR - 4 - axNw, axNx - axNw / 2));
                ctx.fillStyle = PC; rrPath(ctx, axNl, tbY + 1, axNw, tbH - 2, 7); ctx.fill();
                ctx.fillStyle = BG; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(axNt, axNl + axNw / 2, tbM + 0.5);
            }
        }
        ctx.restore();

        /* ================= HEADER BAND ================= */
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
        var pillW = clamp(Math.round(plotW * 0.46), 300, 520);
        var pillH = 36, pillX = plotR - pillW - 4, pillY = 8;
        if (pillX < plotL + 150) { pillW = Math.max(240, plotW - 8); pillX = plotL + 4; }
        var sgOk = false, sgSlot = document.getElementById('tcSigSlot');
        if (sgSlot && TC.cv) {
            var sgA = sgSlot.getBoundingClientRect(), sgB = TC.cv.getBoundingClientRect();
            if (sgA.width > 60 && sgA.height > 10) { pillW = Math.round(sgA.width); pillH = Math.round(sgA.height); pillX = Math.round(sgA.left - sgB.left); pillY = Math.round(sgA.top - sgB.top); sgOk = true; }
        }
        if (sgSlot) sgSlot.style.setProperty('display', 'none', 'important');
        sgOk = false; pillW = 0; pillH = 0; pillX = plotR - 4;
        var txtMax = sgOk ? Math.max(60, plotW - 12) : Math.max(60, pillX - plotL - 12);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, plotL + txtMax, ptop); ctx.clip();
        ctx.font = 'bold 11px ' + MONO;
        var line1 = pname + (lastP !== null ? '  ' + lastP.toFixed(axTagDec) : '') + '  |  ' + tcFmt(nowIdx, true) + ' IST  |  ' + (live ? 'LIVE' : 'SESSION CLOSED');
        ctx.fillStyle = PC;
        var line2 = '', l2col = PC;
        if (!sig) {
            line2 = 'NO SIGNAL PASSES THE FILTERS'; l2col = PC;
        } else if (live && plan) {
            if (plan.kind === 'FIRED') line2 = '\u25CF HIT  REV C' + sig.c + ' R' + sig.r + ' X' + sig.s1 + '-X' + sig.s2 + ' ' + sig.pct + '%  result in ' + tcFmtIn(plan.idx + sig.c - nowSec);
            else if (plan.kind === 'FUT') line2 = (plan.need === 1 ? '\u25B6 READY ' : 'NEXT ') + 'REV C' + sig.c + ' R' + sig.r + ' X' + sig.s1 + '-X' + sig.s2 + ' ' + sig.pct + '%  @' + tcFmt(plan.idx, true) + '  in ' + tcFmtIn(plan.idx - nowSec);
            else line2 = plan.missed ? 'MISSED  streak already past X' + sig.s1 : 'NO UPCOMING TRIGGER';
        }
        ctx.fillStyle = l2col;
        var tally = { w: 0, l: 0, p: 0 };
        if (plan) {
            for (n = 0; n < plan.hist.length; n++) {
                var tw0 = tcWin(plan.hist[n].res);
                if (tw0 === 'win') tally.w++; else if (tw0 === 'loss') tally.l++; else if (tw0 === 'pending') tally.p++;
            }
        }
        var td = tally.w + tally.l, tx3 = plotL;
        ctx.font = 'bold 11px ' + MONO;
        var seg = function (text, color) { ctx.fillStyle = color; tx3 += ctx.measureText(text).width; };
        seg('REV  ', PC); seg('\u2713' + tally.w + '  ', PC); seg('\u2717' + tally.l + '  ', PC); seg('\u25CB' + tally.p + '  ', PC);
        seg(td ? Math.round(tally.w / td * 100) + '% WIN' : '-- % WIN', PC);
        ctx.restore();

        /* ---- signal pill (pair | timer | C | R | X | C1 | C2 | %) ---- */
        var pillKind = !sig ? 'NONE' : (plan ? plan.kind : 'NONE');
        var pFill = sig ? (expUp ? TICKG : CROSSR) : PC;
        var sgDk = document.getElementById('tcDock');
        if (!sgDk) { sgDk = null; }
        var pTimer = '--', pProg = -1;
        if (sig && plan && live) {
            if (plan.kind === 'FIRED') {
                var rf = (plan.idx + sig.c - nowSec) - ((now % 1000) / 1000);
                pTimer = '\u25CF ' + (rf > 0 ? rf.toFixed(1) + 's' : 'RESULT');
                pProg = clamp(1 - Math.max(0, rf) / sig.c, 0, 1); TC.pulseOn = true;
            } else if (plan.kind === 'FUT') {
                var rn = (plan.idx - nowSec) - ((now % 1000) / 1000);
                pTimer = rn > 0 ? (rn >= 100 ? tcFmtIn(Math.ceil(rn)) : rn.toFixed(1) + 's') : 'NOW';
                if (rn > 0) TC.pulseOn = true;
            } else pTimer = plan.missed ? 'MISSED' : 'NO TRIGGER';
        } else if (sig && !live) pTimer = 'CLOSED';
        var cells = sig ? [pname, 'C' + sig.c, 'R' + sig.r, 'X' + sig.s1 + '-X' + sig.s2, String(sig.c1), String(sig.c2), sig.pct + '%'] : ['NO SIGNAL', '', '', '', '', '', ''];
        var wts = [2, 1, 1, 1, 1, 1, 1], wsum = 0;
        for (k = 0; k < wts.length; k++) wsum += wts[k];
        var cw = [], cwFit = [];
        for (k = 0; k < wts.length; k++) { cw.push(pillW * wts[k] / wsum); cwFit.push(cw[k] - 10); }
        ctx.save();
        if (sgOk) {
            var sgR = 32, sgDy = Math.min(0, pillH - sgR), sgDx = Math.sqrt(sgR * sgR - sgDy * sgDy);
            ctx.beginPath();
            ctx.moveTo(pillX, pillY + pillH);
            ctx.lineTo(pillX + sgR - sgDx, pillY + sgR + sgDy);
            ctx.arc(pillX + sgR, pillY + sgR, sgR, Math.atan2(sgDy, -sgDx), -Math.PI / 2);
            ctx.arc(pillX + pillW - sgR, pillY + sgR, sgR, -Math.PI / 2, Math.atan2(sgDy, sgDx));
            ctx.lineTo(pillX + pillW, pillY + pillH);
            ctx.closePath();
            ctx.clip();
        } else {
            rrPath(ctx, pillX, pillY, pillW, pillH, pillH / 2); ctx.clip();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = pFill; ctx.fillRect(pillX, pillY, pillW, pillH);
        ctx.globalAlpha = 1;
        var pfs = fitFont(ctx, cells, cwFit, 12, 8);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = BG;
        var pcx = pillX;
        ctx.strokeStyle = BG; ctx.lineWidth = 1.2;
        for (k = 0; k < cells.length; k++) {
            ctx.font = 'bold ' + pfs + 'px ' + MONO;
            if (k === 0) { ctx.textAlign = 'left'; ctx.fillText(cells[k], pcx + 8, pillY + pillH / 2 + 1); ctx.textAlign = 'center'; } else ctx.fillText(cells[k], pcx + cw[k] / 2, pillY + pillH / 2 + 1);
            pcx += cw[k];
            if (k < cells.length - 1) { ctx.beginPath(); ctx.moveTo(Math.round(pcx) + 0.5, pillY); ctx.lineTo(Math.round(pcx) + 0.5, pillY + pillH); ctx.stroke(); }
        }
        if (false && pProg >= 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.65)';
            ctx.fillRect(pillX, pillY + pillH - 3, pillW * pProg, 3);
        }
        ctx.restore();
        if (sig) {
            TC.hits.push({ x: pillX, y: pillY, w: pillW, h: pillH, sig: sig });
            if (plan && (plan.kind === 'FUT' || plan.kind === 'FIRED' || plan.missed)) TC.hov.push({ x: pillX, y: pillY, w: pillW, h: pillH, o: { sig: sig, idx: plan.idx, kind: plan.kind, need: plan.need, ref: plan.ref, dec: TC.dec, missed: plan.missed } });
        }

        /* ---- right side bar: every top signal ---- */
        var sbBar = document.getElementById('tcSideBar');
        if (!sbBar) {
            sbBar = document.createElement('div');
            sbBar.id = 'tcSideBar';
            sbBar.style.cssText = 'position:fixed; left:0; bottom:140px; width:600px; z-index:60; display:flex; flex-direction:column; background:#000432; border:1px solid #E2E8F0; font-family:' + MONO + '; overflow:hidden;';
            sbBar.addEventListener('click', function (ev) {
                var el = ev.target;
                while (el && el !== sbBar && !(el.getAttribute && (el.getAttribute('data-k') || el.getAttribute('data-t')))) el = el.parentNode;
                if (!el || el === sbBar) return;
                if (el.getAttribute('data-t')) {
                    TC.sbOpen = (TC.sbOpen === false);
                    TC.sbHtml = '';
                    try { tcRequest(); } catch (eT0) {}
                    return;
                }
                var kk = el.getAttribute('data-k'), lst2 = [], q, s2;
                try { lst2 = _buildTop10(tcSigList()); } catch (eK) { lst2 = []; }
                for (q = 0; q < lst2.length; q++) {
                    if (tcSigKey(lst2[q]) === kk) {
                        s2 = lst2[q];
                        TC.sig = s2; TC.scanAt = (S && S.scan) ? S.scan.at : null;
                        try { manualSelectSignal(S.symbol, s2.c, s2.r, s2.s1, s2.s2, s2.col, 'REV'); } catch (eM0) {}
                        TC.sbHtml = '';
                        try { tcRequest(); } catch (eT1) {}
                        break;
                    }
                }
            });
            document.body.appendChild(sbBar);
        }
        if (now - (TC.sbT || 0) > 250) {
            TC.sbT = now;
            var sbL = [], sbH = '', sbN, sbS, sbP, sbT, sbF, sbUp, sbCol, sbRows = '', sbGrid = '', sbC, sbK, sbCe, sbWt = [28, 11, 11, 18, 9, 9, 14];
            var sbSel = sig ? tcSigKey(sig) : '';
            var sbOpen = (TC.sbOpen !== false);
            try { sbL = _buildTop10(tcSigList()); } catch (eSb) { sbL = []; }
            for (sbN = 0; sbN < sbL.length; sbN++) {
                sbS = sbL[sbN];
                sbP = tcPlan(sbS, prices, fin, sEnd, fin);
                sbT = '--';
                if (live) {
                    if (sbP.kind === 'FIRED') {
                        sbF = (sbP.idx + sbS.c - nowSec) - ((now % 1000) / 1000);
                        sbT = '\u25CF ' + (sbF > 0 ? (sbF >= 100 ? tcFmtIn(Math.ceil(sbF)) : sbF.toFixed(1) + 's') : 'RESULT');
                    } else if (sbP.kind === 'FUT') {
                        sbF = (sbP.idx - nowSec) - ((now % 1000) / 1000);
                        sbT = sbF > 0 ? (sbF >= 100 ? tcFmtIn(Math.ceil(sbF)) : sbF.toFixed(1) + 's') : 'NOW';
                    } else sbT = sbP.missed ? 'MISSED' : 'NO TRIGGER';
                } else sbT = 'CLOSED';
                sbUp = (sbS.col === 'R');
                sbCol = sbUp ? TICKG : CROSSR;
                sbC = [getPairDisplayName(sbS.pair), 'C' + sbS.c, 'R' + sbS.r, 'X' + sbS.s1 + '-X' + sbS.s2, String(sbS.c1), String(sbS.c2), sbS.pct + '%'];
                sbCe = '';
                for (sbK = 0; sbK < sbC.length; sbK++) {
                    sbCe += '<span style="flex:0 0 ' + sbWt[sbK] + '%; box-sizing:border-box; min-width:0; overflow:hidden; padding:' + (sbK === 0 ? '6px 3px 6px 6px' : '6px 2px') + '; text-align:' + (sbK === 0 ? 'left' : 'center') + ';' + (sbK < sbC.length - 1 ? ' border-right:1px solid #000432;' : '') + '">' + sbC[sbK] + '</span>';
                }
                sbGrid += '<div data-k="' + tcSigKey(sbS) + '" style="cursor:pointer; min-width:0; overflow:hidden; display:flex; align-items:center; white-space:nowrap; padding:2px 3px; font-size:11px; font-weight:700; line-height:1.2;">'
                    + '<div style="flex:0 0 76%; min-width:0; display:flex; align-items:stretch; border-radius:4px; overflow:hidden; background:' + sbCol + '; color:#000432;' + (tcSigKey(sbS) === sbSel ? ' box-shadow:inset 0 0 0 2px #FFFFFF;' : '') + '">' + sbCe + '</div>'
                    + '<span style="flex:1; text-align:right; padding-left:4px; color:#E2E8F0; font-size:10px; font-weight:800;">' + sbT + '</span></div>';
            }
            if (!sbRows) sbRows = '<div style="padding:8px 6px; color:#8890b8; font-size:10px; font-weight:800; text-align:center;">NO SIGNALS</div>';
            else sbRows = '<div style="display:flex; align-items:center; white-space:nowrap; padding:3px 6px; border-left:4px solid transparent; border-bottom:1px solid #1c2260; color:#8890b8; font-size:9px; font-weight:800; letter-spacing:0.5px;">'
                + '<span style="display:inline-block; width:24px;">#</span>'
                + '<span style="display:inline-block; width:14px;"></span>'
                + '<span style="display:inline-block; width:38px;">C</span>'
                + '<span style="display:inline-block; width:34px;">R</span>'
                + '<span style="display:inline-block; width:56px;">X</span>'
                + '<span style="display:inline-block; width:42px;">%</span>'
                + '<span style="display:inline-block; width:40px;">C1/C2</span>'
                + '<span style="flex:1; text-align:right;">TIME</span></div>' + sbRows;
            sbH = '<div data-t="1" style="padding:5px 6px; background:#E2E8F0; color:#000432; font-size:10px; font-weight:800; cursor:pointer; text-align:center; letter-spacing:1px; flex-shrink:0;">TOP SIGNALS (' + sbL.length + ')  \u00B7  NEXT SCAN ' + (function () { var sc0 = S && S.scan, t0; if (!sc0) return '--'; t0 = Math.max(0, ((S.cfg && S.cfg.interval) || 300) - ((S.now || Math.floor(Date.now() / 1000)) - sc0.at)); return t0 > 0 ? t0 + 's' : 'SCANNING'; })() + ' ' + (sbOpen ? '\u25BE' : '\u25B8') + '</div>'
                + (sbOpen ? (sbGrid ? '<div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-rows:repeat(5,auto); grid-auto-flow:column;">' + sbGrid + '</div>' : sbRows) : '');
            if (TC.sbHtml !== sbH) {
                TC.sbHtml = sbH;
                var sbBody = sbBar.children[1], sbSc = sbBody ? sbBody.scrollTop : 0;
                sbBar.innerHTML = sbH;
                if (sbBar.children[1]) sbBar.children[1].scrollTop = sbSc;
            }
            var sbDk = document.getElementById('tcDock'), sbDr = sbDk ? sbDk.getBoundingClientRect() : null;
            sbBar.style.top = 'auto';
            if (sbDr && sbDr.width > 100) {
                sbBar.style.left = Math.round(sbDr.left) + 'px';
                sbBar.style.width = Math.round(sbDr.width) + 'px';
                sbBar.style.bottom = Math.round(window.innerHeight - sbDr.top + 4) + 'px';
            } else {
                sbBar.style.left = '0px';
                sbBar.style.bottom = '140px';
            }
        }
        sbBar.style.display = 'none';
        var tspEl = document.getElementById('tcSigSlot');
        if (tspEl) {
            var tspC = sig ? [pname, pTimer, 'C' + sig.c, 'R' + sig.r, 'X' + sig.s1 + '-X' + sig.s2, String(sig.c1), String(sig.c2), sig.pct + '%'] : ['NO SIGNAL'];
            var tspG = [2, 1.4, 1, 1, 1.4, 1, 1, 1];
            var tspH = '<div style="display:flex;width:100%;height:100%;gap:1px;background:#000432;">', tspI;
            for (tspI = 0; tspI < tspC.length; tspI++) {
                tspH += '<div style="flex:' + (sig ? tspG[tspI] : 1) + ' 1 auto;min-width:0;overflow:hidden;display:flex;align-items:center;justify-content:center;white-space:nowrap;padding:0 ' + (tspI === tspC.length - 1 ? '14px' : '4px') + ' 0 ' + (tspI === 0 ? '14px' : '4px') + ';box-sizing:border-box;background:' + pFill + ';color:#000432;-webkit-text-fill-color:#000432;font:800 12px JetBrains Mono,monospace;line-height:1;">' + tspC[tspI] + '</div>';
            }
            tspH += '</div>';
            if (tspEl._h !== tspH) { tspEl._h = tspH; tspEl.innerHTML = tspH; }
            tspEl.style.setProperty('display', 'none', 'important');
            tspEl.style.pointerEvents = 'auto';
        }

        /* ---- stacked rows: the rest of the top ten under the selected signal ---- */
        var stkL = [], stkO = [], stkN, stkK, stkS, stkP, stkT, stkF, stkC, stkW, stkX, stkFs, stkFill;
        var stkRw = 20, stkY = pillY + pillH + 3, stkSum = 0;
        var stkWts = [1.5, 0.8, 0.8, 1.2, 0.8, 0.8, 0.9, 1.2];
        var stkSelKey = sig ? tcSigKey(sig) : '';
        try { stkL = (typeof lvlsOn !== 'undefined' && lvlsOn) ? tcSigList() : _buildTop10(tcSigList()); } catch (eStk) { stkL = []; }
        for (stkN = 0; stkN < stkL.length; stkN++) { if (tcSigKey(stkL[stkN]) !== stkSelKey) stkO.push(stkL[stkN]); }
        for (stkK = 0; stkK < stkWts.length; stkK++) stkSum += stkWts[stkK];
        var stkCnt = 0;
        stkY = pillY - 1 - stkCnt * (stkRw + 2);
        for (stkN = 0; stkN < stkCnt; stkN++) {
            stkS = stkO[stkN];
            stkP = tcPlan(stkS, prices, fin, sEnd, fin);
            stkT = '--';
            if (live) {
                if (stkP.kind === 'FIRED') {
                    stkF = (stkP.idx + stkS.c - nowSec) - ((now % 1000) / 1000);
                    stkT = '\u25CF ' + (stkF > 0 ? (stkF >= 100 ? tcFmtIn(Math.ceil(stkF)) : stkF.toFixed(1) + 's') : 'RESULT');
                    if (stkF > 0) TC.pulseOn = true;
                } else if (stkP.kind === 'FUT') {
                    stkF = (stkP.idx - nowSec) - ((now % 1000) / 1000);
                    stkT = stkF > 0 ? (stkF >= 100 ? tcFmtIn(Math.ceil(stkF)) : stkF.toFixed(1) + 's') : 'NOW';
                    if (stkF > 0) TC.pulseOn = true;
                } else stkT = stkP.missed ? 'MISSED' : 'NO TRIGGER';
            } else stkT = 'CLOSED';
            stkC = [(stkS.col === 'R' ? '\u25B2 ' : '\u25BC ') + pname, 'C' + stkS.c, 'R' + stkS.r, 'X' + stkS.s1 + '-X' + stkS.s2, String(stkS.c1), String(stkS.c2), stkS.pct + '%', stkT];
            stkW = [];
            for (stkK = 0; stkK < stkWts.length; stkK++) stkW.push(pillW * stkWts[stkK] / stkSum);
            stkFill = (stkS.col === 'R') ? TICKG : CROSSR;
            ctx.save();
            rrPath(ctx, pillX, stkY, pillW, stkRw, 6); ctx.clip();
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = stkFill; ctx.fillRect(pillX, stkY, pillW, stkRw);
            ctx.globalAlpha = 1;
            stkFs = fitFont(ctx, stkC, stkW.map(function (w0) { return w0 - 8; }), 11, 7);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = BG;
            ctx.strokeStyle = BG; ctx.lineWidth = 1;
            stkX = pillX;
            for (stkK = 0; stkK < stkC.length; stkK++) {
                ctx.font = 'bold ' + stkFs + 'px ' + MONO;
                ctx.fillText(stkC[stkK], stkX + stkW[stkK] / 2, stkY + stkRw / 2 + 1);
                stkX += stkW[stkK];
                if (stkK < stkC.length - 1) { ctx.beginPath(); ctx.moveTo(Math.round(stkX) + 0.5, stkY); ctx.lineTo(Math.round(stkX) + 0.5, stkY + stkRw); ctx.stroke(); }
            }
            ctx.restore();
            TC.hits.push({ x: pillX, y: stkY, w: pillW, h: stkRw, sig: stkS });
            stkY += stkRw + 2;
        }
        var tskEl = document.getElementById('tcStack'), tskDk = document.getElementById('tcDock');
        if (!tskEl && tskDk) {
            tskEl = document.createElement('div');
            tskEl.id = 'tcStack';
            tskEl.style.cssText = 'order:0; display:flex; flex-direction:row; gap:1px; background:#000432; margin-bottom:1px;';
            tskDk.insertBefore(tskEl, tskDk.firstChild);
        }
        if (tskEl && tskDk) {
            var tskBase = tskDk.offsetHeight - tskEl.offsetHeight;
            var tskMax = Math.max(0, Math.min(20, Math.floor((TC.H - (PADB + 12) - tskBase - 76) / 21)));
            var tskH = '', tskN, tskS, tskP, tskT, tskF, tskC, tskI, tskFill, tskG = [2, 1.4, 1, 1, 1.4, 1, 1, 1], tskMom = [], tskRows, tskIsM;
            try { tskMom = ((typeof lvlsOn !== 'undefined' && lvlsOn && typeof _lvlBuild === 'function') ? _lvlBuild : _buildTop10)(((S && S.scan && S.scan.mom) ? S.scan.mom : []).map(function (x) { return Object.assign({ pair: S.symbol, type: 'MOM' }, x); })); } catch (eMo) { tskMom = []; }
            var tskMc = (S && S.bot && S.bot.momSig) ? S.bot.momSig : null, tskMk = tskMc ? tcSigKey(tskMc) : '';
            if (tskMc) {
                tskMom = tskMom.map(function (x) { return (x.c === tskMc.c && x.s1 === tskMc.s1 && x.col === tskMc.col && (x.rs || [x.r]).indexOf(tskMc.r) >= 0) ? Object.assign({}, x, { lock: 1, r: tskMc.r }) : x; });
            }
            var tskRv = stkL.slice(), tskCk = (S && S.bot && S.bot.champion) ? S.bot.champion : '', tskCi = -1, tskCj;
            var tskCp = tskCk.split('|'), tskCr = +tskCp[2], tskRs;
            for (tskCj = 0; tskCj < tskRv.length; tskCj++) {
                tskRs = tskRv[tskCj].rs || [tskRv[tskCj].r];
                if (tskCp.length === 6 && +tskCp[1] === tskRv[tskCj].c && +tskCp[3] === tskRv[tskCj].s1 && tskCp[4] === tskRv[tskCj].col && tskRs.indexOf(tskCr) >= 0) { tskCi = tskCj; break; }
            }
            if (tskCi >= 0) tskRv[tskCi] = Object.assign({}, tskRv[tskCi], { lock: 1, r: tskCr });
            var tskR1 = (tskCi >= 0) ? [tskRv[tskCi]] : _top1(tskRv), tskM1 = [], tskMi;
            for (tskMi = 0; tskMi < tskMom.length; tskMi++) { if (tskMom[tskMi].lock) { tskM1 = [tskMom[tskMi]]; break; } }
            if (!tskM1.length) tskM1 = _top1(tskMom);
            tskRows = tskR1.slice(0, Math.min(1, tskMax));
            var tskHR = '', tskHM = '', tskRw, tskNear = 1e9, tskNearFill = '';
            for (tskN = 0; tskN < tskRows.length; tskN++) {
                tskS = tskRows[tskN];
                tskIsM = (tskS.type === 'MOM');
                tskP = tcPlan(tskS, prices, fin, sEnd, fin);
                tskT = '--';
                if (live) {
                    if (tskP.kind === 'FIRED') {
                        tskF = (tskP.idx + tskS.c - nowSec) - ((now % 1000) / 1000);
                        tskT = '\u25CF ' + (tskF > 0 ? (tskF >= 100 ? tcFmtIn(Math.ceil(tskF)) : tskF.toFixed(1) + 's') : 'RESULT');
                        if (tskF > 0) TC.pulseOn = true;
                    } else if (tskP.kind === 'FUT') {
                        tskF = (tskP.idx - nowSec) - ((now % 1000) / 1000);
                        tskT = tskF > 0 ? (tskF >= 100 ? tcFmtIn(Math.ceil(tskF)) : tskF.toFixed(1) + 's') : 'NOW';
                        if (tskF > 0) TC.pulseOn = true;
                    } else tskT = tskP.missed ? 'MISSED' : 'NO TRIGGER';
                } else tskT = 'CLOSED';
                tskC = [getPairDisplayName(tskS.pair), tskT, 'C' + tskS.c, 'R' + tskS.r, 'X' + tskS.s1 + '-X' + tskS.s2, String(tskS.c1), String(tskS.c2), tskS.pct + '%'];
                tskFill = ((tskS.col === 'R') !== tskIsM) ? TICKG : CROSSR;
                if (live && tskP.kind === 'FUT') {
                    tskF = (tskP.idx - nowSec) - ((now % 1000) / 1000);
                    if (tskF > -1 && tskF < tskNear) { tskNear = tskF; tskNearFill = tskFill; }
                }
                tskRw = '<div style="display:flex;width:100%;height:20px;gap:1px;background:#000432;' + (tskS.lock ? 'outline:2px solid #FFFFFF;outline-offset:-2px;' : '') + '">';
                for (tskI = 0; tskI < tskC.length; tskI++) {
                    tskRw += '<div style="flex:' + tskG[tskI] + ' 1 auto;min-width:0;overflow:hidden;display:flex;align-items:center;justify-content:center;white-space:nowrap;padding:0 ' + (tskI === tskC.length - 1 ? '5px' : '1px') + ' 0 ' + (tskI === 0 ? '5px' : '1px') + ';box-sizing:border-box;background:' + tskFill + ';color:#000432;-webkit-text-fill-color:#000432;font:800 9px JetBrains Mono,monospace;line-height:1;">' + tskC[tskI] + '</div>';
                }
                tskRw += '</div>';
                if (tskIsM) tskHM += tskRw; else tskHR += tskRw;
            }
            tskH = '';
            if (tskMax > 0) {
                [['REV', tskHR]].forEach(function (tk) {
                    tskH += '<div style="flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:1px;background:#000432;"><div style="height:14px;display:flex;align-items:center;justify-content:center;background:#E2E8F0;color:#000432;-webkit-text-fill-color:#000432;font:800 9px JetBrains Mono,monospace;letter-spacing:2px;line-height:1;">' + tk[0] + '</div>' + (tk[1] || '<div style="height:20px;display:flex;align-items:center;justify-content:center;background:#000432;color:#8890b8;font:800 9px JetBrains Mono,monospace;line-height:1;">NO SIGNALS</div>') + '</div>';
                });
            }
            if (tskEl._h !== tskH) { tskEl._h = tskH; tskEl.innerHTML = tskH; }
            tskEl.style.display = tskH ? 'flex' : 'none';
            var tskCol = tskNearFill || pFill;
            if (tskDk.getAttribute('data-sc') !== tskCol) { tskDk.setAttribute('data-sc', tskCol); tskDk.style.setProperty('--tc-sig', tskCol); }
        }
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;

        /* ---- banner: HIT / WIN / LOSS ---- */
        var bn = TC.banner;
        if (bn) {
            var bAge = now - bn.t0;
            if (bAge >= bn.dur) { TC.banner = null; }
            else {
                TC.pulseOn = true;
                var bCol = PC;
                var bTxt = (bn.kind === 'win' ? '\u2713 WIN' : (bn.kind === 'loss' ? '\u2717 LOSS' : '\u25CF HIT')) + '   REV C' + bn.sig.c + ' R' + bn.sig.r + ' X' + bn.sig.s1 + '\u2192X' + bn.sig.s2 + '   ' + tcFmt(bn.idx, true);
                ctx.save();
                ctx.font = 'bold 13px ' + MONO;
                var bW = ctx.measureText(bTxt).width + 34, bH = 28;
                var bX = plotL + (plotW - bW) / 2, bY = ptop + 10;
                ctx.globalAlpha = bAge > bn.dur - 1000 ? Math.max(0, (bn.dur - bAge) / 1000) : 1;
                ctx.fillStyle = bCol; rrPath(ctx, bX, bY, bW, bH, bH / 2); ctx.fill();
                ctx.fillStyle = BG; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(bTxt, bX + bW / 2, bY + bH / 2 + 1);
                ctx.restore();
            }
        }

        /* ---- capsule border (same as the grid footer) ---- */
        try { if (typeof window._capBorder === 'function') window._capBorder(ctx, W, Math.round(pbot), PC); } catch (e1) {}
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        if (TC.mx >= 0) tcHoverAt(TC.mx, TC.my);
    }

    function tcDraw() {
        if (!TC.on || !TC.wrap || !TC.cv || !S) return;
        var W = TC.wrap.clientWidth, H = TC.wrap.clientHeight;
        if (W < 80 || H < 80) return;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (TC.W !== W || TC.H !== H || TC.dpr !== dpr) {
            TC.W = W; TC.H = H; TC.dpr = dpr;
            TC.cv.width = Math.round(W * dpr);
            TC.cv.height = Math.round(H * dpr);
            TC.cv.style.width = W + 'px';
            TC.cv.style.height = H + 'px';
        }
        tcDrawAll();
    }
    function tcRequest() {
        if (TC.raf || !TC.on) return;
        TC.raf = requestAnimationFrame(function () { TC.raf = 0; tcDraw(); });
    }

    /* ------------------------------------------------------------------ buttons / state sync */
    function tcSyncLiveBtn() {
        var b = $('tcLiveBtn');
        if (b) b.classList.toggle('tcOn', !!TC.follow);
    }
    function tcSyncAuto() {
        var b = $('tcAutoBtn');
        if (b) b.classList.toggle('tcOn', (TC.yZ || 1) !== 1 || (TC.yOff || 0) !== 0);
    }
    function tcZoom(dir) {
        var plotW = TC.W - PADL - PADR, ci = 0, bd = Infinity, kk;
        for (kk = 0; kk < ZOOMS.length; kk++) {
            var d = Math.abs(ZOOMS[kk] - TC.spp);
            if (d < bd) { bd = d; ci = kk; }
        }
        var ni = Math.max(0, Math.min(ZOOMS.length - 1, ci + dir));
        var centerIdx = TC.left + plotW * TC.spp / 2;
        TC.spp = ZOOMS[ni];
        if (!TC.follow) TC.left = centerIdx - plotW * TC.spp / 2;
        tcDraw();
    }
    function tcApplySpp(newSpp, ax) {
        var plotW = TC.W - PADL - PADR;
        newSpp = clamp(newSpp, 0.1, 600);
        if (!TC.follow) {
            var idxAt = TC.left + (ax - PADL) * TC.spp;
            TC.spp = newSpp;
            TC.left = idxAt - (ax - PADL) * newSpp;
            tcClamp(plotW);
        } else {
            TC.spp = newSpp;
        }
        tcRequest();
    }

    /* ------------------------------------------------------------------ DOM + input */
    function tcBuild() {
        if (TC.wrap) return;
        var vp = $('canvas-viewport');
        if (!vp) return;
        if (!$('tcStyle')) {
            var sty = document.createElement('style');
            sty.id = 'tcStyle';
            var FPX = '#floatTradePill#floatTradePill#floatTradePill#floatTradePill#floatTradePill#floatTradePill#floatTradePill#floatTradePill';
            sty.textContent =
                '#tcWrap{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;}' +
                '#tcWrap #tcBar{border-radius:12px;overflow:hidden;background:#000432;gap:1px !important;padding:1px;}' +
                '#tcWrap #tcBar > button{border:none !important;border-radius:0 !important;flex:1 1 auto !important;}' +
                '#tcDock.tcMerged #tcBar{border-radius:0 0 12px 12px;}' +
                '#tcDock.tcMerged #floatTradePill{position:static !important;transform:none !important;left:auto !important;right:auto !important;top:auto !important;bottom:auto !important;margin:0 !important;width:auto !important;max-width:none !important;box-sizing:border-box !important;border-radius:0 !important;border-bottom:none !important;}' +
                '#tcDock{pointer-events:none;}' +
                '#tcDock > *{pointer-events:auto;}' +
                '#tcDock > #tcSigSlot{pointer-events:none;height:34px;flex:0 0 34px;margin-bottom:1.5px;min-width:0;}' +
                '#tcDock.tcMerged{border-radius:14px;overflow:hidden;}' +
                '#tcDock > #tcParamBar{pointer-events:auto;display:flex;flex-wrap:wrap;gap:1px;width:0;min-width:100%;box-sizing:border-box;background:#000432;border-radius:14px 14px 0 0;overflow:hidden;margin-bottom:1.5px;}' +
                '#tcParamBar > div{flex:1 1 auto;display:flex;align-items:center;justify-content:center;gap:4px;height:22px;padding:0 8px;box-sizing:border-box;background:var(--pair-color,#E2E8F0);color:#000432;-webkit-text-fill-color:#000432;font-family:JetBrains Mono,monospace;font-size:11px;font-weight:800;line-height:1;white-space:nowrap;}' +
                '#tcParamBar .pmL{opacity:0.65;}' +
                '#tcParamBar > #tcPmSet{flex:0 0 38px;padding:0;}' +
                '#tcParamBar > div.pmE{cursor:pointer;box-shadow:inset 0 0 0 1px #000432;}' +
                '#tcParamBar > #tcPmGo{flex:2 1 auto;cursor:pointer;background:#000432;color:var(--pair-color,#E2E8F0);-webkit-text-fill-color:var(--pair-color,#E2E8F0);}' +
                '#tcParamBar > #tcPmX{flex:0 0 34px;padding:0;cursor:pointer;background:#000432;color:#fff;-webkit-text-fill-color:#fff;}' +
                '#tcParamBar > #tcPmSet{cursor:pointer;background:#000432;color:var(--pair-color,#E2E8F0);-webkit-text-fill-color:var(--pair-color,#E2E8F0);}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock{align-items:stretch !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar{align-self:stretch !important;width:auto !important;min-width:0 !important;max-width:none !important;margin:0 !important;left:auto !important;right:auto !important;transform:none !important;box-sizing:border-box !important;border-radius:0 !important;display:grid !important;grid-template-columns:repeat(4,minmax(0,1fr)) !important;grid-template-rows:repeat(2,26px) !important;gap:1.5px !important;padding:0 !important;background:#000432 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar > *{height:auto !important;min-height:0 !important;max-height:none !important;margin:0 !important;font-size:12px !important;font-weight:800 !important;line-height:1 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar > button{flex:1 1 0 !important;min-width:0 !important;border-radius:0 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcSigSlot#tcSigSlot{align-self:stretch !important;width:auto !important;margin:0 0 1.5px 0 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #floatTradePill#floatTradePill{display:none !important;align-self:stretch !important;width:auto !important;margin:0 !important;}' +
                'html body #tcDock#tcDock.tcMerged ' + FPX + ', html body #tcDock#tcDock.tcMerged ' + FPX + ' > *{border-radius:0 !important;}' +
                '#tcWrap #tcBar > button.tcOn{background:var(--pair-color,#FFD700) !important;color:#000432 !important;-webkit-text-fill-color:#000432 !important;}' +
                '#tcWrap #tcBar > #logBtn{order:5;height:auto !important;min-height:0 !important;max-height:none !important;min-width:0 !important;padding:0 !important;margin:0 !important;display:inline-flex !important;align-items:center;justify-content:center;font-size:12px !important;font-weight:800 !important;}' +
                '#tcWrap #tcBar > #tradeHistBtn{order:7;height:auto !important;min-height:0 !important;max-height:none !important;min-width:0 !important;padding:0 !important;margin:0 !important;display:inline-flex !important;align-items:center;justify-content:center;}' +
                '#tcWrap #tcBar > #accountBalance{order:8;grid-column:span 2 !important;flex:1.6 1 0 !important;width:auto !important;min-width:0 !important;max-width:none !important;height:auto !important;min-height:0 !important;max-height:none !important;margin:0 !important;padding:0 6px !important;box-sizing:border-box !important;border:none !important;border-radius:0 !important;display:flex !important;align-items:center;justify-content:center;background:var(--pair-color,#E2E8F0) !important;background-color:var(--pair-color,#E2E8F0) !important;color:#000432 !important;-webkit-text-fill-color:#000432 !important;font-size:12px !important;font-weight:800;line-height:1 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock{border-radius:32px !important;overflow:hidden !important;box-shadow:0 0 0 1.5px var(--pair-color,#E2E8F0) !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar{border-radius:0 !important;margin:0 !important;gap:1px !important;background:#000432 !important;border-bottom:1px solid #000432 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcSigSlot#tcSigSlot{margin:0 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar{border-top:1px solid #000432 !important;border-radius:0 !important;gap:1px !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar > div{height:28px !important;min-height:28px !important;max-height:28px !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcSigSlot#tcSigSlot{height:28px !important;min-height:28px !important;max-height:28px !important;flex:0 0 28px !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar{grid-template-rows:28px !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar > div, html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar > div *{font-family:JetBrains Mono,monospace !important;font-size:12px !important;font-weight:800 !important;line-height:1 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar > *{font-family:JetBrains Mono,monospace !important;font-size:12px !important;font-weight:800 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar > div, html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar > div.pmE{box-shadow:none !important;border:none !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar#tcParamBar{border-bottom:0 !important;margin:0 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar{border-top:0 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcSigSlot#tcSigSlot{order:1 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar{order:2 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar{order:3 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar#tcParamBar#tcParamBar{border-top:1px solid #000432 !important;box-sizing:border-box !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar{border-top:1px solid #000432 !important;box-sizing:border-box !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar > div.pmE{background:var(--tc-sig,var(--pair-color,#E2E8F0)) !important;background-color:var(--tc-sig,var(--pair-color,#E2E8F0)) !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar > button, html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar > #accountBalance{background:var(--tc-sig,var(--pair-color,#E2E8F0)) !important;background-color:var(--tc-sig,var(--pair-color,#E2E8F0)) !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar#tcBar{grid-template-columns:repeat(8,minmax(0,1fr)) !important;gap:0 !important;column-gap:0 !important;row-gap:0 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar#tcBar > #tcZoomOut#tcZoomOut, html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar#tcBar > #tcZoomIn#tcZoomIn{grid-column:span 1 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar#tcBar > #tcAutoBtn#tcAutoBtn, html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar#tcBar > #tcLiveBtn#tcLiveBtn, html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar#tcBar > #accountBalance#accountBalance{grid-column:span 2 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcBar#tcBar#tcBar#tcBar#tcBar#tcBar > *:not(#tcZoomOut){border-left:1px solid #000432 !important;box-sizing:border-box !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar#tcParamBar#tcParamBar{gap:0 !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar#tcParamBar#tcParamBar:not(:has(> #tcPmGo)) > div:not(#tcPmSet){flex:1 1 0 !important;min-width:0 !important;width:auto !important;padding:0 3px !important;overflow:hidden !important;box-sizing:border-box !important;}' +
                'html body #tcWrap#tcWrap #tcDock#tcDock #tcParamBar#tcParamBar#tcParamBar#tcParamBar:not(:has(> #tcPmGo)) > div:not(:first-child):not(#tcPmSet){border-left:1px solid #000432 !important;}';
            document.head.appendChild(sty);
        }
        var w = document.createElement('div');
        w.id = 'tcWrap';
        w.style.cssText = 'position:absolute; top:0; left:0; right:0; bottom:0; z-index:6; display:none; background:var(--bg-base); touch-action:none; overflow:hidden;';
        var cv = document.createElement('canvas');
        cv.id = 'tcCanvas';
        cv.style.cssText = 'display:block; position:absolute; top:0; left:0; touch-action:none;';
        w.appendChild(cv);
        var bar = document.createElement('div');
        bar.id = 'tcBar';
        bar.style.cssText = 'position:relative; display:flex; gap:1px;';
        bar.innerHTML =
            '<button type="button" id="tcZoomOut" title="Zoom out" style="' + BTN_CSS + '">-</button>' +
            '<button type="button" id="tcZoomIn" title="Zoom in" style="' + BTN_CSS + '">+</button>' +
            '<button type="button" id="tcLiveBtn" title="Follow live" style="' + BTN_CSS + '">LIVE</button>' +
            '<button type="button" id="tcAutoBtn" title="Reset price zoom" style="' + BTN_CSS + ' order:6;">AUTO</button>';
        var dock = document.createElement('div');
        dock.id = 'tcDock';
        dock.style.cssText = 'position:absolute; bottom:' + (PADB + 12) + 'px; left:50%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:stretch; z-index:3; max-width:98%;';
        var sgSlotEl = document.createElement('div');
        sgSlotEl.id = 'tcSigSlot';
        var tcPmEl = document.createElement('div');
        tcPmEl.id = 'tcParamBar';
        var tcPmLast = '', tcPmEditing = null, tcPmSnap = '', tcPmDirty = null, tcPmSig = '';
        function tcPmRender() {
            if (tcPmEditing) {
                var sg0 = '';
                try { sg0 = JSON.stringify([S.symbol, S.cfg, S.len]); } catch (e6) { sg0 = ''; }
                if (!(tcPmDirty && !tcPmDirty() && sg0 !== tcPmSig)) return;
                tcPmEditing = null;
            }
            var st = null, cfg = null, out = [], pk, pv;
            var known = { level: 1, minPct: 1, minC: 1, maxC: 1, interval: 1, intervalRaw: 1, session: 1, canEdit: 1 };
            try { st = (typeof S !== 'undefined') ? S : null; } catch (e0) { st = null; }
            cfg = (st && st.cfg) ? st.cfg : null;
            function pmAdd(l, val) {
                if (val === undefined || val === null || val === '') return;
                out.push('<div><span class="pmV">' + String(val).replace(/[&<>]/g, '') + '</span></div>');
            }
            if (cfg) {
                var pmSym = cfg.symbol || '';
                try { if (!pmSym && typeof activePair !== 'undefined') pmSym = activePair; } catch (e4) {}
                try { if (pmSym && typeof getPairDisplayName === 'function') pmSym = getPairDisplayName(pmSym) || pmSym; } catch (e5) {}
                pmAdd('PAIR', pmSym);
                if (cfg.level !== undefined) pmAdd('LVL', Number(cfg.level) ? 'X' + cfg.level + '-X' + (Number(cfg.level) + 1) : 'ALL');
                pmAdd('MIN%', cfg.minPct !== undefined ? cfg.minPct + '%' : '');
                pmAdd('CYC MIN', cfg.minC !== undefined ? cfg.minC : '');
                pmAdd('CYC MAX', cfg.maxC !== undefined ? cfg.maxC : '');
                pmAdd('SCAN', cfg.interval !== undefined ? cfg.interval + 's' : '');
            }
            if (st && st.len) {
                var lenTxt = '';
                try { lenTxt = (typeof _fmtLenLabel === 'function') ? _fmtLenLabel(Math.round(st.len / 60)) : Math.round(st.len / 60) + 'm'; } catch (e1) { lenTxt = Math.round(st.len / 60) + 'm'; }
                pmAdd('LEN', lenTxt);
            }
            var stakeEl = document.getElementById('tradeAmount'), expEl = document.getElementById('tradeExpiryVisible');
            var stkV = (cfg && cfg.autoStake !== undefined) ? cfg.autoStake : (stakeEl ? stakeEl.value : '');
            if (stkV !== '' && stkV !== undefined && stkV !== null && !isNaN(Number(stkV))) pmAdd('STAKE', '$' + Number(stkV));
            if (out.length) { tcCfgEdit(); return; }
            var pmHtml = out.join('') + (out.length ? '<div id="tcPmSet" title="Edit settings"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></div>' : '');
            if (pmHtml !== tcPmLast) {
                tcPmLast = pmHtml;
                tcPmEl.innerHTML = pmHtml;
                tcPmEl.style.display = pmHtml ? 'flex' : 'none';
            }
        }
        ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'].forEach(function (nm) {
            tcPmEl.addEventListener(nm, function (e) { e.stopPropagation(); }, { passive: true });
        });
        function tcCfgEdit() {
            if (document.getElementById('tcCfgBox')) return;
            var ceSt = null, ceCg = {}, ceKey = '', ceOv = null, ceVal = {}, ceOrig = 0, ceI;
            var CEF = 'font-family:JetBrains Mono,monospace;';
            var cePill = 'min-width:104px;max-width:60%;height:26px;box-sizing:border-box;padding:0 12px;border:none;border-radius:13px !important;background:var(--pair-color,#E2E8F0) !important;color:#000432 !important;-webkit-text-fill-color:#000432 !important;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap;';
            var ceCard = 'width:92vw;max-width:340px;max-height:92vh;overflow-y:auto;box-sizing:border-box;background:#000432 !important;border:1px solid var(--pair-color,#E2E8F0) !important;border-radius:14px !important;padding:12px;color:#fff;' + CEF;
            var ceNF = {
                minPct: { label: 'MIN PROBABILITY (%)', dec: false, min: 0, max: 100 },
                minC: { label: 'CYCLE MIN (SEC)', dec: false, min: 1, max: 3600 },
                maxC: { label: 'CYCLE MAX (SEC)', dec: false, min: 1, max: 3600 },
                interval: { label: 'SCAN INTERVAL (SEC, 0 = AUTO)', dec: false, min: 0, max: 3600 },
                autoStake: { label: 'AUTO STAKE ($)', dec: true, min: 0.01, max: 100000, fix: 2 }
            };
            try { ceSt = (typeof S !== 'undefined') ? S : null; } catch (e0) { ceSt = null; }
            ceCg = (ceSt && ceSt.cfg) ? ceSt.cfg : {};
            ceVal = {
                symbol: String((ceSt && ceSt.symbol) || ''),
                minPct: isNaN(Number(ceCg.minPct)) ? 10 : Number(ceCg.minPct),
                level: Number(ceCg.level) || 0,
                minC: Number(ceCg.minC) || 300,
                maxC: Number(ceCg.maxC) || 300,
                interval: Number(ceCg.intervalRaw !== undefined ? ceCg.intervalRaw : ceCg.interval) || 0,
                session: Number(ceCg.session) || 7200,
                autoStake: Number(ceCg.autoStake) || 1,
                auto: ceCg.auto !== false
            };
            ceOrig = ceVal.session + '|' + ceVal.symbol;
            tcPmSnap = JSON.stringify(ceVal);
            tcPmDirty = function () { return JSON.stringify(ceVal) !== tcPmSnap; };
            try { tcPmSig = JSON.stringify([ceSt && ceSt.symbol, ceSt && ceSt.cfg, ceSt && ceSt.len]); } catch (e7) { tcPmSig = ''; }
            try { ceKey = localStorage.getItem('wsAdminKey') || ''; } catch (e1) { ceKey = ''; }
            function ceLen(sec) {
                var m = Math.round(sec / 60), h = Math.floor(m / 60), r = m % 60;
                if (h && r) return h + 'h ' + r + 'm';
                if (h) return h + 'h';
                return m + 'm';
            }
            function ceName(p) {
                try { if (typeof getPairDisplayName === 'function') return String(getPairDisplayName(p)); } catch (e) {}
                return String(p).replace(/^(frx|cry|1HZ)/i, '');
            }
            function ceCol(p) {
                var c = '', hh = 0, i5;
                try { c = (typeof tcPairColor === 'function') ? tcPairColor(p) : ''; } catch (e) { c = ''; }
                if (!c) {
                    for (i5 = 0; i5 < p.length; i5++) hh = (hh * 31 + p.charCodeAt(i5)) % 360;
                    c = 'hsl(' + hh + ',80%,62%)';
                }
                return c;
            }
            function cePairPick() {
                var ov = ceOverlay(5200), grp = 'ALL', q = '', gEl = null, tEl = null;
                var PL = ['frxAUDCAD', 'frxAUDCHF', 'frxAUDJPY', 'frxAUDNZD', 'frxAUDUSD', 'cryBTCUSD', 'cryETHUSD', 'frxEURAUD', 'frxEURCAD', 'frxEURCHF', 'frxEURGBP', 'frxEURJPY', 'frxEURNZD', 'frxEURUSD', 'frxGBPAUD', 'frxGBPCAD', 'frxGBPCHF', 'frxGBPJPY', 'frxGBPNZD', 'frxGBPUSD', 'frxNZDJPY', 'frxNZDUSD', 'frxUSDCAD', 'frxUSDCHF', 'frxUSDJPY', 'frxUSDMXN', 'frxUSDPLN', 'frxXAGUSD', 'frxXAUUSD', 'frxXPDUSD', 'frxXPTUSD', '1HZ10V', '1HZ15V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ90V', '1HZ100V'];
                var GR = [['ALL', 'ALL'], ['FRX', 'FOREX'], ['MTL', 'METAL'], ['CRY', 'CRYPTO'], ['DRV', 'DERIV']];
                var MT = /^frx(XAU|XAG|XPT|XPD)/;
                function inGrp(p) {
                    if (grp === 'FRX') return p.indexOf('frx') === 0;
                    if (grp === 'MTL') return MT.test(p);
                    if (grp === 'CRY') return p.indexOf('cry') === 0;
                    if (grp === 'DRV') return p.indexOf('1HZ') === 0;
                    return true;
                }
                function paint() {
                    var h = '', t = '', list = [], i4, p, on, pc, ga;
                    for (i4 = 0; i4 < GR.length; i4++) {
                        ga = (GR[i4][0] === grp);
                        t += '<button type="button" data-g="' + GR[i4][0] + '" style="flex:1;height:26px;padding:0;border:1px solid ' + (ga ? 'var(--pair-color,#E2E8F0)' : '#555') + ';border-radius:13px !important;background:' + (ga ? 'var(--pair-color,#E2E8F0)' : '#000432') + ' !important;color:' + (ga ? '#000432' : '#fff') + ' !important;-webkit-text-fill-color:' + (ga ? '#000432' : '#fff') + ' !important;font-size:9px;font-weight:800;cursor:pointer;' + CEF + '">' + GR[i4][1] + '</button>';
                    }
                    tEl.innerHTML = t;
                    for (i4 = 0; i4 < PL.length; i4++) {
                        if (inGrp(PL[i4]) && (!q || ceName(PL[i4]).toUpperCase().indexOf(q) >= 0)) list.push(PL[i4]);
                    }
                    list.sort(function (a, b) { return ceName(a).localeCompare(ceName(b), undefined, { numeric: true, sensitivity: 'base' }); });
                    for (i4 = 0; i4 < list.length; i4++) {
                        p = list[i4];
                        on = (p === ceVal.symbol);
                        pc = ceCol(p);
                        h += '<button type="button" data-p="' + p + '" style="padding:8px 2px;border:1px solid ' + (on ? pc : '#555') + ';border-radius:12px !important;background:' + (on ? pc : '#000432') + ' !important;color:' + (on ? '#000432' : '#fff') + ' !important;-webkit-text-fill-color:' + (on ? '#000432' : '#fff') + ' !important;font-size:10px;font-weight:800;cursor:pointer;' + CEF + '">' + ceName(p) + '</button>';
                    }
                    gEl.innerHTML = h;
                }
                ov.innerHTML = '<div style="' + ceCard + 'padding:0;overflow:hidden;display:flex;flex-direction:column;">' +
                    '<div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;">' +
                    '<span style="font-size:11px;font-weight:800;letter-spacing:0.12em;color:var(--pair-color,#E2E8F0);">PAIR SELECTOR</span>' +
                    '<button type="button" data-x="1" style="background:none;border:none;color:#fff;font-size:14px;font-weight:800;cursor:pointer;">\u2715</button></div>' +
                    '<div id="cePpTabs" style="display:flex;gap:4px;padding:8px 8px 0;"></div>' +
                    '<div style="padding:8px;"><input id="cePpQ" type="text" placeholder="Search pair... e.g. ETH" style="width:100%;height:28px;box-sizing:border-box;background:#000432 !important;color:#fff !important;-webkit-text-fill-color:#fff !important;border:1px solid #555 !important;border-radius:14px !important;padding:0 12px;font-size:12px;font-weight:800;outline:none;' + CEF + '"></div>' +
                    '<div id="cePpGrid" style="overflow-y:auto;padding:0 8px 8px;display:grid;gap:5px;max-height:50vh;grid-template-columns:repeat(3,1fr);"></div></div>';
                gEl = ov.querySelector('#cePpGrid');
                tEl = ov.querySelector('#cePpTabs');
                ov.addEventListener('input', function (e) {
                    if (e.target && e.target.id === 'cePpQ') {
                        q = String(e.target.value).toUpperCase().replace(/^(FRX|CRY|1HZ)/, '');
                        paint();
                    }
                });
                ov.addEventListener('click', function (e) {
                    var t = (e.target && e.target.closest) ? e.target.closest('button') : null;
                    if (!t) { if (e.target === ov) ov.remove(); return; }
                    if (t.getAttribute('data-x')) { ov.remove(); return; }
                    if (t.getAttribute('data-g')) { grp = t.getAttribute('data-g'); paint(); return; }
                    var pp = t.getAttribute('data-p');
                    if (pp) { ceVal.symbol = pp; cePaint('symbol'); ov.remove(); }
                });
                paint();
            }
            function ceFmt(k) {
                var v = ceVal[k];
                if (k === 'symbol') return v ? ceName(v) + (window._payTxt || '') : '--';
                if (k === 'level') return v ? 'X' + v + '-X' + (v + 1) : 'ALL';
                if (k === 'session') return ceLen(v);
                if (k === 'interval') return v ? v + 's' : 'AUTO';
                if (k === 'minPct') return v + '%';
                if (k === 'minC' || k === 'maxC') return String(v);
                if (k === 'autoStake') return '$' + Number(v).toFixed(2);
                if (k === 'auto') return v ? 'ON' : 'OFF';
                return String(v);
            }
            function cePaint(k) {
                var el = document.getElementById('ceV_' + k);
                if (!el) { cePmDraw(); cePmAuto(); return; }
                if (!el) return;
                el.textContent = ceFmt(k);
                if (k === 'auto') {
                    if (ceVal.auto) {
                        el.style.setProperty('background', 'var(--pair-color,#E2E8F0)', 'important');
                        el.style.setProperty('color', '#000432', 'important');
                        el.style.setProperty('-webkit-text-fill-color', '#000432', 'important');
                    } else {
                        el.style.setProperty('background', '#000432', 'important');
                        el.style.setProperty('color', '#ffffff', 'important');
                        el.style.setProperty('-webkit-text-fill-color', '#ffffff', 'important');
                        el.style.setProperty('border', '1px solid #ffffff', 'important');
                    }
                }
            }
            function ceRow(k, label) {
                return '<div data-k="' + k + '" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0;font-size:10px;font-weight:800;cursor:pointer;">' + label +
                    '<div id="ceV_' + k + '" style="' + cePill + '">' + ceFmt(k) + '</div></div>';
            }
            function ceOverlay(z) {
                var o = document.createElement('div');
                o.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:' + z + ';background:rgba(0,4,50,0.85);display:flex;align-items:center;justify-content:center;';
                document.body.appendChild(o);
                return o;
            }
            function ceSelect(title, cols, opts, cur, pick) {
                var ov = ceOverlay(5200), h = '', i2, on;
                for (i2 = 0; i2 < opts.length; i2++) {
                    on = (opts[i2].v === cur);
                    h += '<button type="button" data-i="' + i2 + '" style="padding:10px 4px;border:1px solid ' + (on ? 'var(--pair-color,#E2E8F0)' : '#555') + ';border-radius:12px !important;background:' + (on ? 'var(--pair-color,#E2E8F0)' : '#000432') + ' !important;color:' + (on ? '#000432' : '#fff') + ' !important;-webkit-text-fill-color:' + (on ? '#000432' : '#fff') + ' !important;font-size:11px;font-weight:800;cursor:pointer;' + CEF + '">' + opts[i2].t + '</button>';
                }
                ov.innerHTML = '<div style="' + ceCard + 'padding:0;overflow:hidden;display:flex;flex-direction:column;">' +
                    '<div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;">' +
                    '<span style="font-size:11px;font-weight:800;letter-spacing:0.12em;color:var(--pair-color,#E2E8F0);">' + title + '</span>' +
                    '<button type="button" data-x="1" style="background:none;border:none;color:#fff;font-size:14px;font-weight:800;cursor:pointer;">\u2715</button></div>' +
                    '<div style="overflow-y:auto;padding:8px;display:grid;gap:5px;max-height:60vh;grid-template-columns:repeat(' + cols + ',1fr);">' + h + '</div></div>';
                ov.addEventListener('click', function (e) {
                    var t = (e.target && e.target.closest) ? e.target.closest('button') : null;
                    if (!t) { if (e.target === ov) ov.remove(); return; }
                    if (t.getAttribute('data-x')) { ov.remove(); return; }
                    var ix = t.getAttribute('data-i');
                    if (ix === null) return;
                    pick(opts[parseInt(ix, 10)].v);
                    ov.remove();
                });
            }
            function ceNumpad(k) {
                var cfg = ceNF[k], str = String(ceVal[k]), fresh = true, ov = ceOverlay(5300), disp = null;
                var keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', 'B'], g = '', i3;
                var bs = 'height:44px;border:1px solid #fff;border-radius:12px !important;background:#000432 !important;color:#fff !important;-webkit-text-fill-color:#fff !important;font-size:18px;font-weight:800;cursor:pointer;' + CEF;
                for (i3 = 0; i3 < keys.length; i3++) {
                    g += '<button type="button" data-n="' + keys[i3] + '" style="' + bs + ((keys[i3] === '.' && !cfg.dec) ? 'opacity:0.25;' : '') + '">' + (keys[i3] === 'B' ? '\u232B' : keys[i3]) + '</button>';
                }
                ov.innerHTML = '<div style="width:86vw;max-width:300px;box-sizing:border-box;background:#000432 !important;border:1px solid var(--pair-color,#E2E8F0) !important;border-radius:14px !important;overflow:hidden;color:#fff;' + CEF + '">' +
                    '<div style="padding:10px 14px;font-size:11px;font-weight:800;letter-spacing:0.12em;color:var(--pair-color,#E2E8F0);border-bottom:1px solid #333;">' + cfg.label + '</div>' +
                    '<div id="ceNpDisp" style="padding:12px;text-align:center;font-size:28px;font-weight:800;min-height:62px;box-sizing:border-box;color:#fff;"></div>' +
                    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px;">' + g + '</div>' +
                    '<div style="display:flex;gap:6px;padding:0 10px 10px;">' +
                    '<button type="button" data-n="C" style="flex:1;' + bs + 'color:#ff6b6b !important;-webkit-text-fill-color:#ff6b6b !important;border-color:#ff6b6b;font-size:13px;">CLEAR</button>' +
                    '<button type="button" data-n="D" style="flex:2;' + bs + 'background:var(--pair-color,#E2E8F0) !important;color:#000432 !important;-webkit-text-fill-color:#000432 !important;font-size:13px;">DONE \u2713</button></div></div>';
                disp = ov.querySelector('#ceNpDisp');
                function show() { if (disp) disp.textContent = str === '' ? '_' : str; }
                function done() {
                    var v = parseFloat(str);
                    if (!isNaN(v)) {
                        if (v < cfg.min) v = cfg.min;
                        if (v > cfg.max) v = cfg.max;
                        if (!cfg.dec) v = Math.round(v); else v = Math.round(v * 100) / 100;
                        ceVal[k] = v;
                        cePaint(k);
                    }
                    ov.remove();
                }
                function press(c) {
                    var dot;
                    if (c >= '0' && c <= '9') {
                        if (fresh) { str = ''; fresh = false; }
                        if (str === '0') str = c;
                        else if (str.length < 9) {
                            dot = str.indexOf('.');
                            if (dot !== -1 && cfg.fix !== undefined && (str.length - dot - 1) >= cfg.fix) return;
                            str += c;
                        }
                    } else if (c === '.') {
                        if (!cfg.dec) return;
                        if (fresh) { str = '0'; fresh = false; }
                        if (str === '') str = '0';
                        if (str.indexOf('.') === -1) str += '.';
                    } else if (c === 'B') {
                        fresh = false; str = str.slice(0, -1);
                    } else if (c === 'C') {
                        fresh = false; str = '';
                    } else if (c === 'D') {
                        done(); return;
                    }
                    show();
                }
                ov.addEventListener('click', function (e) {
                    var t = (e.target && e.target.closest) ? e.target.closest('button[data-n]') : null;
                    if (t) { press(t.getAttribute('data-n')); return; }
                    if (e.target === ov) done();
                });
                show();
            }
            var ceLvlOpts = [{ t: 'ALL', v: 0 }];
            for (ceI = 1; ceI <= 12; ceI++) ceLvlOpts.push({ t: 'X' + ceI + '-X' + (ceI + 1), v: ceI });
            var ceMins = [10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440], ceSesOpts = [], ceHas = false;
            for (ceI = 0; ceI < ceMins.length; ceI++) {
                if (ceMins[ceI] * 60 === ceVal.session) ceHas = true;
                ceSesOpts.push({ t: ceLen(ceMins[ceI] * 60) + ' (' + (1440 / ceMins[ceI]) + '/day)', v: ceMins[ceI] * 60 });
            }
            if (!ceHas) ceSesOpts.push({ t: ceLen(ceVal.session) + ' (custom)', v: ceVal.session });
            var cePmK = [['symbol', 'PAIR'], ['level', 'LVL'], ['minPct', 'MIN%'], ['minC', 'CYC MIN'], ['maxC', 'CYC MAX'], ['interval', 'SCAN'], ['session', 'SESSION'], ['autoStake', 'STAKE'], ['auto', 'AUTO']];
            function cePmDraw() {
                var h = '', i6, kk, cePmKs = cePmK.slice(), cePmHas = false;
                for (i6 = 0; i6 < cePmKs.length; i6++) { if (cePmKs[i6][0] === 'level') cePmHas = true; }
                if (!cePmHas) cePmKs.splice(cePmKs.length > 1 ? 1 : 0, 0, ['level', 'LEVEL']);
                for (i6 = 0; i6 < cePmKs.length; i6++) {
                    kk = cePmKs[i6][0];
                    if (kk === 'auto') continue;
                    h += '<div class="pmE" data-k="' + kk + '"><span class="pmV">' + ceFmt(kk) + '</span></div>';
                }
                h += '<div id="tcPmGo" style="display:none !important;flex:0 0 auto;min-width:44px;padding:0 8px;margin:0;box-sizing:border-box;align-self:stretch;display:flex;align-items:center;justify-content:center;background:var(--tc-sig,var(--pair-color,#E2E8F0)) !important;color:#000432 !important;-webkit-text-fill-color:#000432 !important;font-weight:800;border-radius:0 !important;cursor:pointer;">\u2713</div>';
                tcPmEl.innerHTML = h;
                tcPmEl.style.display = 'flex';
            }
            function cePmExit() {
                tcPmEditing = null;
                tcPmLast = '';
                tcPmRender();
            }
            var ceSaveT = 0;
            function cePmAuto() {
                clearTimeout(ceSaveT);
                ceSaveT = setTimeout(function () { cePmSave(null); }, 600);
            }
            function cePmSave(btn) {
                if (!btn) btn = { textContent: '' };
                var body = { key: ceKey, cfg: { minPct: ceVal.minPct, level: ceVal.level, minC: ceVal.minC, maxC: ceVal.maxC, interval: ceVal.interval, session: ceVal.session, autoStake: ceVal.autoStake, auto: true, symbol: ceVal.symbol } };
                btn.textContent = '...';
                try { evtLog('INFO', 'PILL SENDING ' + JSON.stringify(body.cfg)); } catch (eP) {}
                fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        if (j && j.ok) {
                            btn.textContent = 'SAVED \u2713';
                            try { _trToast('SETTINGS SAVED: ' + (j.msg || 'ok'), '#0ecb81'); } catch (eT2) {}
                            tcPmSnap = JSON.stringify(ceVal);
                            try { tcPmSig = JSON.stringify([S.symbol, S.cfg, S.len]); } catch (e8) { tcPmSig = ''; }
                            setTimeout(function () { if (tcPmEditing) cePmDraw(); }, 1200);
                        } else {
                            btn.textContent = 'ERROR: ' + ((j && j.error) || 'failed');
                            try { _trToast('SETTINGS NOT SAVED: ' + ((j && j.error) || 'failed'), '#f6465d'); } catch (eT3) {}
                            setTimeout(function () { if (tcPmEditing) cePmDraw(); }, 2500);
                        }
                    })
                    .catch(function (e3) {
                        btn.textContent = 'ERROR: ' + e3.message;
                        try { _trToast('SETTINGS NOT SAVED: ' + e3.message, '#f6465d'); } catch (eT4) {}
                        setTimeout(function () { if (tcPmEditing) cePmDraw(); }, 2500);
                    });
            }
            tcPmEditing = function (t) {
                var k = t.getAttribute('data-k');
                if (t.id === 'tcPmX') { cePmExit(); return; }
                if (t.id === 'tcPmGo') { cePmSave(t); return; }
                if (k === 'auto') { ceVal.auto = !ceVal.auto; cePaint('auto'); }
                else if (k === 'symbol') cePairPick();
                else if (k === 'level') ceSelect('SELECT LEVEL', 3, ceLvlOpts, ceVal.level, function (v) { ceVal.level = v; cePaint('level'); });
                else if (k === 'session') ceSelect('SELECT SESSION', 2, ceSesOpts, ceVal.session, function (v) { ceVal.session = v; cePaint('session'); });
                else if (ceNF[k]) ceNumpad(k);
            };
            cePmDraw();
            return;
            var ceKeyCss = 'width:140px;height:26px;box-sizing:border-box;background:#000432 !important;color:#fff !important;-webkit-text-fill-color:#fff !important;border:1px solid #fff !important;border-radius:13px !important;text-align:center;font-size:12px;font-weight:800;outline:none;' + CEF;
            ceOv = ceOverlay(5000);
            ceOv.id = 'tcCfgBox';
            ceOv.innerHTML = '<div style="' + ceCard + '">' +
                '<div style="font-size:11px;font-weight:800;letter-spacing:0.18em;margin-bottom:8px;color:var(--pair-color,#E2E8F0);">SERVER SETTINGS</div>' +
                ceRow('symbol', 'PAIR') + ceRow('level', 'LEVEL') + ceRow('minPct', 'MIN %') + ceRow('minC', 'CYCLE MIN') + ceRow('maxC', 'CYCLE MAX') +
                ceRow('interval', 'SCAN') + ceRow('session', 'SESSION') + ceRow('autoStake', 'AUTO STAKE') + ceRow('auto', 'AUTO TRADE') +
                '<input id="tcCe_key" type="hidden" value="">' +
                '<div id="tcCeMsg" style="min-height:14px;margin:6px 0;font-size:10px;font-weight:800;color:var(--pair-color,#E2E8F0);word-break:break-word;"></div>' +
                '<div style="display:flex;gap:4px;">' +
                '<button type="button" id="tcCeGo" style="flex:2;height:30px;border:none;border-radius:15px !important;background:var(--pair-color,#E2E8F0) !important;color:#000432 !important;-webkit-text-fill-color:#000432 !important;font-size:11px;font-weight:800;cursor:pointer;' + CEF + '">APPLY + SAVE</button>' +
                '<button type="button" id="tcCeX" style="flex:1;height:30px;border:1px solid #fff;border-radius:15px !important;background:#000432 !important;color:#fff !important;-webkit-text-fill-color:#fff !important;font-size:11px;font-weight:800;cursor:pointer;' + CEF + '">CANCEL</button>' +
                '</div></div>';
            cePaint('auto');
            document.getElementById('tcCe_key').value = ceKey;
            ceOv.addEventListener('click', function (e) {
                if (e.target === ceOv) { ceOv.remove(); return; }
                var t = (e.target && e.target.closest) ? e.target.closest('[data-k]') : null;
                if (!t) return;
                var k = t.getAttribute('data-k');
                if (k === 'auto') { ceVal.auto = !ceVal.auto; cePaint('auto'); }
                else if (k === 'symbol') cePairPick();
                else if (k === 'level') ceSelect('SELECT LEVEL', 3, ceLvlOpts, ceVal.level, function (v) { ceVal.level = v; cePaint('level'); });
                else if (k === 'session') ceSelect('SELECT SESSION', 2, ceSesOpts, ceVal.session, function (v) { ceVal.session = v; cePaint('session'); });
                else if (ceNF[k]) ceNumpad(k);
            });
            document.getElementById('tcCeX').onclick = function () { ceOv.remove(); };
            document.getElementById('tcCeGo').onclick = function () {
                var msgEl = document.getElementById('tcCeMsg'), goEl = document.getElementById('tcCeGo');
                var kv = document.getElementById('tcCe_key').value;
                var body = { key: kv, cfg: { minPct: ceVal.minPct, level: ceVal.level, minC: ceVal.minC, maxC: ceVal.maxC, interval: ceVal.interval, session: ceVal.session, autoStake: ceVal.autoStake, auto: ceVal.auto, symbol: ceVal.symbol } };

                goEl.disabled = true;
                msgEl.textContent = 'sending...';
                fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        goEl.disabled = false;
                        if (j && j.ok) {
                            try { localStorage.setItem('wsAdminKey', kv); } catch (e2) {}
                            msgEl.textContent = j.msg || 'done';
                            setTimeout(function () { ceOv.remove(); }, 2200);
                        } else {
                            msgEl.textContent = 'ERROR: ' + ((j && j.error) || 'failed');
                        }
                    })
                    .catch(function (e3) {
                        goEl.disabled = false;
                        msgEl.textContent = 'ERROR: ' + e3.message;
                    });
            };
        }
        function tcCfgEditOld() {
            if (document.getElementById('tcCfgBox')) return;
            var ceSt = null, ceCg = {}, ceKey = '', ceH = '', ceOv;
            try { ceSt = (typeof S !== 'undefined') ? S : null; } catch (e0) { ceSt = null; }
            ceCg = (ceSt && ceSt.cfg) ? ceSt.cfg : {};
            var ceF = [
                ['minPct', 'MIN %', ceCg.minPct], ['level', 'LEVEL (0=all)', ceCg.level],
                ['minC', 'CYCLE MIN', ceCg.minC], ['maxC', 'CYCLE MAX', ceCg.maxC],
                ['interval', 'SCAN SEC (0=auto)', ceCg.intervalRaw !== undefined ? ceCg.intervalRaw : ceCg.interval],
                ['session', 'SESSION SEC', ceCg.session], ['autoStake', 'AUTO STAKE', ceCg.autoStake]
            ];
            try { ceKey = localStorage.getItem('wsAdminKey') || ''; } catch (e1) { ceKey = ''; }
            var ceIn = 'width:120px;height:24px;box-sizing:border-box;background:#000432;color:#fff;border:1px solid #fff;border-radius:12px;text-align:center;font:800 12px JetBrains Mono,monospace;outline:none;';
            ceH = '<div style="width:92vw;max-width:340px;background:#000432;border:1px solid var(--pair-color,#E2E8F0);border-radius:14px;padding:12px;font-family:JetBrains Mono,monospace;color:#fff;">' +
                '<div style="font-size:11px;font-weight:800;letter-spacing:0.18em;margin-bottom:8px;color:var(--pair-color,#E2E8F0);">SERVER SETTINGS</div>';
            ceF.forEach(function (f) {
                var v = (f[2] === undefined || f[2] === null) ? '' : String(f[2]).replace(/[^0-9.\-]/g, '');
                ceH += '<label style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;font-size:10px;font-weight:800;">' + f[1] +
                    '<input id="tcCe_' + f[0] + '" type="number" step="any" value="' + v + '" style="' + ceIn + '"></label>';
            });
            ceH += '<label style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;font-size:10px;font-weight:800;">AUTO TRADE' +
                '<select id="tcCe_auto" style="' + ceIn + '"><option value="1"' + (ceCg.auto === false ? '' : ' selected') + '>ON</option><option value="0"' + (ceCg.auto === false ? ' selected' : '') + '>OFF</option></select></label>' +
                '<label style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 4px;font-size:10px;font-weight:800;">ADMIN KEY' +
                '<input id="tcCe_key" type="password" value="" style="' + ceIn + '"></label>' +
                '<div id="tcCeMsg" style="min-height:14px;margin:6px 0;font-size:10px;font-weight:800;color:var(--pair-color,#E2E8F0);word-break:break-word;"></div>' +
                '<div style="display:flex;gap:4px;">' +
                '<button type="button" id="tcCeGo" style="flex:2;height:28px;border:none;border-radius:14px;background:var(--pair-color,#E2E8F0);color:#000432;font:800 11px JetBrains Mono,monospace;cursor:pointer;">APPLY + SAVE</button>' +
                '<button type="button" id="tcCeX" style="flex:1;height:28px;border:1px solid #fff;border-radius:14px;background:#000432;color:#fff;font:800 11px JetBrains Mono,monospace;cursor:pointer;">CANCEL</button>' +
                '</div></div>';
            ceOv = document.createElement('div');
            ceOv.id = 'tcCfgBox';
            ceOv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:5000;background:rgba(0,4,50,0.85);display:flex;align-items:center;justify-content:center;';
            ceOv.innerHTML = ceH;
            document.body.appendChild(ceOv);
            document.getElementById('tcCe_key').value = ceKey;
            ceOv.addEventListener('click', function (e) { if (e.target === ceOv) ceOv.remove(); });
            document.getElementById('tcCeX').onclick = function () { ceOv.remove(); };
            document.getElementById('tcCeGo').onclick = function () {
                var msgEl = document.getElementById('tcCeMsg'), goEl = document.getElementById('tcCeGo');
                var kv = document.getElementById('tcCe_key').value;
                var body = { key: kv, cfg: {} };
                ceF.forEach(function (f) {
                    var v = document.getElementById('tcCe_' + f[0]).value;
                    if (v !== '') body.cfg[f[0]] = Number(v);
                });
                body.cfg.auto = document.getElementById('tcCe_auto').value === '1';
                if (ceCg.session !== undefined && body.cfg.session !== undefined && body.cfg.session !== ceCg.session) {
                    if (!window.confirm('Changing the session length rebuilds the current session. Continue?')) return;
                }
                goEl.disabled = true;
                msgEl.textContent = 'sending...';
                fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                    .then(function (r) { return r.json(); })
                    .then(function (j) {
                        goEl.disabled = false;
                        if (j && j.ok) {
                            try { localStorage.setItem('wsAdminKey', kv); } catch (e2) {}
                            msgEl.textContent = j.msg || 'done';
                            setTimeout(function () { ceOv.remove(); }, 2200);
                        } else {
                            msgEl.textContent = 'ERROR: ' + ((j && j.error) || 'failed');
                        }
                    })
                    .catch(function (e3) {
                        goEl.disabled = false;
                        msgEl.textContent = 'ERROR: ' + e3.message;
                    });
            };
        }
        tcPmEl.addEventListener('click', function (e) {
            var t = e.target;
            var ck = (t && t.closest) ? t.closest('#tcPmSet,#tcPmGo,#tcPmX,[data-k]') : null;
            if (!ck) return;
            if (ck.id === 'tcPmSet') { if (!tcPmEditing) tcCfgEdit(); return; }
            if (tcPmEditing) tcPmEditing(ck);
        });
        tcPmRender();
        setInterval(tcPmRender, 500);
        dock.appendChild(tcPmEl);
        dock.appendChild(sgSlotEl);
        dock.appendChild(bar);
        w.appendChild(dock);
        (function dockPill() {
            var f = document.getElementById('floatTradePill');
            if (f && f.getAttribute('data-ready')) {
                dock.insertBefore(f, bar);
                dock.className = 'tcMerged';
                [document.getElementById('tradeHistBtn'), document.getElementById('accountBalance'), document.getElementById('logBtn')].forEach(function (el) {
                    if (!el) return;
                    bar.appendChild(el);
                    ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'].forEach(function (nm) {
                        el.addEventListener(nm, function (e) { e.stopPropagation(); }, { passive: true });
                    });
                });
                ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'].forEach(function (nm) {
                    f.addEventListener(nm, function (e) { e.stopPropagation(); }, { passive: true });
                });
                return;
            }
            setTimeout(dockPill, 300);
        })();
        setInterval(function () {
            if (dock.className.indexOf('tcMerged') < 0) return;
            ['tradeHistBtn', 'accountBalance', 'logBtn'].forEach(function (id) {
                var el = document.getElementById(id);
                if (!el) return;
                if (el.parentNode !== bar) bar.appendChild(el);
                if (el.getAttribute('data-tcbar')) return;
                el.setAttribute('data-tcbar', '1');
                ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'].forEach(function (nm) {
                    el.addEventListener(nm, function (e) { e.stopPropagation(); }, { passive: true });
                });
            });
        }, 300);
        /* auto-fire a DEMO trade the moment a signal hits (only for fresh hits, 8 s after page load) */
        var _atSeen = '', _atT0 = Date.now();
        setInterval(function () {
            var bn = TC.banner;
            if (!bn || !bn.sig || bn.kind === 'win' || bn.kind === 'loss') return;
            var k = bn.t0 + '|' + bn.idx + '|' + bn.sig.c + '-' + bn.sig.r;
            if (k === _atSeen) return;
            _atSeen = k;
            if (Date.now() - _atT0 < 8000) return;
            if (Date.now() - bn.t0 > 4000) return;
            /* browser auto-fire disabled: the server places auto trades now */
        }, 250);
        vp.appendChild(w);
        TC.wrap = w; TC.cv = cv; TC.ctx = cv.getContext('2d');

        /* keep the grid's own mouse / touch / wheel handlers away from this layer */
        ['mousedown', 'touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(function (nm) {
            w.addEventListener(nm, function (e) { e.stopPropagation(); }, { passive: true });
        });
        ['contextmenu', 'selectstart', 'dragstart'].forEach(function (nm) {
            w.addEventListener(nm, function (e) { e.preventDefault(); }, true);
        });

        $('tcZoomOut').addEventListener('click', function () { tcZoom(1); });
        $('tcZoomIn').addEventListener('click', function () { tcZoom(-1); });
        $('tcLiveBtn').addEventListener('click', function () { TC.follow = true; tcSyncLiveBtn(); tcDraw(); });
        $('tcAutoBtn').addEventListener('click', function () { TC.yZ = 1; TC.yOff = 0; TC.spp = 3; TC.follow = true; tcSyncLiveBtn(); tcSyncAuto(); tcDraw(); });

        /* ---------- pointer controller ---------- */
        var P = {}, G = null, PIN = null;
        function nPtr() { var n = 0, kk; for (kk in P) n++; return n; }
        function two() {
            var ids = [], kk;
            for (kk in P) ids.push(kk);
            return ids.length >= 2 ? [P[ids[0]], P[ids[1]]] : null;
        }
        function zoneAt(x, y) {
            if (y > TC.H - PADB) return (x <= TC.W - PADR) ? 'time' : 'corner';
            if (x > TC.W - PADR) return 'price';
            return 'plot';
        }
        function plotH() { return Math.max(40, TC.H - PADT - PADB); }
        function holdUi(on) { w.style.boxShadow = on ? 'inset 0 0 0 2px ' + (window.pairColorHex || '#FFD700') : 'none'; }
        function endGesture() {
            if (G) {
                if (G.timer) clearTimeout(G.timer);
                if (G.armed) holdUi(false);
            }
            G = null;
            cv.style.cursor = 'default';
        }
        function arm() {
            if (!G || G.armed || G.moved) return;
            G.timer = null; G.armed = true;
            TC.follow = false; tcHideTip(); tcSyncLiveBtn(); holdUi(true);
            try { if (navigator.vibrate) navigator.vibrate(15); } catch (er) {}
        }
        cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        cv.addEventListener('pointerdown', function (e) {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            var rc = cv.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
            try { cv.setPointerCapture(e.pointerId); } catch (er) {}
            P[e.pointerId] = { x: e.clientX, y: e.clientY };
            if (nPtr() >= 2) {
                var t = two();
                endGesture(); tcHideTip();
                PIN = {
                    sdx: Math.abs(t[0].x - t[1].x), sdy: Math.abs(t[0].y - t[1].y), sspp: TC.spp, syz: TC.yZ || 1,
                    smx: (t[0].x + t[1].x) / 2 - rc.left, sleft: TC.left, lmy: (t[0].y + t[1].y) / 2, tm: false
                };
                return;
            }
            var z = zoneAt(x, y);
            G = { id: e.pointerId, zone: z, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, ax: x, moved: false, armed: false, timer: null };
            tcHideTip();
            if (z === 'plot') { G.timer = setTimeout(arm, HOLD_MS); if (e.pointerType !== 'mouse') { TC.mx = x; TC.my = y; tcHoverAt(x, y); } }
            else if (z === 'price') cv.style.cursor = 'ns-resize';
            else if (z === 'time') cv.style.cursor = 'ew-resize';
        });
        cv.addEventListener('pointermove', function (e) {
            var rc = cv.getBoundingClientRect();
            if (P[e.pointerId]) { P[e.pointerId].x = e.clientX; P[e.pointerId].y = e.clientY; }
            if (PIN) {
                var t = two();
                if (!t) return;
                var plotW = TC.W - PADL - PADR;
                var dx = Math.abs(t[0].x - t[1].x), dy = Math.abs(t[0].y - t[1].y);
                var mx = (t[0].x + t[1].x) / 2 - rc.left, my = (t[0].y + t[1].y) / 2;
                var newSpp = PIN.sspp;
                if (PIN.sdx >= 40 && dx >= 1) newSpp = clamp(PIN.sspp * PIN.sdx / dx, 0.1, 600);
                if (Math.abs(newSpp - PIN.sspp) > 1e-6 || Math.abs(mx - PIN.smx) > 3) PIN.tm = true;
                if (PIN.tm) {
                    var idxMid = PIN.sleft + (PIN.smx - PADL) * PIN.sspp;
                    TC.follow = false; TC.spp = newSpp;
                    TC.left = idxMid - (mx - PADL) * newSpp;
                    tcClamp(plotW); tcSyncLiveBtn();
                }
                if (PIN.sdy >= 40 && dy >= 1) TC.yZ = clamp(PIN.syz * dy / PIN.sdy, 0.2, 40);
                var dMid = my - PIN.lmy; PIN.lmy = my;
                if ((TC.yZ || 1) > 1.05) TC.yOff = clamp((TC.yOff || 0) + dMid / plotH() / (TC.yZ || 1), -3, 3);
                tcSyncAuto(); tcRequest();
                return;
            }
            if (!G) {
                var hx = e.clientX - rc.left, hy = e.clientY - rc.top, hz = zoneAt(hx, hy);
                if (e.pointerType === 'mouse') {
                    cv.style.cursor = hz === 'price' ? 'ns-resize' : (hz === 'time' ? 'ew-resize' : 'default');
                    if (hz === 'plot') { TC.mx = hx; TC.my = hy; cv.style.cursor = tcHoverAt(hx, hy) ? 'pointer' : 'default'; }
                    else tcHideTip();
                }
                return;
            }
            if (e.pointerId !== G.id) return;
            var ddx = e.clientX - G.lx, ddy = e.clientY - G.ly;
            if (!G.moved && (Math.abs(e.clientX - G.sx) > 3 || Math.abs(e.clientY - G.sy) > 3)) {
                G.moved = true; tcHideTip();
                if (G.timer && (Math.abs(e.clientX - G.sx) > HOLD_TOL || Math.abs(e.clientY - G.sy) > HOLD_TOL)) { clearTimeout(G.timer); G.timer = null; }
            }
            if (!G.moved) return;
            G.lx = e.clientX; G.ly = e.clientY;
            if (G.zone === 'plot') {
                var plotW2 = TC.W - PADL - PADR;
                TC.follow = false;
                TC.left -= ddx * TC.spp;
                tcClamp(plotW2);
                if (G.armed || (TC.yZ || 1) !== 1 || (TC.yOff || 0) !== 0) {
                    TC.yOff = clamp((TC.yOff || 0) + ddy / plotH() / (TC.yZ || 1), -3, 3);
                }
                tcSyncLiveBtn(); tcSyncAuto(); tcRequest();
            } else if (G.zone === 'price') {
                TC.yZ = clamp((TC.yZ || 1) * Math.exp(-ddy / 150), 0.2, 40);
                tcSyncAuto(); tcRequest();
            } else if (G.zone === 'time') {
                if (ddx !== 0) tcApplySpp(TC.spp * Math.exp(ddx / 150), G.ax);
            }
        });
        function ptrEnd(e) {
            var had = !!P[e.pointerId];
            delete P[e.pointerId];
            try { cv.releasePointerCapture(e.pointerId); } catch (er) {}
            if (PIN) {
                if (nPtr() < 2) PIN = null;
                if (nPtr() === 0) endGesture();
                return;
            }
            if (!had || !G || e.pointerId !== G.id) return;
            var g = G, rc = cv.getBoundingClientRect();
            endGesture();
            if (e.type === 'pointerup' && g.zone === 'plot' && !g.moved && !g.armed) {
                tcClick(e.clientX - rc.left, e.clientY - rc.top);
            }
        }
        cv.addEventListener('pointerup', ptrEnd);
        cv.addEventListener('pointercancel', ptrEnd);
        cv.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !G) tcHideTip(); });
        window.addEventListener('blur', endGesture);
        document.addEventListener('visibilitychange', function () { if (document.hidden) endGesture(); });
        cv.addEventListener('dblclick', function (e) {
            var rc = cv.getBoundingClientRect(), z = zoneAt(e.clientX - rc.left, e.clientY - rc.top);
            if (z === 'price') { TC.yZ = 1; TC.yOff = 0; tcSyncAuto(); tcDraw(); }
            else if (z === 'time') { TC.spp = 3; TC.follow = true; tcSyncLiveBtn(); tcDraw(); }
        });
        w.addEventListener('wheel', function (e) {
            e.preventDefault(); e.stopPropagation();
            var rc = cv.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top, z = zoneAt(x, y);
            var dy = e.deltaY, dx = e.deltaX;
            if (e.deltaMode === 1) { dy *= 33; dx *= 33; } else if (e.deltaMode === 2) { dy *= 400; dx *= 400; }
            dy = clamp(dy, -300, 300);
            if (z === 'price' || e.altKey) {
                TC.yZ = clamp((TC.yZ || 1) * Math.exp(-dy * 0.0015), 0.2, 40);
                tcSyncAuto(); tcDraw(); return;
            }
            if (!e.shiftKey && dy && Math.abs(dx) <= Math.abs(dy)) {
                var ax = clamp(x, PADL, TC.W - PADR);
                tcApplySpp(TC.spp * Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)), ax);
                return;
            }
            TC.follow = false;
            TC.left += (dx || dy) * TC.spp;
            tcClamp(TC.W - PADL - PADR);
            tcSyncLiveBtn(); tcDraw();
        }, { passive: false });

        window.addEventListener('resize', function () { if (TC.on) tcRequest(); });
        if (window.ResizeObserver) { try { new ResizeObserver(function () { if (TC.on) tcRequest(); }).observe(w); } catch (er) {} }
        tcSyncLiveBtn(); tcSyncAuto();
    }

    /* ------------------------------------------------------------------ TICK chart (locked on: the button no longer returns to the grid) */
    function tcToggleImpl() {
        tcBuild();
        if (!TC.wrap || TC.on) return;
        TC.on = true;
        var btn = $('tcToggleBtn');
        TC.wrap.style.display = 'block';
        TC.follow = true;
        if (TC.timer) clearInterval(TC.timer);
        TC.timer = setInterval(function () { tcDraw(); }, 500);
        if (TC.pulseTimer) clearInterval(TC.pulseTimer);
        TC.pulseTimer = setInterval(function () { if (TC.pulseOn || (TC.activeAt && Date.now() - TC.activeAt < 400)) tcDraw(); }, 80);
        if (btn) { btn.textContent = 'GRID'; btn.setAttribute('data-mode', 'GRID'); btn.title = 'Tick chart is locked on'; }
        tcSyncLiveBtn(); tcSyncAuto();
        tcDraw();
    }
    tcToggle = tcToggleImpl;
    window.tcToggle = tcToggleImpl;
    window.tcRedraw = function () { if (TC.on) tcRequest(); };
    window.tcOnData = function () { if (TC.on) tcDraw(); };

    /* clicking a row in the wall panel / moving between instances re-centres the chart */
    if (typeof showInstance === 'function' && !window._tcShowWrapped) {
        window._tcShowWrapped = true;
        var origShow = showInstance;
        showInstance = function () {
            var ret = origShow.apply(this, arguments);
            try { window.tcRedraw(); } catch (e) {}
            return ret;
        };
    }
    if (typeof renderTables === 'function' && !window._tcRenderWrapped) {
        window._tcRenderWrapped = true;
        var origRender = renderTables;
        renderTables = function () {
            var ret = origRender.apply(this, arguments);
            try { window.tcRedraw(); } catch (e) {}
            return ret;
        };
    }

    /* open on the tick chart, chart only (panels hidden) */
    setTimeout(function () {
        var b = $('tcToggleBtn');
        if (b && !TC.on && b.getAttribute('data-mode') === 'TICK') tcToggleImpl();
        document.body.classList.add('tc-solo');
        setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 30);
    }, 300);
})();

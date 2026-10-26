/* ===== WallSpectrum UI layer: grid chart, signal tables, trading panel, boot + polling ===== */
var S = null;
var CYCLE = 300, CELL_W = 40, HEADER_H = 20, CELL_H = 13;
var activePair = 'frxXAUUSD';
var matrixData = {}, streakInstances = {}, streakHistoryApp3 = {};
var currentInstances = [], currentInstanceIndex = -1, clickCycleIndex = -1;
var highlightRow = -1, liveEdgeCol = -1, lastClickedSigId = '';
var r0OnlyMode = false, followLive = true, _lastKey = '', _bootGone = false, _bootT0 = Date.now();
var currentStartTsUtc = 0;
window._liveMaxIndex = 0;
window.systemThemeHex = '#000432';
window.accentGreenHex = '#2ED573';
window.accentRedHex = '#E63946';

var canvas = document.getElementById('matrixCanvas');
var ctx = canvas.getContext('2d', { alpha: false });
var viewport = document.getElementById('canvas-viewport');
var rowPanel = document.getElementById('row-index-panel');
var hScroll = document.getElementById('h-scroll-track');
var hSpacer = document.getElementById('h-spacer');

function $(i) { return document.getElementById(i); }
function requestDraw() { requestAnimationFrame(draw); }
function _cycleOff() { return (currentStartTsUtc || 0) % CYCLE; }
function getPairDisplayName(pair) { return pair.replace(/^(frx|cry|1HZ)/i, ''); }
function _fmtLenLabel(len) { var h = Math.floor(len / 60), m = len % 60; if (h && m) return h + 'h ' + m + 'm'; if (h) return h + 'h'; return m + 'm'; }
function tcPairColor(pair) {
    var PAIR_COLORS = { frxXAUUSD: '#FFD700', frxXAGUSD: '#C0C0C0', frxXPTUSD: '#E5E4E2', frxXPDUSD: '#CED0DD', cryBTCUSD: '#F7931A', cryETHUSD: '#627EEA' };
    if (PAIR_COLORS[pair]) return PAIR_COLORS[pair];
    var h = 0, i;
    for (i = 0; i < pair.length; i++) { h = (h * 31 + pair.charCodeAt(i)) % 360; }
    return 'hsl(' + h + ',80%,62%)';
}
window._tcPairColorFn = tcPairColor;
function _esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

/* ---- scrolling: hidden scroll track + drag / touch / wheel ---- */
var isDragging = false, startX = 0, startScrollX = 0;
var _tdX = 0, _tdScroll = 0, _tdLastX = 0, _tdLastT = 0, _tdVel = 0, _tdRaf = 0;
hScroll.addEventListener('scroll', function () { requestDraw(); });
window.addEventListener('resize', function () { if (S) { buildAll(); } });
document.addEventListener('visibilitychange', function () { if (!document.hidden) requestDraw(); });
viewport.addEventListener('mousedown', function (e) { isDragging = true; followLive = false; startX = e.pageX; startScrollX = hScroll.scrollLeft; });
window.addEventListener('mouseup', function () { isDragging = false; });
window.addEventListener('mouseleave', function () { isDragging = false; });
window.addEventListener('mousemove', function (e) { if (!isDragging) return; e.preventDefault(); hScroll.scrollLeft = startScrollX - (e.pageX - startX); });
viewport.addEventListener('wheel', function (e) { followLive = false; hScroll.scrollLeft += e.deltaY; e.preventDefault(); }, { passive: false });
function _tdInertia() {
    if (window._gridTouching) return;
    if (Math.abs(_tdVel) < 0.02) return;
    hScroll.scrollLeft -= _tdVel * 16; _tdVel *= 0.95;
    _tdRaf = requestAnimationFrame(_tdInertia);
}
viewport.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    cancelAnimationFrame(_tdRaf); window._gridTouching = true; followLive = false;
    _tdX = e.touches[0].pageX; _tdScroll = hScroll.scrollLeft; _tdLastX = _tdX; _tdLastT = Date.now(); _tdVel = 0;
}, { passive: true });
viewport.addEventListener('touchmove', function (e) {
    if (!window._gridTouching || e.touches.length !== 1) return;
    e.preventDefault();
    var tx = e.touches[0].pageX;
    hScroll.scrollLeft = _tdScroll - (tx - _tdX);
    var tn = Date.now(), dt = tn - _tdLastT;
    if (dt > 0) _tdVel = (tx - _tdLastX) / dt;
    _tdLastX = tx; _tdLastT = tn;
}, { passive: false });
function _tdEnd() { if (!window._gridTouching) return; if (Date.now() - _tdLastT > 80) _tdVel = 0; window._gridTouching = false; _tdInertia(); }
viewport.addEventListener('touchend', _tdEnd, { passive: true });
viewport.addEventListener('touchcancel', _tdEnd, { passive: true });

/* ---- data -> matrix / streak panel / row index ---- */
function buildAll() {
    if (!S) return;
    var P = S.prices, off = _cycleOff();
    var availableHeight = Math.max(100, viewport.clientHeight - HEADER_H);
    CELL_H = availableHeight / CYCLE;
    var dynamicFontSize = Math.max(8, Math.floor(CELL_H * 0.72));
    matrixData = {};
    var localMax = 0, i, row, col, p, prevCol, prev, streakCol, streakLen;
    var rowHtml = '';
    for (var r = 0; r < CYCLE; r++) { rowHtml += '<div class="idx-cell" style="height:' + CELL_H + 'px; font-size:' + dynamicFontSize + 'px;">' + r + '</div>'; }
    rowPanel.innerHTML = rowHtml;
    for (i = 0; i < P.length; i++) {
        p = P[i];
        if (p !== -1.0) localMax = Math.max(localMax, i);
        var tot = i + off;
        col = Math.floor(tot / CYCLE); row = tot % CYCLE;
        if (!matrixData[col]) matrixData[col] = {};
        streakCol = 'G'; streakLen = 1; prevCol = col - 1;
        if (matrixData[prevCol] && matrixData[prevCol][row]) {
            prev = matrixData[prevCol][row];
            if (p === -1.0) { streakLen = 0; streakCol = 'N'; }
            else if (p > prev.p) { streakCol = 'G'; streakLen = (prev.c === 'G' ? prev.s + 1 : 1); }
            else if (p < prev.p) { streakCol = 'R'; streakLen = (prev.c === 'R' ? prev.s + 1 : 1); }
            else { streakCol = prev.c; streakLen = 0; }
        } else if (p === -1.0) { streakLen = 0; streakCol = 'N'; }
        matrixData[col][row] = { c: streakCol, s: streakLen, p: p };
    }
    window._liveMaxIndex = Math.max(window._liveMaxIndex || 0, localMax, S.maxidx || 0);
    streakInstances = {}; streakHistoryApp3 = {};
    for (var rr = 0; rr < CYCLE; rr++) { streakInstances[rr] = { R: {}, G: {} }; streakHistoryApp3[rr] = { R: {}, G: {} }; }
    var allCols = Object.keys(matrixData).map(Number);
    if (allCols.length === 0) { requestDraw(); return; }
    var sEnd = P.length + off;
    var sessMaxCol = Math.floor((sEnd - 1) / CYCLE);
    var maxCol = Math.min(Math.max.apply(null, allCols), sessMaxCol);
    for (var r2 = 0; r2 < CYCLE; r2++) {
        var curStreak = 0, curColor = 'N', lastActiveCol = 0;
        for (var c = 0; c <= maxCol; c++) {
            if (matrixData[c] && matrixData[c][r2]) {
                var cell = matrixData[c][r2];
                if (cell.s === 0 || cell.s === 1 || cell.c !== curColor) {
                    if (curStreak > 0 && curColor !== 'N' && cell.s === 1) {
                        if (!streakInstances[r2][curColor][curStreak]) streakInstances[r2][curColor][curStreak] = [];
                        streakInstances[r2][curColor][curStreak].push(lastActiveCol);
                        streakHistoryApp3[r2][curColor][curStreak] = (streakHistoryApp3[r2][curColor][curStreak] || 0) + 1;
                    }
                }
                curColor = cell.s > 0 ? cell.c : 'N'; curStreak = cell.s;
                if (cell.s > 0) lastActiveCol = c;
            } else { curStreak = 0; curColor = 'N'; }
        }
        if (curStreak > 0 && curColor !== 'N') {
            if (!streakInstances[r2][curColor][curStreak]) streakInstances[r2][curColor][curStreak] = [];
            streakInstances[r2][curColor][curStreak].push(lastActiveCol);
            streakHistoryApp3[r2][curColor][curStreak] = (streakHistoryApp3[r2][curColor][curStreak] || 0) + 1;
        }
    }
    var app3Html = '';
    for (var r3 = 0; r3 < CYCLE; r3++) {
        var rM = 0, gM = 0;
        var rKeys = Object.keys(streakHistoryApp3[r3].R).map(Number); if (rKeys.length) rM = Math.max.apply(null, rKeys);
        var gKeys = Object.keys(streakHistoryApp3[r3].G).map(Number); if (gKeys.length) gM = Math.max.apply(null, gKeys);
        app3Html += '<div class="app3-list-row" style="height:' + CELL_H + 'px;" onclick="openModalApp3(' + r3 + ')">' +
            '<div class="app3-list-col app3-red-side" style="font-size:' + dynamicFontSize + 'px;">' + (rM ? 'x' + rM : '·') + '</div>' +
            '<div class="app3-list-col app3-green-side" style="font-size:' + dynamicFontSize + 'px;">' + (gM ? 'x' + gM : '·') + '</div></div>';
    }
    $('app3-mainContainer').innerHTML = app3Html;
    hSpacer.style.width = Math.round((maxCol + 1) * CELL_W) + 'px';
    if (lastClickedSigId) { _rebuildInstances(); }
    requestDraw();
}

/* ---- grid draw: cells, instance boxes, footer time axis ---- */
function draw() {
    if (!S) return;
    if (window.TC && window.TC.on) return;
    var viewW = viewport.clientWidth, viewH = viewport.clientHeight, scrollL = hScroll.scrollLeft, scrollT = 0;
    canvas.width = viewW; canvas.height = viewH;
    ctx.fillStyle = window.CHART_BG || window.systemThemeHex || '#000432'; ctx.fillRect(0, 0, viewW, viewH);
    var dynamicFontSize = Math.max(8, Math.floor(CELL_H * 0.72));
    ctx.font = '800 ' + dynamicFontSize + "px 'Inter', 'JetBrains Mono'";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var startCol = Math.floor(scrollL / CELL_W), endCol = Math.ceil((scrollL + viewW) / CELL_W);
    var centerOff = Math.round(CELL_W / 2);
    var nowUtc = Math.floor(Date.now() / 1000);
    var pcIndex = nowUtc - currentStartTsUtc;
    var currentIndex = Math.max(pcIndex, window._liveMaxIndex || 0);
    for (var c = startCol; c <= endCol; c++) {
        var x = Math.round((c * CELL_W) - scrollL);
        if (matrixData[c]) {
            for (var r = 0; r < CYCLE; r++) {
                var totalSec = (c * CYCLE) + r - _cycleOff();
                if (matrixData[c][r] && (matrixData[c][r].p !== -1.0 || totalSec <= currentIndex)) {
                    var y = Math.round((r * CELL_H) - scrollT);
                    var d = matrixData[c][r];
                    var label = 'X' + d.s;
                    ctx.globalAlpha = 1.0;
                    if (d.s > 0) { ctx.fillStyle = d.c === 'G' ? (window.accentGreenHex || '#2ED573') : (window.accentRedHex || '#E63946'); }
                    else { ctx.fillStyle = '#E2E8F0'; }
                    if (!(d.s > 0) && window.pairColorHex) { ctx.fillStyle = window.pairColorHex; }
                    _pillFill(ctx, x + 1, y + 1, CELL_W - 2, CELL_H - 1, Math.max(2, Math.round(Math.min(CELL_W, CELL_H) * 0.3)));
                    ctx.fillStyle = window.systemThemeHex || '#000432';
                    ctx.fillText(label, x + centerOff, y + (CELL_H / 2) + 1);
                }
            }
        }
    }
    try { var spH = $('streakPanel').clientHeight; if (spH > 0) { var spF = Math.max(5, Math.min(13, Math.floor((spH / (CYCLE || 60)) * 0.72))) + 'px'; if (window._spFsLast !== spF) { window._spFsLast = spF; document.documentElement.style.setProperty('--sp-fs', spF); } } } catch (e) {}
    currentInstances.forEach(function (inst) {
        var xPos = Math.round((inst.col * CELL_W) - scrollL), yPos = Math.round((inst.row * CELL_H) - scrollT);
        if (xPos >= -CELL_W && xPos <= viewW && yPos >= -CELL_H && yPos <= viewH) {
            ctx.strokeStyle = '#D500F9'; ctx.lineWidth = 2; _pillStroke(ctx, xPos, yPos, CELL_W, CELL_H, Math.max(2, Math.round(Math.min(CELL_W, CELL_H) * 0.3)));
        }
    });
    var footerY = viewH - HEADER_H;
    document.documentElement.style.setProperty('--tc-padb', HEADER_H + 'px');
    ctx.fillStyle = window.CHART_BG || window.systemThemeHex || '#000432'; ctx.fillRect(0, footerY, viewW, HEADER_H);
    ctx.strokeStyle = window.systemThemeHex || '#000432';
    if (!window._capBorder) { window._capBorder = function (c, w, yB, col) { var x0 = 0.5, x1 = w - 1.5, r = 16; c.save(); c.setLineDash([]); c.globalAlpha = 1; c.shadowBlur = 0; c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x1, 0); c.lineTo(x1, yB - r); c.arcTo(x1, yB, x1 - r, yB, r); c.lineTo(x0 + r, yB); c.arcTo(x0, yB, x0, yB - r, r); c.lineTo(x0, 0); c.stroke(); c.restore(); c.beginPath(); }; }
    if (!document.getElementById('capBorderCss')) { var cb = document.createElement('style'); cb.id = 'capBorderCss'; cb.textContent = 'html body #canvas-viewport::after{display:none !important;}'; document.head.appendChild(cb); }
    window._capBorder(ctx, viewW, footerY, window.pairColorHex || '#E2E8F0');
    ctx.font = "10px 'JetBrains Mono', monospace"; ctx.fillStyle = window.pairColorHex || '#E2E8F0';
    for (var c2 = startCol; c2 <= endCol; c2++) {
        var vcx = Math.round((c2 * CELL_W) - scrollL) + centerOff;
        var tSec = c2 * CYCLE - _cycleOff();
        var dSec = (((tSec + (currentStartTsUtc % 86400) + 19800) % 86400) + 86400) % 86400;
        var hT = Math.floor(dSec / 3600) % 24, mT = Math.floor((dSec % 3600) / 60);
        ctx.fillText(String(hT).padStart(2, '0') + ':' + String(mT).padStart(2, '0'), vcx, footerY + (HEADER_H / 2));
    }
}

/* ---- signal selection (REV path) ---- */
function _rebuildInstances() {
    var p = lastClickedSigId.split('-'); if (p.length < 7) return;
    var r = +p[2], s1 = +p[3], colColor = p[5];
    currentInstances = [];
    var hist = streakInstances[r] && streakInstances[r][colColor];
    if (hist) {
        var sessMaxCol = Math.floor((S.len + _cycleOff()) / CYCLE);
        Object.keys(hist).forEach(function (ls) {
            var L = parseInt(ls);
            if (L === s1) { hist[L].forEach(function (ec) { if (ec >= 0 && ec <= sessMaxCol) currentInstances.push({ col: ec, row: r, isFalse: false }); }); }
            else if (L > s1 && s1 >= 2) { hist[L].forEach(function (ec) { var ic = ec - (L - s1); if (ic >= 0 && ic <= sessMaxCol) currentInstances.push({ col: ic, row: r, isFalse: true }); }); }
        });
        currentInstances.sort(function (a, b) { return a.col - b.col; });
    }
    highlightRow = r;
}
function jumpToLive() {
    if (!S) return;
    var index = -1;
    for (var pi = S.prices.length - 1; pi >= 0; pi--) { if (S.prices[pi] !== -1.0) { index = pi; break; } }
    if (index === -1) { index = Math.max(0, Math.min(S.len - 1, Math.floor(Date.now() / 1000) - currentStartTsUtc)); }
    var liveCol = Math.floor((index + _cycleOff()) / CYCLE);
    currentInstanceIndex = -1; liveEdgeCol = liveCol;
    hScroll.scrollLeft = Math.max(0, (liveCol * CELL_W) - (viewport.clientWidth / 2) + (CELL_W / 2));
    requestDraw();
}
function showInstance(idx) {
    if (currentInstances.length === 0) return;
    if (idx < 0) { clickCycleIndex = -1; followLive = true; jumpToLive(); return; }
    if (idx >= currentInstances.length) { idx = currentInstances.length - 1; clickCycleIndex = idx; }
    currentInstanceIndex = idx; liveEdgeCol = -1; followLive = false;
    var inst = currentInstances[idx];
    hScroll.scrollLeft = Math.max(0, (inst.col * CELL_W) - (viewport.clientWidth / 2) + (CELL_W / 2));
    requestDraw();
}
function manualSelectSignal(pair, c, r, s1, s2, colColor, type) {
    var sigId = pair + '-' + c + '-' + r + '-' + s1 + '-' + s2 + '-' + colColor + '-' + type;
    var first = (sigId !== lastClickedSigId);
    if (CYCLE !== c) { CYCLE = c; $('cycleInput').value = c; lastClickedSigId = sigId; buildAll(); }
    lastClickedSigId = sigId;
    if (first) { _rebuildInstances(); clickCycleIndex = -1; currentInstanceIndex = -1; }
    if (currentInstances.length === 0) { followLive = true; jumpToLive(); renderTables(); return; }
    if (first) { clickCycleIndex = currentInstances.length - 1; }
    else { clickCycleIndex = clickCycleIndex - 1; }
    if (clickCycleIndex < -1) clickCycleIndex = currentInstances.length - 1;
    showInstance(clickCycleIndex);
    renderTables();
}

/* ---- scanner tables ---- */
function _buildScannerRowsHtml(list) {
    if (!list || list.length === 0) {
        return '<tr><td colspan="8" style="padding: 15px 0; font-size: 12px; font-weight: 800; text-align: center; color: #FFFFFF; letter-spacing: 0.1em;">NO TARGETS FOUND</td></tr>';
    }
    var html = '';
    list.forEach(function (data) {
        var rowClass = data.col === 'R' ? 'row-red' : 'row-green';
        var symbolClean = getPairDisplayName(data.pair);
        var thisSigId = data.pair + '-' + data.c + '-' + data.r + '-' + data.s1 + '-' + data.s2 + '-' + data.col + '-' + data.type;
        var selStyle = (thisSigId === lastClickedSigId) ? ' filter: brightness(1.2);' : '';
        var gapVal = data.gap || 0, curGapVal = data.curGap || 0;
        html += '<tr class="' + rowClass + ' highlight-gem" style="' + selStyle + '" onclick="manualSelectSignal(\'' + data.pair + '\', ' + data.c + ', ' + data.r + ', ' + data.s1 + ', ' + data.s2 + ', \'' + data.col + '\', \'' + data.type + '\', ' + gapVal + ', ' + curGapVal + ')">' +
            '<td style="width:28%; font-size:11px; font-weight:700; padding:8px 3px 8px 6px; border-right:1px solid #FFFFFF; overflow:hidden; white-space:nowrap; text-overflow:clip; text-align:left;">' + symbolClean + '</td>' +
            '<td style="width:11%; font-size:11px; font-weight:700; padding:8px 2px; border-right:1px solid #FFFFFF; text-align:center;">C' + data.c + '</td>' +
            '<td style="width:11%; font-size:11px; font-weight:700; padding:8px 2px; border-right:1px solid #FFFFFF; text-align:center;">R' + data.r + '</td>' +
            '<td style="width:18%; font-size:11px; font-weight:700; padding:8px 2px; border-right:1px solid #FFFFFF; text-align:center;">X' + data.s1 + '-X' + data.s2 + '</td>' +
            '<td style="width:9%; font-size:11px; font-weight:700; padding:8px 2px; border-right:1px solid #FFFFFF; text-align:center;">' + data.c1 + '</td>' +
            '<td style="width:9%; font-size:11px; font-weight:700; padding:8px 2px; border-right:1px solid #FFFFFF; text-align:center;">' + data.c2 + '</td>' +
            '<td style="width:14%; font-size:11px; font-weight:700; padding:8px 2px; text-align:center;">' + data.pct + '%</td></tr>';
    });
    return html;
}
function _buildTop10(list) {
    var minPct = parseFloat($('minPctInput').value) || 0, lvl = parseInt($('levelFilterSelect').value) || 0;
    var sorted = list.filter(function (x) { return x.pct >= minPct; })
        .filter(function (x) { return lvl === 0 || x.s1 === lvl; })
        .filter(function (x) { return !r0OnlyMode || x.r === 0; })
        .sort(function (a, b) { return (b.pct * b.c1) - (a.pct * a.c1); });
    var seen = {}, unique = [];
    for (var i = 0; i < sorted.length; i++) {
        var k = sorted[i].pair + '|' + sorted[i].s1;
        var _pc = seen[k] || 0;
        if (_pc < 10) { seen[k] = _pc + 1; unique.push(sorted[i]); }
    }
    return unique;
}
var lvlsOn = false, lvlsOrd = true;
function _lvList() {
    if (!S) return [];
    var src = lvlsOn ? (S.lvls || []) : (S.scan && S.scan.top ? S.scan.top : []);
    return src.map(function (x) { return Object.assign({ pair: S.symbol, type: 'REV' }, x); });
}
function _lvPick() {
    var list = _lvList();
    if (!lvlsOn) return _buildTop10(list);
    var out = list.filter(function (x) { return !r0OnlyMode || x.r === 0; });
    if (lvlsOrd) {
        out.sort(function (a, b) { return a.s1 - b.s1; });
    } else {
        var ck = (S.bot && S.bot.champion) ? S.bot.champion : null;
        if (ck) {
            for (var i = 0; i < out.length; i++) {
                if ([S.symbol, out[i].c, out[i].r, out[i].s1, out[i].col, 'REV'].join('|') === ck) { out.unshift(out.splice(i, 1)[0]); break; }
            }
        }
    }
    return out;
}
function _lvPaint() {
    var a = $('allLvlBtn'), o = $('ordLvlBtn');
    if (a) {
        a.style.background = lvlsOn ? '#2ED573' : 'var(--bg-base)';
        a.style.color = lvlsOn ? 'var(--bg-base)' : '#FFFFFF';
        a.style.borderColor = lvlsOn ? '#2ED573' : '#FFFFFF';
    }
    if (o) {
        o.style.background = lvlsOrd ? '#2ED573' : 'var(--bg-base)';
        o.style.color = lvlsOrd ? 'var(--bg-base)' : '#FFFFFF';
        o.style.borderColor = lvlsOrd ? '#2ED573' : '#FFFFFF';
    }
    document.documentElement.classList.toggle('lvls-on', !!lvlsOn);
}
function toggleLvls() {
    lvlsOn = !lvlsOn;
    renderTables();
}
function toggleOrd() {
    lvlsOrd = !lvlsOrd;
    renderTables();
}
function renderTables() {
    if (!S) return;
    _lvPaint();
    $('peaksTableBodyRev').innerHTML = _buildScannerRowsHtml(_lvPick());
    $('peaksTableBodyMom').innerHTML = _buildScannerRowsHtml([]);
    var _sbEl = document.getElementById('tcSideBar');
    if (_sbEl && !(window.TC && window.TC.on)) _sbEl.style.display = 'none';
}
function renderFilteredTable() { renderTables(); pushFilterCfg(); }
var _cfgPushT = 0;
function pushFilterCfg() {
    clearTimeout(_cfgPushT);
    _cfgPushT = setTimeout(function () {
        var body = { cfg: { minPct: parseFloat($('minPctInput').value) || 0, level: parseInt($('levelFilterSelect').value) || 0, r0Only: !!r0OnlyMode } };
        try { evtLog('INFO', 'FILTER SENDING ' + JSON.stringify(body.cfg)); } catch (eF) {}
        fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (j && j.ok) _trToast('FILTER APPLIED: ' + (j.msg || 'ok'), '#0ecb81');
                else _trToast('FILTER NOT SAVED: ' + ((j && j.error) || 'failed'), '#f6465d');
            })
            .catch(function (e) { _trToast('FILTER NOT SAVED: ' + e.message, '#f6465d'); });
    }, 600);
}
function _r0Paint() {
    var btn = $('r0OnlyBtn');
    if (btn) {
        btn.style.background = r0OnlyMode ? '#2ED573' : 'var(--bg-base)';
        btn.style.color = r0OnlyMode ? 'var(--bg-base)' : '#FFFFFF';
        btn.style.borderColor = r0OnlyMode ? '#2ED573' : '#FFFFFF';
    }
}
function toggleR0Only() {
    r0OnlyMode = !r0OnlyMode;
    _r0Paint();
    renderTables();
    pushFilterCfg();
}

/* ---- streak detail modal ---- */
function openModalApp3(sec) {
    var pad = function (n, s) { return String(n).padStart(s || 2, '0'); };
    $('app3-modalTitle').innerText = 'OFFSET · ' + pad(sec);
    function applyCumulative(hist) {
        var keys = Object.keys(hist).map(Number); var maxS = keys.length ? Math.max.apply(null, keys) : 0;
        var cum = 0; var res = {};
        for (var i = maxS; i >= 1; i--) { cum += (hist[i] || 0); if (cum > 0) res[i] = cum; }
        return res;
    }
    var H = streakHistoryApp3[sec] || { R: {}, G: {} };
    var rHistCum = applyCumulative(Object.assign({}, H.R)), gHistCum = applyCumulative(Object.assign({}, H.G));
    var mapToArrWithPct = function (hist) {
        return Object.keys(hist).map(function (k) {
            var s = parseInt(k), c = hist[k], prevC = hist[s - 1], pct = 'BASE';
            if (s > 1 && prevC) { pct = (100 - Math.round((c / prevC) * 100)) + '%'; }
            return { s: s, c: c, pct: pct };
        }).sort(function (a, b) { return b.s - a.s; });
    };
    function rows(h, col) {
        return mapToArrWithPct(h).map(function (i) {
            return '<div class="app3-modal-stat-row" style="color:var(--accent-' + col + '); align-items:center;"><span style="flex:1; text-align:left;">X' + i.s + '</span><span style="flex:1; text-align:center; font-size:11px; opacity:0.75; font-weight:600;">' + i.pct + '</span><span style="flex:1; text-align:right;">' + i.c + '×</span></div>';
        }).join('') || '<div style="padding:16px;text-align:center;color:#FFFFFF;font-size:10px;">No data</div>';
    }
    $('app3-rD').innerHTML = rows(rHistCum, 'red');
    $('app3-gD').innerHTML = rows(gHistCum, 'green');
    $('app3-modal').style.display = 'flex'; $('app3-modalOverlay').style.display = 'block';
}
function closeModalApp3() { $('app3-modal').style.display = 'none'; $('app3-modalOverlay').style.display = 'none'; }

/* ---- modal helpers ---- */
function _closeModalPair(a, b) { var m = $(a), o = $(b); if (m) m.style.display = 'none'; if (o) o.style.display = 'none'; }
function closeTradeHistory() { _closeModalPair('history-modal', 'history-modalOverlay'); }
function closeEventLog() { _closeModalPair('evtLogModal', 'evtLogOverlay'); }
function openEventLog() { var m = $('evtLogModal'), o = $('evtLogOverlay'); if (m) m.style.display = 'flex'; if (o) o.style.display = 'block'; _evtRender(); _trRenderLists(); }
function openTradeHistory() { var m = $('history-modal'), o = $('history-modalOverlay'); if (m) m.style.display = 'flex'; if (o) o.style.display = 'block'; }

/* ---- event log (feeds the LOG button) ---- */
var _evt = [], _evtFilter = 'ALL', _EVT_RANK = { INFO: 0, WARN: 1, ERROR: 2 };
var _EVT_COL = { INFO: '#E2E8F0', WARN: '#FFD700', ERROR: '#E63946' };
var _evtSrv = [], _evtSrvSeq = 0, _evtSrvBoot = 0;
function _evtAll() {
    return _evt.map(function (e) { return { t: e.t, l: e.l, m: e.m, s: 'APP' }; }).concat(_evtSrv).sort(function (a, b) { return a.t - b.t; });
}
function evtMergeSrv(list, seq, boot) {
    if (boot !== _evtSrvBoot) {
        var fresh = (_evtSrvSeq === 0);
        _evtSrvBoot = boot; _evtSrv = []; _evtSrvSeq = 0;
        if (!fresh) return;
    }
    (list || []).forEach(function (e) {
        if (e.id > _evtSrvSeq) { _evtSrv.push({ t: e.t, l: e.l, m: e.m, s: e.src || 'SRV' }); _evtSrvSeq = e.id; }
    });
    if (_evtSrv.length > 600) _evtSrv.splice(0, _evtSrv.length - 600);
    var b = $('logBtn'); if (b) b.setAttribute('data-n', String(_evt.length + _evtSrv.length));
    _evtRender();
}
window.addEventListener('error', function (ev) { try { evtLog('ERROR', 'JS error: ' + ev.message + ' (' + String(ev.filename || '').split('/').pop() + ':' + ev.lineno + ')'); } catch (e0) {} });
window.addEventListener('unhandledrejection', function (ev) { try { evtLog('ERROR', 'unhandled promise: ' + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason)); } catch (e0) {} });
window.addEventListener('offline', function () { evtLog('WARN', 'browser went offline'); });
window.addEventListener('online', function () { evtLog('INFO', 'browser back online'); });
document.addEventListener('visibilitychange', function () { evtLog('INFO', 'page ' + (document.hidden ? 'hidden' : 'visible')); });
function _evtTs(t) { return new Date(t).toLocaleTimeString([], { hour12: false }); }
function evtLog(level, msg) {
    _evt.push({ t: Date.now(), l: level, m: String(msg) });
    if (_evt.length > 300) _evt.shift();
    var b = $('logBtn'); if (b) b.setAttribute('data-n', String(_evt.length));
    _evtRender();
}
function _evtRender() {
    var body = $('evtLogBody'), foot = $('evtLogFooter');
    var m = $('evtLogModal');
    if (!body || !m || m.style.display !== 'flex') return;
    var min = _EVT_RANK[_evtFilter] || 0;
    var all = _evtAll();
    var rows = all.filter(function (e) { return _EVT_RANK[e.l] >= min; });
    body.innerHTML = rows.slice().reverse().map(function (e) {
        return '<div>' + _evtTs(e.t) + ' <span style="color:' + _EVT_COL[e.l] + ';">' + e.l + '</span> <span style="color:#888;">' + (e.s || 'APP') + '</span> ' + _esc(e.m) + '</div>';
    }).join('') || '<div>No events</div>';
    if (foot) foot.textContent = rows.length + ' / ' + all.length + ' events';
}
function evtSetFilter(f) {
    _evtFilter = f;
    var map = { ALL: 'evtFltAll', WARN: 'evtFltWarn', ERROR: 'evtFltErr' };
    Object.keys(map).forEach(function (k) {
        var b = $(map[k]); if (!b) return;
        b.style.background = (k === f) ? 'var(--accent-green)' : 'var(--bg-base)';
    });
    _evtRender();
}
function clearEventLog() { _evt = []; _evtSrv = []; var b = $('logBtn'); if (b) b.setAttribute('data-n', ''); _evtRender(); }
function copyEventLog() {
    var text = _evtAll().map(function (e) { return _evtTs(e.t) + ' ' + e.l + ' [' + (e.s || 'APP') + '] ' + e.m; }).join('\n');
    function done(ok) { _trToast(ok ? 'LOG COPIED' : 'COPY FAILED', ok ? '#0ecb81' : '#f6465d'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
        var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
        var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta); done(ok);
    }
}

/* ---- single-pair build: the pair button just says which pair this is ---- */
var tcToggle = function () {};  /* replaced by tickchart.js */
function openPairSelectPopup() { _trToast('SINGLE PAIR: ' + getPairDisplayName(activePair), '#FFD700'); }

/* ---- DEMO trading: the server holds the Deriv login, this page never sees the token ---- */
var _trAcct = null, _trBusy = false, _trPollTimer = null, _trLastErr = null;
function _trEl(id) { return document.getElementById(id); }
function _trMoney(n) { return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _trTime(t) { return t ? new Date(t * 1000).toLocaleTimeString([], { hour12: false }) : '--'; }
function _trToast(msg, bg) {
    evtLog(bg === '#f6465d' ? 'ERROR' : (bg === '#FFD700' ? 'WARN' : 'INFO'), msg);
    var old = _trEl('_trToast');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var t = document.createElement('div');
    t.id = '_trToast';
    t.innerText = msg;
    t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:' + (window.pairColorHex || bg) + ';color:#000432;padding:10px 20px;font-size:12px;font-weight:800;border-radius:4px;z-index:9999;box-shadow:0 0 10px rgba(0,0,0,0.5);font-family:monospace;max-width:90vw;';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2500);
}
function _trPaintBalance() {
    var b = _trEl('accountBalance');
    if (!b || !_trAcct) return;
    if (!_trAcct.enabled) { b.innerText = 'TRADE OFF'; b.title = 'Trading disabled: set DERIV_PAT / DERIV_APP_ID (and APP_PASSWORD on a public host)'; return; }
    b.title = 'DEMO account';
    if (_trAcct.balance === null || _trAcct.balance === undefined) { b.innerText = _trAcct.error ? 'ERR' : '...'; return; }
    b.innerText = (_trAcct.currency === 'USD' ? '$' : _trAcct.currency + ' ') + _trMoney(_trAcct.balance);
}
function _trRenderLists() {
    var hm = _trEl('evtLogModal');
    if (!hm || hm.style.display !== 'flex' || !_trAcct) return;
    var ol = _trEl('evtOpenList'), cl = _trEl('evtClosedList');
    var none = function (t) { return '<div style="color:#555; text-align:center; padding:15px; font-size:10px; font-weight:800; letter-spacing:1px;">' + t + '</div>'; };
    var sym = function (s) { return _esc(String(s).replace(/^(frx|cry|1HZ)/i, '')); };
    var card = 'padding:8px; border:1px solid #333; margin-bottom:6px; border-radius:2px; font-size:11px; font-weight:700; display:flex; flex-direction:column; gap:6px;';
    var row = 'display:flex; justify-content:space-between; font-size:10px; color:#888;';
    if (ol) {
        var o = _trAcct.open || [];
        ol.innerHTML = !o.length ? none('NO OPEN POSITIONS') : o.map(function (c) {
            return '<div style="' + card + ' background: rgba(0, 176, 255, 0.05);">' +
                '<div style="display:flex; justify-content:space-between; align-items:center;"><div style="color:#E2E8F0; font-size:12px;">' + _esc(c.type) + ' <span style="color:#00B0FF;">' + sym(c.symbol) + '</span></div><div style="color:#FFD700; font-size:9px;">ID: ' + _esc(c.contract_id) + '</div></div>' +
                '<div style="' + row + '"><div>OPEN: <span style="color:#FFF;">' + _trTime(c.open_time) + '</span></div><div>STAKE: <span style="color:#FFF;">$' + _trMoney(c.stake) + '</span></div></div>' +
                '<div style="' + row + '"><div>EXPIRES: <span style="color:#FFF;">' + _trTime(c.exp_time) + '</span></div><div>PAYOUT: <span style="color:#FFF;">$' + _trMoney(c.payout_amt) + '</span></div></div></div>';
        }).join('');
    }
    if (cl) {
        var h = _trAcct.closed || [];
        cl.innerHTML = !h.length ? none('NO RECENT HISTORY') : h.map(function (t) {
            var known = (t.pnl !== null && t.pnl !== undefined);
            var win = known && t.pnl > 0;
            var col = !known ? '#888' : (win ? '#2ED573' : '#E63946');
            var pnlTxt = known ? ((win ? '+' : (t.pnl < 0 ? '-' : '')) + '$' + _trMoney(Math.abs(t.pnl))) : '?';
            return '<div style="' + card + ' background: rgba(255, 255, 255, 0.02);">' +
                '<div style="display:flex; justify-content:space-between; align-items:center;"><div style="color:#E2E8F0; font-size:12px;">' + _esc(t.type) + ' <span style="color:#FFD700;">' + sym(t.symbol) + '</span></div><div style="color:' + col + '; font-weight:800; font-size:13px;">' + pnlTxt + '</div></div>' +
                '<div style="' + row + '"><div>OPEN: <span style="color:#FFF;">' + _trTime(t.open_time) + '</span></div><div>STAKE: <span style="color:#FFF;">$' + _trMoney(t.stake) + '</span></div></div>' +
                '<div style="' + row + '"><div>CLOSE: <span style="color:#FFF;">' + _trTime(t.close_time) + '</span></div><div>PAYOUT: <span style="color:' + col + ';">' + (known ? '$' + _trMoney(t.payout) : 'UNKNOWN') + '</span></div></div></div>';
        }).join('');
    }
}
var _afOne = null, _afOneTimer = null, _afKey = '', _afSeen = null;
var _afCol = { miss: '#FF9800', active: '#FFD700', win: '#2ED573', loss: '#E63946' };
function _afColor(k) {
    if (k === 'win' || k === 'profit') return '#00FF00';
    if (k === 'loss') return '#FF0000';
    if (k === 'miss') return '#FFFF00';
    if (k === 'hit' || k === 'fire' || k === 'fired' || k === 'signal' || k === 'sig') return '#00FFFF';
    return _afCol[k] || '#FFFFFF';
}
function _afApply() {
    var el = document.getElementById('appFlash'), tx = document.getElementById('appFlashTxt'), kind = '', msg = '', key, col, st;
    if (!el || !tx) {
        st = document.createElement('style');
        st.textContent = '@keyframes afPulse{0%,100%{opacity:0}50%{opacity:0.45}}' +
            '@keyframes afPulseD{0%,100%{opacity:0}50%{opacity:1}}' +
            '#appFlashDock{position:absolute;top:0;left:0;right:0;bottom:0;border-radius:inherit;pointer-events:none;opacity:0;display:none;z-index:20;box-sizing:border-box;}' +
            '#appFlashDockTxt{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:21;pointer-events:none;display:none;padding:5px 16px;border-radius:999px;color:#000432;-webkit-text-fill-color:#000432;font-family:"JetBrains Mono",monospace;font-size:12px;font-weight:800;letter-spacing:0.5px;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;box-sizing:border-box;box-shadow:0 0 0 1.5px #000432;}' +
            '#appFlash{position:fixed;top:0;left:0;width:100%;height:100%;z-index:9000;pointer-events:none;opacity:0;display:none;box-sizing:border-box;}' +
            '#appFlashTxt{position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:9001;pointer-events:none;display:none;padding:8px 18px;border-radius:999px;color:#000432;font-family:"JetBrains Mono",monospace;font-size:13px;font-weight:800;letter-spacing:1px;max-width:92vw;text-align:center;box-shadow:0 0 12px rgba(0,0,0,0.5);}';
        document.head.appendChild(st);
        el = document.createElement('div'); el.id = 'appFlash';
        tx = document.createElement('div'); tx.id = 'appFlashTxt';
        document.body.appendChild(el);
        document.body.appendChild(tx);
    }
    if (_afOne) { kind = _afOne.kind; msg = _afOne.msg; }
    if (!kind) {
        var fd0 = document.getElementById('appFlashDock'), ft0 = document.getElementById('appFlashDockTxt');
        if (fd0) fd0.style.display = 'none';
        if (ft0) ft0.style.display = 'none';
        el.style.display = 'none'; tx.style.display = 'none'; _afKey = '';
        return;
    }
    key = kind + '|' + msg + '|' + (_afOne ? _afOne.t : 0);
    if (key === _afKey) return;
    _afKey = key;
    col = _afColor(kind);
    var dk = document.getElementById('tcDock'), fd = document.getElementById('appFlashDock');
    if (dk && dk.offsetWidth > 0) {
        if (!fd) { fd = document.createElement('div'); fd.id = 'appFlashDock'; }
        if (fd.parentNode !== dk) dk.appendChild(fd);
        el.style.display = 'none';
        fd.style.background = col;
        fd.style.display = 'block';
        fd.style.animation = 'none';
        void fd.offsetWidth;
        fd.style.animation = _afOne ? 'afPulseD 0.8s ease-in-out 3' : 'afPulseD 1s ease-in-out infinite';
    } else {
        if (fd) fd.style.display = 'none';
        el.style.background = col;
        el.style.boxShadow = 'inset 0 0 0 10px ' + col;
        el.style.display = 'block';
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = _afOne ? 'afPulse 0.8s ease-in-out 3' : 'afPulse 1s ease-in-out infinite';
    }
    var ft = document.getElementById('appFlashDockTxt');
    if (dk && dk.offsetWidth > 0) {
        if (!ft) { ft = document.createElement('div'); ft.id = 'appFlashDockTxt'; }
        if (ft.parentNode !== dk) dk.appendChild(ft);
        ft.textContent = msg;
        ft.style.background = col;
        ft.style.display = msg ? 'block' : 'none';
        tx.style.display = 'none';
    } else {
        if (ft) ft.style.display = 'none';
        tx.textContent = msg;
        tx.style.background = col;
        tx.style.display = 'block';
    }
}
function appFlash(kind, msg) {
    _afOne = { kind: kind, msg: msg || '', t: Date.now() };
    if (_afOneTimer) clearTimeout(_afOneTimer);
    _afOneTimer = setTimeout(function () { _afOne = null; _afOneTimer = null; _afApply(); }, 2600);
    try { evtLog(kind === 'miss' ? 'WARN' : 'INFO', msg || kind); } catch (e) {}
    _afApply();
}
function _afOnAccount(j) {
    var cl, n, t, k, last = null, first = (_afSeen === null), pv;
    if (j && j.enabled && Array.isArray(j.closed)) {
        if (first) _afSeen = {};
        cl = j.closed;
        for (n = 0; n < cl.length; n++) {
            t = cl[n];
            if (t.pnl === null || t.pnl === undefined) continue;
            k = [t.contract_id || '', t.open_time, t.close_time, t.symbol, t.type, t.stake].join('|');
            if (_afSeen[k]) continue;
            _afSeen[k] = 1;
            if (first) continue;
            if (t.close_time && t.close_time * 1000 < Date.now() - 60000) continue;
            if (!last || (t.close_time || 0) >= (last.close_time || 0)) last = t;
        }
        if (last) {
            pv = Number(last.pnl);
            if (pv !== 0) evtLog(pv > 0 ? 'INFO' : 'WARN', (pv > 0 ? 'WIN +$' : 'LOSS -$') + _trMoney(Math.abs(pv)));
        }
    }
    _afApply();
}
window.afHit = function (t0) {
    setTimeout(function () {
        _trPoll().then(function () {
            var a = _trAcct, all, n, ok = false, why = '';
            if (!a) why = 'ACCOUNT NOT READY';
            else if (!a.enabled) why = 'TRADING DISABLED';
            else {
                all = (a.open || []).concat(a.closed || []);
                for (n = 0; n < all.length; n++) {
                    if (all[n].open_time * 1000 >= t0 - 6000) { ok = true; break; }
                }
                if (ok) return;
                why = (a.balance === null || a.balance === undefined) ? 'ACCOUNT NOT READY' : 'REQUIREMENTS NOT MET';
            }
            appFlash('miss', 'TRADE MISSED - ' + why);
        });
    }, 7000);
};
function _trPaintPayout(j) {
    var q = j ? j.quote : null, t = '', old = document.getElementById('payoutPill'), c;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (q && q.age < 60 && q.pct !== undefined && !q.error && (!S || !S.symbol || q.sym === S.symbol)) t = q.pct + '%';
    window._payTxt = t;
    c = document.querySelector('#tcParamBar .pmE[data-k="symbol"] .pmV');
    if (c && S && S.symbol) c.textContent = getPairDisplayName(S.symbol) + t;
}
function _trPaintPayoutOld(j) {
    /*
    var pb = document.getElementById('pairHubBtn')
==== FILE: tickchart.js ====
                if (k === 'symbol') return v ? ceName(v) : '--';
===SPLIT===
                if (k === 'symbol') return v ? ceName(v) + (window._payTxt || '') : '--';*/
    var pb = document.getElementById('pairHubBtn'), el = document.getElementById('payoutPill'), q = j ? j.quote : null, txt = 'PAY --', tip = 'Deriv payout (waiting for quote)';
    if (!pb || !pb.parentNode) return;
    if (!el) {
        el = document.createElement('span');
        el.id = 'payoutPill';
        el.style.cssText = 'flex:0 0 auto !important;display:inline-flex !important;align-items:center;justify-content:center;height:28px !important;min-width:56px;padding:0 8px;box-sizing:border-box;background:var(--pair-color,#E2E8F0) !important;color:#000432 !important;-webkit-text-fill-color:#000432 !important;font-family:JetBrains Mono,monospace;font-size:12px;font-weight:800;white-space:nowrap;border-radius:0 !important;border:none !important;';
        pb.parentNode.insertBefore(el, pb.nextSibling);
    }
    if (q && q.age < 60 && (!S || !S.symbol || q.sym === S.symbol)) {
        if (q.error) { tip = 'Deriv: ' + q.error; }
        else if (q.pct !== undefined) { txt = 'PAY ' + q.pct + '%'; tip = 'Deriv payout ' + q.pct + '% - stake $' + q.stake + ' pays $' + q.payout + ' (' + q.dur + 's)'; }
    }
    el.textContent = txt;
    el.title = tip;
}
function _trPoll() {
    var _qe = _trEl('tradeExpiryVisible'), _qa = _trEl('tradeAmount');
    return fetch('/api/account?dur=' + encodeURIComponent((S && S.cfg && S.cfg.minC) ? S.cfg.minC : (_qe ? _qe.value : '')) + '&amt=' + encodeURIComponent((S && S.cfg && S.cfg.autoStake) ? S.cfg.autoStake : (_qa ? _qa.value : '')), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
            _trAcct = j;
            try { _afOnAccount(j); } catch (eA) { console.error(eA); }
            if (j.error !== _trLastErr) { _trLastErr = j.error; if (j.error) evtLog('WARN', 'account: ' + j.error); }
            _trPaintBalance();
            try { _trPaintPayout(j); } catch (eP) { console.error(eP); }
            if (!j.enabled) { if (_trPollTimer) { clearInterval(_trPollTimer); _trPollTimer = null; } return; }
            _trRenderLists();
        })
        .catch(function () {});
}
function _trPostTrade(type, amt, exp, auto) {
    var tag = auto ? 'AUTO ' : '';
    return fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, symbol: S.symbol, amount: amt, duration: exp })
    })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'bad response from server' }; }); })
        .then(function (j) {
            if (j && j.ok) {
                evtLog('INFO', tag + type + ' trade placed id=' + j.trade.contract_id + ' stake=' + j.trade.stake + ' exp=' + j.trade.duration + 's');
                _trToast(tag + type + ' PLACED [$' + _trMoney(j.trade.stake) + '] ' + String(j.trade.symbol).replace(/^(frx|cry|1HZ)/i, ''), type === 'CALL' ? '#0ecb81' : '#f6465d');
                _trPoll();
            } else {
                evtLog('ERROR', tag + type + ' trade rejected: ' + ((j && j.error) || 'unknown error'));
                appFlash('miss', 'TRADE MISSED - ' + ((j && j.error) || 'REJECTED'));
                _trToast(tag + 'REJECTED: ' + ((j && j.error) || 'unknown error'), '#f6465d');
            }
        })
        .catch(function () { evtLog('ERROR', tag + type + ' trade network error - not confirmed, check HIST'); appFlash('miss', 'TRADE MISSED - NETWORK ERROR'); _trToast(tag + 'NETWORK ERROR - TRADE NOT CONFIRMED, CHECK HIST', '#f6465d'); });
}
function executeTrade(type) {
    var amtEl = _trEl('tradeAmount'), expEl = _trEl('tradeExpiryVisible');
    var amt = parseFloat(amtEl ? amtEl.value : ''), exp = parseInt(expEl ? expEl.value : '', 10);
    if (!(amt > 0)) { evtLog('WARN', 'manual ' + type + ' blocked: invalid amount'); _trToast('INVALID TRADE AMOUNT', '#FFD700'); return; }
    if (!(exp >= 1)) { evtLog('WARN', 'manual ' + type + ' blocked: invalid expiry'); _trToast('INVALID EXPIRY', '#FFD700'); return; }
    if (!S || !S.symbol) { evtLog('WARN', 'manual ' + type + ' blocked: no data yet'); _trToast('NOT READY - WAIT FOR DATA', '#FFD700'); return; }
    if (_trBusy) { evtLog('WARN', 'manual ' + type + ' blocked: trade already in progress'); _trToast('TRADE IN PROGRESS', '#FFD700'); return; }
    evtLog('INFO', 'manual ' + type + ' clicked: stake=' + amt + ' exp=' + exp + 's');
    _trBusy = true;
    _trPostTrade(type, amt, exp, false).then(function () { _trBusy = false; });
}
function autoFire(type, secs) {
    var amtEl = _trEl('tradeAmount');
    var amt = parseFloat(amtEl ? amtEl.value : ''), exp = parseInt(secs, 10);
    if (!(amt > 0) || !(exp >= 1) || !S || !S.symbol) { _trToast('AUTO: NOT READY', '#FFD700'); return; }
    _trPostTrade(type, amt, exp, true);
}
function toggleAccountType() { _trToast('DEMO ACCOUNT ONLY', '#FFD700'); }
var _trOpenHist = openTradeHistory;
openTradeHistory = function () { _trOpenHist(); _trRenderLists(); _trPoll(); };
_trPoll(); _trPollTimer = setInterval(_trPoll, 2000);

/* ---- boot overlay ---- */
function bootUpdate() {
    if (_bootGone || !S) return;
    var tile = $('bootPairGrid'), logs = $('bootLogLines');
    var st = S.scan ? 'done' : (S.ticks > 0 ? 'fetching' : 'wait');
    var icon = st === 'done' ? '●' : (st === 'fetching' ? '◑' : '○');
    var col = tcPairColor(S.symbol);
    tile.innerHTML = '<div data-pc="1" data-st="' + st + '" style="--pbg:' + col + ';--pfg:#000432;--pbc:' + col + ';padding:6px 4px;border:1px solid ' + col + ';background:' + col + ';border-radius:2px;color:#000432;text-align:center;white-space:nowrap;overflow:hidden;font-size:10px;font-weight:800;letter-spacing:0.3px;font-family:\'JetBrains Mono\',monospace;">' + icon + ' ' + getPairDisplayName(S.symbol) + '</div>';
    var L = [S.status || '', 'TICKS ' + S.ticks + ' / ' + S.len];
    if (S.error) L.push('ERROR: ' + S.error);
    if (S.scan) L.push('SCAN READY - ' + S.scan.qualified + '/' + S.scan.total + ' signals');
    logs.innerHTML = L.map(function (t) { return '<div style="font-size:10px;font-weight:700;padding:1px 0;font-family:\'JetBrains Mono\',monospace;">' + _esc(t) + '</div>'; }).join('');
    if (S.scan) bootDone();
}
function bootDone() {
    var o = $('bootOverlay'); if (!o || _bootGone) return; _bootGone = true;
    o.style.transition = 'opacity 0.6s ease'; o.style.opacity = '0'; setTimeout(function () { o.remove(); }, 650);
}
$('bootOverlay').addEventListener('click', function () { if (Date.now() - _bootT0 > 3000) bootDone(); });

/* ---- polling ---- */
var _backendDown = false, _lastStatus = '', _lastErr = null;
async function poll() {
    try {
        var r = await fetch('/api/state?evt=' + _evtSrvSeq, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        S = await r.json();
        if (_backendDown) { _backendDown = false; evtLog('INFO', 'backend reachable again'); }
    } catch (e) {
        if (!_backendDown) { _backendDown = true; evtLog('ERROR', 'backend not reachable: ' + e.message); }
        var l = $('bootLogLines'); if (l) l.innerHTML = '<div style="font-size:10px;font-weight:700;">backend not reachable - is the server still running?</div>';
        return;
    }
    try { applyState(); } catch (e2) { console.error(e2); evtLog('ERROR', 'page error: ' + e2.message); var l2 = $('bootLogLines'); if (l2) l2.innerHTML = '<div style="font-size:10px;font-weight:700;">PAGE ERROR: ' + _esc(e2.message) + '</div>'; }
}
var _firstState = true;
function applyState() {
    activePair = S.symbol;
    currentStartTsUtc = S.start;
    var _cfgSig = [S.cfg.level, S.cfg.minPct, S.cfg.minC, S.cfg.maxC, S.cfg.session, S.cfg.r0Only].join('|');
    var _cfgChg = !_firstState && window._cfgSigLast !== undefined && _cfgSig !== window._cfgSigLast;
    window._cfgSigLast = _cfgSig;
    if (_cfgChg || _firstState) {
        try { evtLog('INFO', 'SERVER CONFIG NOW: min%=' + S.cfg.minPct + ' level=' + (S.cfg.level ? 'X' + S.cfg.level + '-X' + (S.cfg.level + 1) : 'ALL') + ' r0=' + !!S.cfg.r0Only + ' cycles=' + S.cfg.minC + '-' + S.cfg.maxC + ' scan=' + S.cfg.interval + 's session=' + S.cfg.session + 's stake=$' + S.cfg.autoStake + ' pair=' + S.symbol); } catch (eC) {}
    }
    if (_firstState || _cfgChg) {
        _firstState = false;
        $('levelFilterSelect').value = String(S.cfg.level || 0);
        $('minPctInput').value = S.cfg.minPct;
        r0OnlyMode = !!S.cfg.r0Only; _r0Paint();
        $('scanMin').value = S.cfg.minC; $('scanMax').value = S.cfg.maxC;
        $('sessionLengthSelect').innerHTML = '<option>' + _fmtLenLabel(Math.round(S.len / 60)) + '</option>';
        CYCLE = S.cfg.minC; $('cycleInput').value = CYCLE;
        var tp = S.scan && S.scan.top && S.scan.top[0]; if (tp) CYCLE = tp.c;
    }
    _lastStatus = S.status; _lastErr = S.error;
    try { evtMergeSrv(S.evt, S.evtSeq, S.evtBoot); } catch (eV) { console.error(eV); }
    var key = [S.start, S.ticks, S.maxidx, S.lastTick, CYCLE].join('|');
    if (key !== _lastKey) {
        _lastKey = key;
        buildAll();
        if (followLive) jumpToLive();
    }
    renderTables();
    try { if (window.tcOnData) window.tcOnData(); } catch (e) { console.error(e); }
    var sc = S.scan;
    var t = sc ? Math.max(0, (S.cfg.interval || 300) - (S.now - sc.at)) : 0;
    var el = $('scanTimerDisplay'); if (el) el.textContent = sc ? (t > 0 ? t + 's' : 'SCAN') : '--';
    bootUpdate();
}
setInterval(poll, 1000); poll();
setInterval(function () { if (S) requestDraw(); }, 1000);

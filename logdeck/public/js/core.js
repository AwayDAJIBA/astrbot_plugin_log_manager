(function () {
  'use strict';
  var LD = (window.LD = window.LD || {});
  var BOOT = window.__LOGDECK_BOOT__ || {};
  LD.BOOT = BOOT;
  LD.TOKEN = BOOT.token || '';

  LD.$ = function (sel, root) { return (root || document).querySelector(sel); };
  LD.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  LD.esc = function (value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  LD.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  LD.fmtTs = function (ts) {
    var d = new Date(ts || Date.now());
    return LD.pad2(d.getHours()) + ':' + LD.pad2(d.getMinutes()) + ':' + LD.pad2(d.getSeconds());
  };

  LD.fmtDuration = function (ms) {
    var sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (sec < 60) return sec + '秒';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + '分' + (sec % 60) + '秒';
    var hour = Math.floor(min / 60);
    if (hour < 24) return hour + '时' + (min % 60) + '分';
    return Math.floor(hour / 24) + '天' + (hour % 24) + '时';
  };

  LD.fmtBytes = function (bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  };

  LD.STATUS = {
    running: '运行中',
    starting: '启动中',
    stopping: '停止中',
    stopped: '已停止',
    exited: '已退出',
    crashed: '已崩溃',
    error: '错误'
  };

  LD.statusText = function (status) { return LD.STATUS[status] || status || '未知'; };

  LD.stripPlain = function (text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[@-_]/g, '')
      .replace(/\r/g, '');
  };

  function severityOf(token) {
    var value = String(token || '').toUpperCase();
    if (value === 'ERRO' || value === 'ERROR' || value === 'FATAL' || value === 'CRIT' || value === 'CRITICAL') return 'error';
    if (value === 'WARN' || value === 'WARNING' || value === 'WRN') return 'warn';
    if (value === 'INFO' || value === 'INFM' || value === 'NOTICE') return 'info';
    if (value === 'DEBU' || value === 'DEBUG' || value === 'TRACE') return 'debug';
    return '';
  }

  LD.detectSeverity = function (text) {
    var plain = LD.stripPlain(text);
    if (!plain) return '';
    var match = plain.match(/\[(ERRO|ERROR|FATAL|CRIT|CRITICAL|WARN|WARNING|WRN|INFO|INFM|NOTICE|DEBU|DEBUG|TRACE)\]/i);
    if (match) return severityOf(match[1]);
    match = plain.match(/^(?:[\[\(]?\d{1,4}[-:/.\d\s,]*[\]\)]?\s*)?(ERRO|ERROR|FATAL|CRITICAL|WARN|WARNING|INFO|DEBUG|TRACE)\b(?=\s|:|\])/);
    if (match) return severityOf(match[1]);
    match = plain.match(/(?:^|\s)(ERRO|ERROR|FATAL|CRITICAL|WARN|WARNING|INFO|DEBUG|TRACE)\b\s*[:\-]/);
    if (match) return severityOf(match[1]);
    if (/Traceback \(most recent call last\)|Unhandled exception|^[A-Za-z_.]+(?:Error|Exception):/.test(plain)) return 'error';
    return '';
  };

  LD.api = async function (path, options) {
    var opts = options ? Object.assign({}, options) : {};
    var headers = Object.assign({ 'X-LogDeck-Token': LD.TOKEN }, opts.headers || {});
    if (opts.body !== undefined && typeof opts.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    opts.headers = headers;
    var res = await fetch(path, opts);
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok || (data && data.ok === false)) {
      var message = (data && data.error) || ('HTTP ' + res.status);
      throw new Error(message);
    }
    return data;
  };

  LD.DEFAULT_SETTINGS = {
    theme: 'dark',
    fontSize: 13,
    showTs: true,
    maxLines: 2000,
    wrap: true,
    autoScroll: true
  };

  LD.state = {
    sessions: new Map(),
    sessionOrder: [],
    views: [],
    activeViewId: null,
    compareSet: new Set(),
    compareMode: false,
    settings: Object.assign({}, LD.DEFAULT_SETTINGS),
    connected: false,
    serverInfo: null,
    booted: false
  };

  var LS_SETTINGS = 'logdeck.settings.v1';
  var LS_VIEWS = 'logdeck.views.v2';

  LD.loadSettings = function () {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
      Object.assign(LD.state.settings, LD.DEFAULT_SETTINGS, raw || {});
    } catch (e) { /* ignore */ }
  };

  LD.saveSettings = function () {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(LD.state.settings)); } catch (e) { /* ignore */ }
  };

  LD.applySettings = function () {
    var s = LD.state.settings;
    document.documentElement.setAttribute('data-theme', s.theme === 'light' ? 'light' : 'dark');
    document.documentElement.style.setProperty('--log-font-size', String(s.fontSize) + 'px');
  };

  LD.newPane = function (sessionId) {
    return {
      sessionId: sessionId || null,
      lines: [],
      seq: 0,
      follow: true,
      filter: '',
      paused: false,
      pending: 0,
      dom: null
    };
  };

  LD.newView = function (layout, ids) {
    var count = Math.max(1, Math.min(4, Number(layout) || 1));
    var panes = [];
    for (var i = 0; i < count; i += 1) {
      panes.push(LD.newPane(ids && ids[i] ? ids[i] : null));
    }
    return {
      id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      layout: count,
      panes: panes,
      activePane: 0
    };
  };

  LD.activeView = function () {
    var views = LD.state.views;
    for (var i = 0; i < views.length; i += 1) {
      if (views[i].id === LD.state.activeViewId) return views[i];
    }
    return null;
  };

  LD.sessionById = function (id) { return id ? LD.state.sessions.get(id) || null : null; };

  LD.saveViews = function () {
    try {
      var data = {
        activeViewId: LD.state.activeViewId,
        views: LD.state.views.map(function (view) {
          return {
            id: view.id,
            layout: view.layout,
            activePane: view.activePane,
            panes: view.panes.map(function (pane) {
              return {
                sessionId: pane.sessionId,
                filter: pane.filter,
                follow: pane.follow
              };
            })
          };
        })
      };
      localStorage.setItem(LS_VIEWS, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  };

  function pickDefaultIds() {
    var all = LD.state.sessionOrder.map(function (id) { return LD.state.sessions.get(id); }).filter(Boolean);
    var running = all.filter(function (s) { return s.status === 'running'; });
    var chosen = running.length >= 2 ? running : all;
    return chosen.slice(0, 4).map(function (s) { return s.id; });
  }

  LD.restoreViews = function () {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_VIEWS) || 'null'); } catch (e) { raw = null; }
    var views = [];
    if (raw && Array.isArray(raw.views) && raw.views.length) {
      views = raw.views.map(function (item) {
        var layout = Math.max(1, Math.min(4, Number(item.layout) || 1));
        var panes = [];
        for (var i = 0; i < layout; i += 1) {
          var src = item.panes && item.panes[i] ? item.panes[i] : {};
          var pane = LD.newPane(src.sessionId || null);
          pane.filter = src.filter || '';
          pane.follow = src.follow !== false;
          if (pane.sessionId && !LD.state.sessions.has(pane.sessionId)) pane.sessionId = null;
          panes.push(pane);
        }
        return {
          id: item.id || ('v' + Math.random().toString(36).slice(2, 8)),
          layout: layout,
          panes: panes,
          activePane: Math.max(0, Math.min(layout - 1, Number(item.activePane) || 0))
        };
      });
    }
    if (!views.length) {
      var ids = pickDefaultIds();
      var view = LD.newView(ids.length > 1 ? Math.min(ids.length, 2) : 1, ids);
      views = [view];
    }
    LD.state.views = views;
    var wanted = raw && raw.activeViewId;
    var found = views.filter(function (v) { return v.id === wanted; })[0];
    LD.state.activeViewId = found ? found.id : views[0].id;
  };

  LD.toast = function (message, type) {
    var root = LD.$('#toast-root');
    if (!root) return;
    var node = document.createElement('div');
    node.className = 'toast ' + (type || 'info');
    node.textContent = message;
    root.appendChild(node);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 260);
    }, type === 'error' ? 5200 : 3200);
  };

  LD.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      LD.toast('已复制到剪贴板', 'success');
    } catch (e) {
      var input = document.createElement('textarea');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      try { document.execCommand('copy'); LD.toast('已复制到剪贴板', 'success'); } catch (err) { LD.toast('复制失败', 'error'); }
      input.remove();
    }
  };

  LD.confirm = function (title, message, danger) {
    return window.confirm((title ? title + '\n\n' : '') + message);
  };

  /* ---------------- ANSI -> HTML ---------------- */
  var FG = {
    30: '#5b6472', 31: '#ff6b81', 32: '#3ecf8e', 33: '#f0c64a', 34: '#5ea1ff', 35: '#c678dd', 36: '#56d4dd', 37: '#d8e2ee',
    90: '#7c8ba1', 91: '#ff8a9a', 92: '#6ee7b7', 93: '#f7d774', 94: '#7fb6ff', 95: '#d8b4fe', 96: '#7ce7ee', 97: '#ffffff'
  };
  var BG = {
    40: '#2a3342', 41: '#5c2431', 42: '#1d4a37', 43: '#5a4a17', 44: '#1d3a5f', 45: '#4a255e', 46: '#174a50', 47: '#3a4554',
    100: '#3a4554', 101: '#7a3040', 102: '#2a5f47', 103: '#6d5a1e', 104: '#2a4a72', 105: '#5b3172', 106: '#1f5c63', 107: '#4b5868'
  };
  var BASIC_256 = ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0', '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff'];

  function color256(n) {
    var value = Number(n) || 0;
    if (value < 16) return BASIC_256[value] || '#ffffff';
    if (value < 232) {
      var v = value - 16;
      var r = Math.floor(v / 36);
      var g = Math.floor((v % 36) / 6);
      var b = v % 6;
      var conv = function (x) { return x === 0 ? 0 : 55 + x * 40; };
      return 'rgb(' + conv(r) + ',' + conv(g) + ',' + conv(b) + ')';
    }
    var gray = 8 + (value - 232) * 10;
    return 'rgb(' + gray + ',' + gray + ',' + gray + ')';
  }

  LD.ansiToHtml = function (input) {
    var text = String(input === undefined || input === null ? '' : input);
    if (!text) return '';
    var out = '';
    var fg = null;
    var bg = null;
    var bold = false;
    var dim = false;
    var italic = false;
    var underline = false;
    var strike = false;
    var inverse = false;
    var buf = '';

    function styleText() {
      var foreground = inverse ? bg : fg;
      var background = inverse ? fg : bg;
      var styles = [];
      if (foreground) styles.push('color:' + foreground);
      if (background) styles.push('background-color:' + background);
      if (bold) styles.push('font-weight:600');
      if (dim) styles.push('opacity:.66');
      if (italic) styles.push('font-style:italic');
      if (underline) styles.push('text-decoration:underline');
      if (strike) styles.push('text-decoration:line-through');
      return styles.join(';');
    }

    function emit() {
      if (!buf) return;
      var style = styleText();
      out += style ? '<span style="' + style + '">' + LD.esc(buf) + '</span>' : LD.esc(buf);
      buf = '';
    }

    function reset() {
      fg = null; bg = null; bold = false; dim = false; italic = false;
      underline = false; strike = false; inverse = false;
    }

    function applySgr(params) {
      var codes = params ? params.split(';') : ['0'];
      for (var k = 0; k < codes.length; k += 1) {
        var code = parseInt(codes[k], 10);
        if (isNaN(code)) code = 0;
        if (code === 0) { reset(); }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 3) italic = true;
        else if (code === 4) underline = true;
        else if (code === 7) inverse = true;
        else if (code === 9) strike = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (code === 23) italic = false;
        else if (code === 24) underline = false;
        else if (code === 27) inverse = false;
        else if (code === 29) strike = false;
        else if (code >= 30 && code <= 37) fg = FG[code];
        else if (code >= 90 && code <= 97) fg = FG[code];
        else if (code >= 40 && code <= 47) bg = BG[code];
        else if (code >= 100 && code <= 107) bg = BG[code];
        else if (code === 39) fg = null;
        else if (code === 49) bg = null;
        else if (code === 38 || code === 48) {
          var mode = parseInt(codes[k + 1], 10);
          if (mode === 5) {
            var value = color256(parseInt(codes[k + 2], 10));
            if (code === 38) fg = value; else bg = value;
            k += 2;
          } else if (mode === 2) {
            var color = 'rgb(' + (parseInt(codes[k + 2], 10) || 0) + ',' + (parseInt(codes[k + 3], 10) || 0) + ',' + (parseInt(codes[k + 4], 10) || 0) + ')';
            if (code === 38) fg = color; else bg = color;
            k += 4;
          }
        }
      }
    }

    var i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch === '\u001b') {
        emit();
        var next = text.charAt(i + 1);
        if (next === '[') {
          var j = i + 2;
          while (j < text.length && !/[@-~]/.test(text.charAt(j))) j += 1;
          if (j >= text.length) break;
          var finalCh = text.charAt(j);
          var params = text.slice(i + 2, j);
          i = j + 1;
          if (finalCh === 'm') applySgr(params);
          continue;
        }
        if (next === ']') {
          var k = i + 2;
          while (k < text.length) {
            if (text.charAt(k) === '\u0007') { k += 1; break; }
            if (text.charAt(k) === '\u001b' && text.charAt(k + 1) === '\\') { k += 2; break; }
            k += 1;
          }
          i = k;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === '\r' || ch === '\b' || ch === '\u0007') { i += 1; continue; }
      buf += ch;
      i += 1;
    }
    emit();
    return out;
  };
})();

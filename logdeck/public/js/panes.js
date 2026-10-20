(function () {
  'use strict';
  var LD = window.LD;
  if (!LD) return;

  function paneHeaderHtml(pane) {
    var session = pane.sessionId ? LD.state.sessions.get(pane.sessionId) : null;
    var options = '<option value="">— 选择会话 —</option>';
    LD.state.sessionOrder.forEach(function (id) {
      var item = LD.state.sessions.get(id);
      if (!item) return;
      var icon = item.status === 'running' ? '●' : item.status === 'crashed' || item.status === 'error' ? '✖' : '○';
      options += '<option value="' + LD.esc(item.id) + '"' + (pane.sessionId === item.id ? ' selected' : '') + '>' + icon + ' ' + LD.esc(item.name) + '</option>';
    });
    var status = '<span class="status-badge ' + (session ? session.status : '') + '">' + (session ? LD.statusText(session.status) : '—') + '</span>';
    var health = '<span class="health-badge"></span>';
    var meta = '<span class="pane-meta">' + (session ? LD.esc(paneMetaText(session)) : '未选择会话') + '</span>';
    var tools = '';
    if (session) {
      if (session.status === 'running') {
        tools += '<button class="icon-btn" data-act="stop" title="停止">■</button>';
      } else if (session.status !== 'starting' && session.status !== 'stopping') {
        tools += '<button class="icon-btn" data-act="start" title="启动">▶</button>';
      }
      tools += '<button class="icon-btn" data-act="restart" title="重启">↻</button>';
      tools += '<button class="icon-btn" data-act="edit" title="编辑会话">✎</button>';
    }
    return (
      '<div class="pane-head">' +
        '<select class="pane-session" title="选择会话">' + options + '</select>' +
        status + health + meta +
        '<div class="pane-tools">' + tools + '</div>' +
      '</div>'
    );
  }

  function paneBodyHtml(pane, session) {
    var inputRow = '';
    if (session && session.type === 'process') {
      inputRow =
        '<div class="pane-input-row">' +
          '<input class="pane-input" placeholder="向进程发送输入，Enter 发送" autocomplete="off">' +
          '<button class="btn small" data-act="send">发送</button>' +
        '</div>';
    }
    return (
      '<div class="pane-body">' +
        '<div class="log-wrap">' +
          '<div class="log"><div class="lines"></div></div>' +
          '<button class="jump-bottom hidden">↓ 新日志</button>' +
        '</div>' +
        '<div class="pane-bar">' +
          '<input class="pane-filter" placeholder="过滤本窗格…" autocomplete="off">' +
          '<span class="pane-count">0 行</span>' +
          '<button class="icon-btn" data-act="pause" title="暂停/继续实时输出">⏸</button>' +
          '<button class="icon-btn" data-act="follow" title="自动跟随最新输出">⇊</button>' +
          '<button class="icon-btn" data-act="wrap" title="切换自动换行">⏎</button>' +
          '<button class="icon-btn" data-act="clearview" title="清空本窗格显示（不影响日志文件）">⌫</button>' +
          '<button class="icon-btn" data-act="clearlog" title="清空会话日志缓冲与文件">🗑</button>' +
          '<button class="icon-btn" data-act="download" title="下载日志文件">↧</button>' +
        '</div>' +
        inputRow +
      '</div>'
    );
  }

  LD.healthBadgeHtml = function (session) {
    if (!session || !session.healthCheck) return '';
    if (!session.health) return '端口检查中…';
    if (session.health.ok) return '端口 ' + (session.healthCheck.port || '') + ' OK ' + (session.health.ms || 0) + 'ms';
    return '端口 ' + (session.healthCheck.port || '') + ' 异常';
  };

  function paneMetaText(session) {
    var parts = [];
    if (session.type === 'file') {
      var file = String(session.path || '');
      var pieces = file.split(/[\\/]/);
      parts.push(pieces[pieces.length - 1] || file);
    } else {
      var command = String(session.command || '');
      if (command.length > 70) command = command.slice(0, 70) + '…';
      parts.push(command);
    }
    if (session.pid) parts.push('PID ' + session.pid);
    if (session.status === 'running' && session.startedAt) parts.push('已运行 ' + LD.fmtDuration(Date.now() - session.startedAt));
    if (session.logBytes) parts.push(LD.fmtBytes(session.logBytes));
    if (session.restarts) parts.push('重启 ' + session.restarts + ' 次');
    return parts.join(' · ');
  }
  LD.paneMetaText = paneMetaText;

  LD.updatePaneHeader = function (pane) {
    if (!pane.dom) return;
    var session = pane.sessionId ? LD.state.sessions.get(pane.sessionId) : null;
    if (!session) {
      pane.dom.status.textContent = '—';
      pane.dom.status.className = 'status-badge';
      pane.dom.health.textContent = '';
      pane.dom.health.className = 'health-badge';
      pane.dom.meta.textContent = '未选择会话';
      return;
    }
    pane.dom.status.textContent = LD.statusText(session.status);
    pane.dom.status.className = 'status-badge ' + session.status;
    pane.dom.health.textContent = LD.healthBadgeHtml(session);
    pane.dom.health.className = 'health-badge' + (session.health ? (session.health.ok ? ' ok' : ' bad') : '');
    pane.dom.meta.textContent = paneMetaText(session);
    pane.dom.select.value = session.id;
  };

  LD.updatePaneHeaders = function () {
    var view = LD.activeView();
    if (!view) return;
    view.panes.forEach(function (pane) { LD.updatePaneHeader(pane); });
  };

  LD.updatePaneCount = function (pane) {
    if (!pane.dom) return;
    var text = pane.lines.length + ' 行';
    if (pane.filter) text += ' · 已过滤';
    if (pane.paused) text += ' · 已暂停' + (pane.pending ? ' +' + pane.pending : '');
    pane.dom.count.textContent = text;
  };

  LD.updatePaneControls = function (pane) {
    if (!pane.dom) return;
    if (pane.dom.pauseBtn) {
      pane.dom.pauseBtn.textContent = pane.paused ? '▶' : '⏸';
      pane.dom.pauseBtn.classList.toggle('on', !!pane.paused);
      pane.dom.pauseBtn.title = pane.paused ? '继续实时输出' : '暂停实时输出';
    }
    if (pane.dom.followBtn) pane.dom.followBtn.classList.toggle('on', !!pane.follow);
    if (pane.dom.wrapBtn) pane.dom.wrapBtn.classList.toggle('on', !!LD.state.settings.wrap);
    if (pane.dom.log) pane.dom.log.classList.toggle('nowrap', !LD.state.settings.wrap);
    LD.updatePaneCount(pane);
  };

  LD.updateAllPaneControls = function () {
    var view = LD.activeView();
    if (!view) return;
    view.panes.forEach(function (item) { LD.updatePaneControls(item); });
  };

  LD.paneLineMatches = function (line, filter) {
    if (!filter) return true;
    return LD.stripPlain(line.text).toLowerCase().indexOf(String(filter).toLowerCase()) !== -1;
  };

  LD.lineClass = function (line) {
    var severity = LD.detectSeverity(line.text);
    return 'line ' + (line.stream || 'stdout') + (severity ? ' sev-' + severity : '');
  };

  LD.lineHtml = function (line) {
    var cls = LD.lineClass(line);
    var ts = LD.state.settings.showTs ? '<span class="ts">' + LD.fmtTs(line.ts) + '</span>' : '';
    return '<div class="' + cls + '" data-seq="' + Number(line.seq || 0) + '">' + ts + '<span class="content">' + LD.ansiToHtml(line.text) + '</span></div>';
  };

  LD.appendLineEl = function (pane, line) {
    if (!pane.dom) return;
    var empty = pane.dom.linesEl.querySelector('.log-empty');
    if (empty) empty.remove();
    pane.dom.linesEl.insertAdjacentHTML('beforeend', LD.lineHtml(line));
  };

  function updateOrAppendLineEl(pane, line) {
    if (!pane.dom) return;
    var last = pane.dom.linesEl.lastElementChild;
    if (last && last.classList.contains('line') && Number(last.dataset.seq) === Number(line.seq)) {
      last.className = LD.lineClass(line);
      var content = last.querySelector('.content');
      if (content) content.innerHTML = LD.ansiToHtml(line.text);
      var ts = last.querySelector('.ts');
      if (ts) ts.textContent = LD.fmtTs(line.ts);
      return;
    }
    LD.appendLineEl(pane, line);
  }

  function trimPaneDom(pane) {
    if (!pane.dom) return;
    var max = Math.max(200, LD.state.settings.maxLines) + 20;
    while (pane.dom.linesEl.childElementCount > max) {
      var first = pane.dom.linesEl.firstElementChild;
      if (!first || !first.classList.contains('line')) break;
      first.remove();
    }
  }

  LD.renderPaneLines = function (pane) {
    if (!pane.dom) return;
    var lines = pane.lines;
    if (pane.filter) {
      lines = lines.filter(function (line) { return LD.paneLineMatches(line, pane.filter); });
    }
    lines = lines.slice(-LD.state.settings.maxLines);
    if (!lines.length) {
      pane.dom.linesEl.innerHTML = '<div class="log-empty">' + (pane.sessionId ? (pane.filter ? '没有匹配的行' : '暂无日志输出') : '未选择会话') + '</div>';
    } else {
      var html = '';
      for (var i = 0; i < lines.length; i += 1) html += LD.lineHtml(lines[i]);
      pane.dom.linesEl.innerHTML = html;
    }
    LD.updatePaneCount(pane);
    if (pane.follow) LD.scrollPaneToBottom(pane);
  };

  LD.loadPaneTail = async function (pane) {
    if (!pane.dom) return;
    var sessionId = pane.sessionId;
    if (!sessionId) {
      pane.lines = [];
      LD.renderPaneLines(pane);
      LD.updatePaneHeader(pane);
      return;
    }
    var session = LD.state.sessions.get(sessionId);
    if (!session) {
      pane.lines = [];
      LD.renderPaneLines(pane);
      LD.updatePaneHeader(pane);
      return;
    }
    try {
      var data = await LD.api('/api/sessions/' + encodeURIComponent(sessionId) + '/log?tail=' + Math.max(200, LD.state.settings.maxLines));
      if (pane.sessionId !== sessionId) return;
      pane.lines = data.lines || [];
      pane.seq = data.lastSeq || 0;
      pane.pending = 0;
      pane.paused = false;
      LD.renderPaneLines(pane);
      LD.updatePaneHeader(pane);
      LD.updatePaneControls(pane);
      if (pane.follow) LD.scrollPaneToBottom(pane);
    } catch (err) {
      LD.toast(err.message, 'error');
    }
  };

  LD.scrollPaneToBottom = function (pane) {
    if (!pane.dom) return;
    var log = pane.dom.log;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
    pane.follow = true;
    if (pane.dom.jump) pane.dom.jump.classList.add('hidden');
    LD.updatePaneControls(pane);
  };

  LD.onPaneScroll = function (pane, log) {
    var distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    var atBottom = distance < 60;
    pane.follow = atBottom;
    if (pane.dom && pane.dom.jump) pane.dom.jump.classList.toggle('hidden', atBottom);
    if (pane.dom && pane.dom.followBtn) pane.dom.followBtn.classList.toggle('on', atBottom);
  };

  LD.onLineEvent = function (event) {
    var view = LD.activeView();
    if (!view || !event || !event.line) return;
    view.panes.forEach(function (pane) {
      if (pane.sessionId !== event.id || !pane.dom) return;
      var line = event.line;
      if (pane.paused) {
        pane.pending += 1;
        LD.updatePaneCount(pane);
        return;
      }
      if (pane.filter && !LD.paneLineMatches(line, pane.filter)) {
        pane.seq = Math.max(pane.seq, line.seq || 0);
        return;
      }
      if (line.replace) {
        var found = -1;
        for (var i = pane.lines.length - 1; i >= 0; i -= 1) {
          if (pane.lines[i].seq === line.seq) { found = i; break; }
        }
        if (found >= 0) pane.lines[found] = line;
        else pane.lines.push(line);
        updateOrAppendLineEl(pane, line);
      } else {
        pane.lines.push(line);
        var keep = Math.max(200, LD.state.settings.maxLines) * 3;
        if (pane.lines.length > keep) pane.lines.splice(0, pane.lines.length - keep);
        LD.appendLineEl(pane, line);
        trimPaneDom(pane);
      }
      pane.seq = Math.max(pane.seq, line.seq || 0);
      LD.updatePaneCount(pane);
      if (pane.follow) {
        var log = pane.dom.log;
        log.scrollTop = log.scrollHeight;
      }
    });
  };

  LD.onResetEvent = function (event) {
    LD.state.views.forEach(function (view) {
      view.panes.forEach(function (pane) {
        if (pane.sessionId !== event.id) return;
        pane.lines = [];
        pane.seq = event.seq || 0;
        pane.pending = 0;
        if (pane.dom) LD.renderPaneLines(pane);
      });
    });
  };

  LD.setPaneSession = function (view, pane, sessionId) {
    pane.sessionId = sessionId || null;
    pane.lines = [];
    pane.seq = 0;
    pane.filter = '';
    pane.paused = false;
    pane.pending = 0;
    pane.follow = true;
    view.activePane = view.panes.indexOf(pane);
    LD.saveViews();
    LD.renderPanes();
  };

  LD.markPaneFocus = function (view) {
    var area = LD.$('#pane-area');
    if (!area) return;
    LD.$$('.pane', area).forEach(function (node, index) {
      node.classList.toggle('focused', index === view.activePane);
    });
  };

  LD.createPaneEl = function (view, pane, index) {
    var session = pane.sessionId ? LD.state.sessions.get(pane.sessionId) : null;
    var wrap = document.createElement('section');
    wrap.className = 'pane' + (view.activePane === index ? ' focused' : '');
    wrap.dataset.pane = String(index);
    wrap.innerHTML = paneHeaderHtml(pane) + paneBodyHtml(pane, session);

    var select = LD.$('.pane-session', wrap);
    select.addEventListener('change', function () {
      LD.setPaneSession(view, pane, select.value);
    });

    var filter = LD.$('.pane-filter', wrap);
    filter.value = pane.filter || '';
    filter.addEventListener('input', function () {
      pane.filter = filter.value;
      LD.renderPaneLines(pane);
    });
    filter.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        pane.filter = '';
        filter.value = '';
        LD.renderPaneLines(pane);
        filter.blur();
      }
    });

    var input = LD.$('.pane-input', wrap);
    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          LD.sendPaneInput(pane);
        }
      });
    }

    var log = LD.$('.log', wrap);
    log.addEventListener('scroll', function () { LD.onPaneScroll(pane, log); });

    var jump = LD.$('.jump-bottom', wrap);
    jump.addEventListener('click', function (event) {
      event.stopPropagation();
      LD.scrollPaneToBottom(pane);
    });

    wrap.addEventListener('click', function (event) {
      var button = event.target.closest('[data-act]');
      if (button) {
        event.stopPropagation();
        LD.handlePaneAction(pane, button.dataset.act);
        return;
      }
      view.activePane = index;
      LD.markPaneFocus(view);
    });

    pane.dom = {
      wrap: wrap,
      linesEl: LD.$('.lines', wrap),
      log: log,
      count: LD.$('.pane-count', wrap),
      jump: jump,
      select: select,
      input: input,
      status: LD.$('.status-badge', wrap),
      health: LD.$('.health-badge', wrap),
      meta: LD.$('.pane-meta', wrap),
      pauseBtn: LD.$('[data-act="pause"]', wrap),
      followBtn: LD.$('[data-act="follow"]', wrap),
      wrapBtn: LD.$('[data-act="wrap"]', wrap)
    };

    LD.updatePaneHeader(pane);
    LD.updatePaneControls(pane);
    LD.loadPaneTail(pane);
    return wrap;
  };

  LD.renderPanes = function () {
    var area = LD.$('#pane-area');
    if (!area) return;
    var view = LD.activeView();
    if (!view) {
      area.innerHTML = '';
      area.className = 'pane-area layout-1';
      LD.updateEmptyState();
      return;
    }
    area.className = 'pane-area layout-' + view.layout;
    area.innerHTML = '';
    view.panes.forEach(function (pane, index) {
      area.appendChild(LD.createPaneEl(view, pane, index));
    });
    LD.updateEmptyState();
    if (LD.updateLayoutButtons) LD.updateLayoutButtons(view);
    LD.renderTabs();
    LD.renderSidebar();
  };

  LD.updateEmptyState = function () {
    var node = LD.$('#empty-state');
    if (!node) return;
    var view = LD.activeView();
    var hasSession = !!(view && view.panes.some(function (pane) { return !!pane.sessionId; }));
    node.classList.toggle('hidden', hasSession);
  };

  LD.sendPaneInput = async function (pane) {
    if (!pane.sessionId || !pane.dom || !pane.dom.input) return;
    var input = pane.dom.input;
    var text = input.value;
    if (!text) return;
    try {
      await LD.api('/api/sessions/' + encodeURIComponent(pane.sessionId) + '/input', {
        method: 'POST',
        body: { text: text, enter: true }
      });
      input.value = '';
    } catch (err) {
      LD.toast(err.message, 'error');
    }
    input.focus();
  };

  LD.downloadLog = async function (sessionId) {
    try {
      var res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/download', {
        headers: { 'X-LogDeck-Token': LD.TOKEN }
      });
      if (!res.ok) throw new Error('下载失败 (HTTP ' + res.status + ')');
      var blob = await res.blob();
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = sessionId + '.log';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 2000);
    } catch (err) {
      LD.toast(err.message, 'error');
    }
  };

  LD.handlePaneAction = async function (pane, action) {
    var session = pane.sessionId ? LD.state.sessions.get(pane.sessionId) : null;
    if (action === 'follow') {
      if (pane.follow) {
        pane.follow = false;
        if (pane.dom) pane.dom.jump.classList.remove('hidden');
      } else {
        LD.scrollPaneToBottom(pane);
      }
      return;
    }
    if (action === 'wrap') {
      LD.state.settings.wrap = !LD.state.settings.wrap;
      LD.saveSettings();
      LD.updateAllPaneControls();
      return;
    }
    if (!session) {
      LD.toast('请先选择会话', 'warn');
      return;
    }
    if (action === 'start' || action === 'stop' || action === 'restart') {
      await LD.handleSessionAction(session.id, action);
      return;
    }
    if (action === 'edit') {
      LD.openSessionModal(session);
      return;
    }
    if (action === 'pause') {
      pane.paused = !pane.paused;
      if (!pane.paused) await LD.loadPaneTail(pane);
      LD.updatePaneControls(pane);
      return;
    }
    if (action === 'clearview') {
      pane.lines = [];
      LD.renderPaneLines(pane);
      return;
    }
    if (action === 'clearlog') {
      if (!LD.confirm('清空日志', '确定清空「' + session.name + '」的日志缓冲与日志文件吗？')) return;
      try {
        await LD.api('/api/sessions/' + encodeURIComponent(session.id) + '/clear', { method: 'POST', body: {} });
        LD.toast('已清空日志', 'success');
      } catch (err) {
        LD.toast(err.message, 'error');
      }
      return;
    }
    if (action === 'download') {
      await LD.downloadLog(session.id);
      return;
    }
    if (action === 'send') {
      await LD.sendPaneInput(pane);
    }
  };
})();

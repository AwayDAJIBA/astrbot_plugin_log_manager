(function () {
  'use strict';
  var LD = window.LD;
  if (!LD) return;

  var eventSource = null;
  var reconnectTimer = null;

  function setConnected(value) {
    LD.state.connected = !!value;
    var dot = LD.$('#conn-dot');
    var text = LD.$('#conn-text');
    if (dot) dot.className = 'conn-dot ' + (value ? 'on' : 'off');
    if (text) text.textContent = value ? '已连接 · 实时' : '已断开，重连中…';
  }

  function updateTitle() {
    var running = 0;
    LD.state.sessions.forEach(function (session) {
      if (session.status === 'running') running += 1;
    });
    document.title = 'LogDeck · ' + running + ' 运行中';
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSSE, 2000);
  }

  function connectSSE() {
    if (eventSource) {
      try { eventSource.close(); } catch (err) { /* ignore */ }
    }
    try {
      eventSource = new EventSource('/api/events?token=' + encodeURIComponent(LD.TOKEN));
    } catch (err) {
      scheduleReconnect();
      return;
    }
    eventSource.onopen = function () { setConnected(true); };
    eventSource.onerror = function () {
      setConnected(false);
      try { eventSource.close(); } catch (err) { /* ignore */ }
      scheduleReconnect();
    };
    eventSource.onmessage = function (message) {
      var event = null;
      try { event = JSON.parse(message.data); } catch (err) { return; }
      handleEvent(event);
    };
  }

  function reloadActiveTails() {
    var view = LD.activeView();
    if (!view) return;
    view.panes.forEach(function (pane) { LD.loadPaneTail(pane); });
  }

  function handleEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'hello') {
      var previous = LD.state.serverInfo;
      var changed = !previous || previous.serverId !== event.serverId;
      var reconnected = !!previous && !changed;
      LD.state.serverInfo = event;
      LD.applySessions(event.sessions || []);
      setConnected(true);
      if (changed) {
        LD.state.views.forEach(function (view) {
          view.panes.forEach(function (pane) {
            pane.lines = [];
            pane.seq = 0;
          });
        });
        LD.renderAll();
        updateTitle();
      } else {
        LD.renderSidebar();
        LD.renderTabs();
        LD.updatePaneHeaders();
        if (reconnected) reloadActiveTails();
      }
      return;
    }
    if (event.type === 'session') {
      LD.upsertSession(event.session);
      LD.renderSidebar();
      LD.renderTabs();
      LD.updatePaneHeaders();
      updateTitle();
      return;
    }
    if (event.type === 'remove') {
      LD.removeSessionFromState(event.id);
      LD.renderPanes();
      LD.renderTabs();
      LD.renderSidebar();
      updateTitle();
      return;
    }
    if (event.type === 'line') {
      LD.onLineEvent(event);
      return;
    }
    if (event.type === 'reset') {
      LD.onResetEvent(event);
      LD.updatePaneHeaders();
      return;
    }
    if (event.type === 'server:shutdown') {
      setConnected(false);
      LD.toast('LogDeck 管理器已关闭', 'warn');
      return;
    }
  }

  async function startAll() {
    if (!LD.confirm('启动全部会话', '确定启动所有尚未运行的会话吗？')) return;
    try {
      var data = await LD.api('/api/actions/start-all', { method: 'POST', body: {} });
      var okCount = (data.actions || []).filter(function (item) { return item.ok; }).length;
      var failed = (data.actions || []).filter(function (item) { return !item.ok; });
      LD.toast('已启动 ' + okCount + ' 个会话' + (failed.length ? '，' + failed.length + ' 个失败' : ''), failed.length ? 'warn' : 'success');
      await LD.reloadSessions();
      LD.updatePaneHeaders();
    } catch (err) {
      LD.toast(err.message, 'error');
    }
  }

  async function stopAll() {
    if (!LD.confirm('停止全部会话', '确定停止所有正在运行的会话吗？这会关闭它们托管的服务。')) return;
    try {
      var data = await LD.api('/api/actions/stop-all', { method: 'POST', body: {} });
      var okCount = (data.actions || []).filter(function (item) { return item.ok; }).length;
      LD.toast('已停止 ' + okCount + ' 个会话', 'success');
      await LD.reloadSessions();
      LD.updatePaneHeaders();
    } catch (err) {
      LD.toast(err.message, 'error');
    }
  }

  function bindEvents() {
    LD.$('#side-filter').addEventListener('input', function () { LD.renderSidebar(); });

    LD.$('#compare-mode').addEventListener('change', function (event) {
      LD.setCompareMode(event.target.checked);
    });
    LD.$('#btn-compare').addEventListener('click', function () { LD.doCompare(); });

    LD.$('#btn-new').addEventListener('click', function () { LD.openSessionModal(); });
    var emptyNew = LD.$('#empty-new');
    if (emptyNew) emptyNew.addEventListener('click', function () { LD.openSessionModal(); });
    var emptyCompare = LD.$('#empty-compare');
    if (emptyCompare) {
      emptyCompare.addEventListener('click', function () {
        if (LD.state.compareSet.size) LD.doCompare();
        else {
          LD.setCompareMode(true);
          LD.toast('已进入对比选择模式，勾选会话后点“对比”', 'info');
        }
      });
    }

    LD.$('#btn-start-all').addEventListener('click', startAll);
    LD.$('#btn-stop-all').addEventListener('click', stopAll);
    LD.$('#btn-settings').addEventListener('click', function () { LD.openSettingsModal(); });

    LD.$('#btn-side-collapse').addEventListener('click', function () {
      LD.$('#sidebar').classList.add('collapsed');
    });
    LD.$('#btn-side-open').addEventListener('click', function () {
      LD.$('#sidebar').classList.remove('collapsed');
    });

    LD.$$('#layout-switch button').forEach(function (button) {
      button.addEventListener('click', function () { LD.setLayout(Number(button.dataset.layout)); });
    });

    LD.$('#session-list').addEventListener('click', function (event) {
      var item = event.target.closest('.session-item');
      if (!item) return;
      var id = item.dataset.id;
      var actionButton = event.target.closest('[data-act]');
      if (actionButton) {
        LD.handleSessionAction(id, actionButton.dataset.act);
        return;
      }
      if (event.target.matches('[data-cmp]')) return;
      LD.openSession(id);
    });

    LD.$('#session-list').addEventListener('change', function (event) {
      if (event.target.matches('[data-cmp]')) {
        LD.toggleCompare(event.target.dataset.cmp, event.target.checked);
      }
    });

    document.addEventListener('keydown', function (event) {
      var modifier = event.ctrlKey || event.metaKey;
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        LD.$('#side-filter').focus();
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        LD.newTab();
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        LD.closeView(LD.state.activeViewId);
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        var filter = document.querySelector('.pane.focused .pane-filter') || document.querySelector('.pane-filter');
        if (filter) filter.focus();
        return;
      }
      if (event.altKey && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        LD.setLayout(Number(event.key));
        return;
      }
      if (modifier && !event.altKey && /^[1-9]$/.test(event.key)) {
        var view = LD.state.views[Number(event.key) - 1];
        if (view) {
          event.preventDefault();
          LD.activateView(view.id);
        }
      }
    });
  }

  async function init() {
    LD.loadSettings();
    LD.applySettings();
    bindEvents();
    try {
      var data = await LD.api('/api/sessions');
      LD.applySessions(data.sessions || []);
    } catch (err) {
      LD.toast('无法连接 LogDeck 管理器: ' + err.message, 'error');
    }
    LD.restoreViews();
    LD.renderAll();
    updateTitle();
    setConnected(false);
    connectSSE();
    setInterval(function () { LD.renderSidebar(); }, 15000);
    setInterval(function () {
      LD.updatePaneHeaders();
      LD.renderTabs();
      updateTitle();
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

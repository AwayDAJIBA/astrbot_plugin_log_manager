(function () {
  'use strict';
  var LD = window.LD;
  if (!LD) return;

  function sessionItemHtml(session, isActive) {
    var tags = (session.tags || []).slice(0, 2).map(function (tag) {
      return '<span class="s-tag">' + LD.esc(tag) + '</span>';
    }).join('');
    var meta = [];
    meta.push(LD.statusText(session.status));
    if (session.pid) meta.push('PID ' + session.pid);
    if (session.status === 'running' && session.startedAt) meta.push('已运行 ' + LD.fmtDuration(Date.now() - session.startedAt));
    if (session.type === 'file') meta.push('跟踪文件');
    if (session.healthCheck && session.health) {
      meta.push(session.health.ok
        ? '<span class="ok">端口 ' + LD.esc(session.healthCheck.port || '') + ' OK</span>'
        : '<span class="bad">端口 ' + LD.esc(session.healthCheck.port || '') + ' 异常</span>');
    }
    var actions = '';
    if (session.status === 'running') {
      actions += '<button class="icon-btn" data-act="stop" title="停止">■</button>';
      actions += '<button class="icon-btn" data-act="restart" title="重启">↻</button>';
    } else if (session.status !== 'starting' && session.status !== 'stopping') {
      actions += '<button class="icon-btn" data-act="start" title="启动">▶</button>';
    }
    actions += '<button class="icon-btn" data-act="edit" title="编辑">✎</button>';
    var checkbox = LD.state.compareMode
      ? '<input type="checkbox" class="cmp-box" data-cmp="' + LD.esc(session.id) + '"' + (LD.state.compareSet.has(session.id) ? ' checked' : '') + ' title="加入对比">'
      : '';
    var title = session.command || session.path || session.name;
    return (
      '<div class="session-item' + (isActive ? ' active' : '') + '" data-id="' + LD.esc(session.id) + '">' +
        checkbox +
        '<span class="dot ' + LD.esc(session.status) + '"></span>' +
        '<div class="s-main">' +
          '<div class="s-name"><span class="name-text" title="' + LD.esc(title) + '">' + LD.esc(session.name) + '</span>' + tags + '</div>' +
          '<div class="s-meta">' + meta.join(' · ') + '</div>' +
        '</div>' +
        '<div class="s-actions">' + actions + '</div>' +
      '</div>'
    );
  }

  LD.renderSidebar = function () {
    var list = LD.$('#session-list');
    if (!list) return;
    var filterInput = LD.$('#side-filter');
    var keyword = (filterInput && filterInput.value ? filterInput.value : '').trim().toLowerCase();
    var activeIds = {};
    var view = LD.activeView();
    if (view) {
      view.panes.forEach(function (pane) {
        if (pane.sessionId) activeIds[pane.sessionId] = true;
      });
    }
    var sessions = LD.state.sessionOrder
      .map(function (id) { return LD.state.sessions.get(id); })
      .filter(Boolean);
    if (keyword) {
      sessions = sessions.filter(function (session) {
        var haystack = [
          session.name,
          session.id,
          (session.tags || []).join(' '),
          session.command || '',
          session.path || ''
        ].join(' ').toLowerCase();
        return haystack.indexOf(keyword) !== -1;
      });
    }
    var html = '';
    sessions.forEach(function (session) {
      html += sessionItemHtml(session, !!activeIds[session.id]);
    });
    if (!sessions.length) {
      html = '<div class="log-empty">' + (keyword ? '没有匹配的会话' : '还没有会话，点击“新增会话”') + '</div>';
    }
    list.innerHTML = html;
    LD.updateCompareButton();
  };

  LD.updateCompareButton = function () {
    var button = LD.$('#btn-compare');
    if (!button) return;
    var count = LD.state.compareSet.size;
    button.textContent = '对比 (' + count + ')';
    button.disabled = count === 0;
    var sidebar = LD.$('#sidebar');
    if (sidebar) sidebar.classList.toggle('compare-mode', !!LD.state.compareMode);
    var mode = LD.$('#compare-mode');
    if (mode) mode.checked = !!LD.state.compareMode;
  };

  LD.setCompareMode = function (enabled) {
    LD.state.compareMode = !!enabled;
    if (!LD.state.compareMode) LD.state.compareSet.clear();
    LD.updateCompareButton();
    LD.renderSidebar();
  };

  LD.toggleCompare = function (id, checked) {
    if (checked) LD.state.compareSet.add(id);
    else LD.state.compareSet.delete(id);
    LD.updateCompareButton();
  };

  LD.upsertSession = function (session) {
    if (!session || !session.id) return;
    LD.state.sessions.set(session.id, session);
    if (LD.state.sessionOrder.indexOf(session.id) === -1) LD.state.sessionOrder.push(session.id);
  };

  LD.removeSessionFromState = function (id) {
    LD.state.sessions.delete(id);
    LD.state.sessionOrder = LD.state.sessionOrder.filter(function (item) { return item !== id; });
    LD.state.compareSet.delete(id);
    LD.state.views.forEach(function (view) {
      view.panes.forEach(function (pane) {
        if (pane.sessionId === id) {
          pane.sessionId = null;
          pane.lines = [];
          pane.seq = 0;
        }
      });
    });
  };

  LD.applySessions = function (list) {
    var map = new Map();
    var order = [];
    (list || []).forEach(function (session) {
      if (!session || !session.id) return;
      map.set(session.id, session);
      order.push(session.id);
    });
    LD.state.sessions = map;
    LD.state.sessionOrder = order;
    LD.state.compareSet.forEach(function (id) {
      if (!map.has(id)) LD.state.compareSet.delete(id);
    });
    LD.state.views.forEach(function (view) {
      view.panes.forEach(function (pane) {
        if (pane.sessionId && !map.has(pane.sessionId)) {
          pane.sessionId = null;
          pane.lines = [];
          pane.seq = 0;
        }
      });
    });
  };

  LD.reloadSessions = async function () {
    var data = await LD.api('/api/sessions');
    LD.applySessions(data.sessions || []);
    LD.renderSidebar();
    LD.renderTabs();
    return data.sessions || [];
  };

  LD.handleSessionAction = async function (id, action) {
    var session = LD.state.sessions.get(id);
    if (!session) return;
    if (action === 'edit') {
      LD.openSessionModal(session);
      return;
    }
    if (action === 'delete') {
      if (!LD.confirm('删除会话', '确定删除「' + session.name + '」吗？正在运行的进程会被停止。')) return;
      try {
        await LD.api('/api/sessions/' + encodeURIComponent(id) + '?deleteLog=1', { method: 'DELETE' });
        LD.toast('已删除 ' + session.name, 'success');
        await LD.reloadSessions();
        LD.renderPanes();
      } catch (err) {
        LD.toast(err.message, 'error');
      }
      return;
    }
    var labelMap = { start: '启动', stop: '停止', restart: '重启' };
    var label = labelMap[action] || action;
    LD.toast('正在' + label + '「' + session.name + '」…', 'info');
    try {
      var data = await LD.api('/api/sessions/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        body: {}
      });
      LD.upsertSession(data.session);
      LD.renderSidebar();
      LD.renderTabs();
      LD.updatePaneHeaders();
      LD.toast('「' + session.name + '」' + label + '完成', 'success');
    } catch (err) {
      LD.toast(err.message, 'error');
    }
  };

  LD.openSession = function (id) {
    var session = LD.state.sessions.get(id);
    if (!session) return;
    var view = LD.activeView();
    if (!view) {
      var created = LD.newView(1, [id]);
      LD.state.views.push(created);
      LD.state.activeViewId = created.id;
      LD.saveViews();
      LD.renderAll();
      return;
    }
    var existing = -1;
    view.panes.forEach(function (pane, index) {
      if (pane.sessionId === id) existing = index;
    });
    if (existing >= 0) {
      view.activePane = existing;
      LD.renderPanes();
      LD.renderSidebar();
      return;
    }
    var index = view.activePane;
    if (index < 0 || index >= view.panes.length) index = 0;
    var pane = view.panes[index];
    pane.sessionId = id;
    pane.lines = [];
    pane.seq = 0;
    pane.filter = '';
    pane.paused = false;
    pane.pending = 0;
    pane.follow = true;
    LD.saveViews();
    LD.renderPanes();
    LD.renderSidebar();
  };

  LD.doCompare = function () {
    var ids = Array.from(LD.state.compareSet).filter(function (id) {
      return LD.state.sessions.has(id);
    });
    if (!ids.length) {
      LD.toast('先在左侧勾选要对比的会话', 'warn');
      return;
    }
    if (ids.length > 4) {
      LD.toast('最多同时对比 4 个会话，已取前 4 个', 'warn');
      ids = ids.slice(0, 4);
    }
    var layout = Math.min(4, Math.max(2, ids.length));
    var view = LD.newView(layout, ids);
    LD.state.views.push(view);
    LD.state.activeViewId = view.id;
    LD.state.compareSet.clear();
    LD.saveViews();
    LD.renderAll();
    LD.toast('已打开对比视图', 'success');
  };
})();

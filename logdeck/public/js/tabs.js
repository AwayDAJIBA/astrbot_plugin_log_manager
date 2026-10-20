(function () {
  'use strict';
  var LD = window.LD;
  if (!LD) return;

  function tabTitle(view) {
    var parts = view.panes.map(function (pane) {
      var session = pane.sessionId ? LD.state.sessions.get(pane.sessionId) : null;
      return session ? session.name : null;
    }).filter(Boolean);
    if (!parts.length) return '新标签';
    if (parts.length === 1) return parts[0];
    return parts.join(' | ');
  }

  LD.renderTabs = function () {
    var tabs = LD.$('#tabs');
    if (!tabs) return;
    tabs.innerHTML = '';
    LD.state.views.forEach(function (view) {
      var active = view.id === LD.state.activeViewId;
      var running = view.panes.some(function (pane) {
        var session = pane.sessionId ? LD.state.sessions.get(pane.sessionId) : null;
        return !!(session && session.status === 'running');
      });
      var tab = document.createElement('div');
      tab.className = 'tab' + (active ? ' active' : '');
      tab.title = tabTitle(view);
      tab.innerHTML =
        '<span class="tab-run-dot ' + (running ? 'running' : '') + '"></span>' +
        '<span class="tab-title">' + LD.esc(tabTitle(view)) + '</span>' +
        '<button class="tab-close" title="关闭标签">×</button>';
      tab.addEventListener('click', function (event) {
        if (event.target.closest('.tab-close')) {
          LD.closeView(view.id);
          return;
        }
        LD.activateView(view.id);
      });
      tab.addEventListener('auxclick', function (event) {
        if (event.button === 1) LD.closeView(view.id);
      });
      tabs.appendChild(tab);
    });
    var add = document.createElement('button');
    add.id = 'btn-add-view';
    add.className = 'icon-btn';
    add.title = '新建标签 (Ctrl+T)';
    add.textContent = '+';
    add.addEventListener('click', function () { LD.newTab(); });
    tabs.appendChild(add);
  };

  LD.updateLayoutButtons = function (view) {
    var target = view || LD.activeView();
    LD.$$('#layout-switch button').forEach(function (button) {
      button.classList.toggle('active', !!target && Number(button.dataset.layout) === target.layout);
    });
  };

  LD.activateView = function (id) {
    if (LD.state.activeViewId === id) return;
    LD.state.activeViewId = id;
    LD.saveViews();
    LD.renderPanes();
  };

  LD.newTab = function () {
    var view = LD.newView(1, []);
    LD.state.views.push(view);
    LD.state.activeViewId = view.id;
    LD.saveViews();
    LD.renderAll();
    return view;
  };

  LD.closeView = function (id) {
    var views = LD.state.views;
    var index = -1;
    views.forEach(function (view, i) { if (view.id === id) index = i; });
    if (index === -1) return;
    var wasActive = LD.state.activeViewId === id;
    if (views.length <= 1) {
      var fresh = LD.newView(1, []);
      LD.state.views = [fresh];
      LD.state.activeViewId = fresh.id;
    } else {
      views.splice(index, 1);
      if (wasActive) {
        var next = views[Math.min(index, views.length - 1)];
        LD.state.activeViewId = next.id;
      }
    }
    LD.saveViews();
    LD.renderAll();
  };

  LD.setLayout = function (layout) {
    var view = LD.activeView();
    if (!view) return;
    var count = Math.max(1, Math.min(4, Number(layout) || 1));
    view.layout = count;
    if (count > view.panes.length) {
      for (var i = view.panes.length; i < count; i += 1) view.panes.push(LD.newPane(null));
    } else if (count < view.panes.length) {
      view.panes = view.panes.slice(0, count);
    }
    view.activePane = Math.min(view.activePane, count - 1);
    LD.saveViews();
    LD.renderPanes();
  };

  LD.renderAll = function () {
    LD.applySettings();
    LD.renderPanes();
    LD.renderTabs();
    LD.renderSidebar();
    LD.updateEmptyState();
  };
})();

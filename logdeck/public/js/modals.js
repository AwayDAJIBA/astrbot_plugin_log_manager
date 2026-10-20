(function () {
  'use strict';
  var LD = window.LD;
  if (!LD) return;

  LD.openModal = function (options) {
    var root = LD.$('#modal-root');
    if (!root) return null;
    var width = options.width || 680;
    root.innerHTML =
      '<div class="modal-mask">' +
        '<div class="modal" style="width:min(' + width + 'px, 100%)">' +
          '<div class="modal-head"><h3>' + LD.esc(options.title || '') + '</h3><button class="icon-btn" data-close title="关闭">×</button></div>' +
          '<div class="modal-body">' + (options.body || '') + '</div>' +
          '<div class="modal-foot">' + (options.footer || '<button class="btn" data-close>关闭</button>') + '</div>' +
        '</div>' +
      '</div>';
    var mask = root.firstElementChild;
    function close() {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      if (options.onClose) options.onClose();
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }
    document.addEventListener('keydown', onKey);
    mask.addEventListener('click', function (event) {
      if (event.target === mask) close();
    });
    LD.$$('[data-close]', root).forEach(function (button) {
      button.addEventListener('click', close);
    });
    return {
      root: root,
      close: close,
      $: function (selector) { return LD.$(selector, root); },
      $$: function (selector) { return LD.$$(selector, root); }
    };
  };

  function parseEnv(text) {
    var env = {};
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed || trimmed.charAt(0) === '#') return;
      var index = trimmed.indexOf('=');
      if (index <= 0) return;
      var key = trimmed.slice(0, index).trim();
      var value = trimmed.slice(index + 1).trim();
      if (key) env[key] = value;
    });
    return env;
  }

  function envToText(env) {
    var source = env || {};
    return Object.keys(source).map(function (key) { return key + '=' + source[key]; }).join('\n');
  }

  LD.openSessionModal = function (session) {
    var isEdit = !!session;
    var s = session || {
      name: '',
      type: 'process',
      command: '',
      cwd: '',
      path: '',
      tags: [],
      color: '',
      env: {},
      pathPrepend: [],
      autostart: false,
      restartPolicy: 'never',
      maxRestarts: 10,
      healthCheck: null,
      bufferLines: 4000,
      fromBeginning: false
    };
    var isFile = s.type === 'file';
    var healthPort = s.healthCheck && s.healthCheck.port ? String(s.healthCheck.port) : '';
    var body =
      '<div class="field"><label>名称</label><input type="text" id="f-name" placeholder="例如 AstrBot / 网易云 API / GPT-SoVITS 9880" value="' + LD.esc(s.name) + '"></div>' +
      '<div class="grid-2">' +
        '<div class="field"><label>类型</label><select id="f-type">' +
          '<option value="process"' + (s.type !== 'file' ? ' selected' : '') + '>运行命令（后台进程）</option>' +
          '<option value="file"' + (s.type === 'file' ? ' selected' : '') + '>跟踪日志文件（tail）</option>' +
        '</select></div>' +
        '<div class="field"><label>标签（逗号分隔）</label><input type="text" id="f-tags" placeholder="服务, 语音, 日志" value="' + LD.esc((s.tags || []).join(', ')) + '"></div>' +
      '</div>' +
      '<div id="row-process">' +
        '<div class="field"><label>命令</label><input type="text" id="f-command" placeholder="node server.js  或  venv\\Scripts\\python.exe main.py" value="' + LD.esc(s.command) + '"></div>' +
        '<div class="field"><label>工作目录</label><input type="text" id="f-cwd" placeholder="留空 = LogDeck 所在目录" value="' + LD.esc(s.cwd) + '"></div>' +
      '</div>' +
      '<div id="row-file">' +
        '<div class="field"><label>日志文件路径</label><input type="text" id="f-path" placeholder="C:\\path\\app.log 或 \\\\wsl.localhost\\Ubuntu2204\\var\\log\\x.log" value="' + LD.esc(s.path) + '"></div>' +
        '<label class="inline-check"><input type="checkbox" id="f-frombegin"' + (s.fromBeginning ? ' checked' : '') + '><span>从文件开头开始读取（默认只读末尾并跟随）</span></label>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="field"><label>端口健康检查</label><input type="number" id="f-healthport" placeholder="例如 3000，留空不检查" value="' + LD.esc(healthPort) + '"></div>' +
        '<div class="field"><label>退出后重启策略</label><select id="f-restart">' +
          '<option value="never"' + (s.restartPolicy === 'never' || !s.restartPolicy ? ' selected' : '') + '>不自动重启</option>' +
          '<option value="on-failure"' + (s.restartPolicy === 'on-failure' ? ' selected' : '') + '>异常退出时重启</option>' +
          '<option value="always"' + (s.restartPolicy === 'always' ? ' selected' : '') + '>总是重启</option>' +
        '</select></div>' +
      '</div>' +
      '<label class="inline-check"><input type="checkbox" id="f-autostart"' + (s.autostart ? ' checked' : '') + '><span>随 LogDeck 启动时自动启动</span></label>' +
      (isEdit ? '' : '<label class="inline-check"><input type="checkbox" id="f-startnow" checked><span>创建后立即启动</span></label>') +
      '<details class="advanced"><summary>高级选项</summary>' +
        '<div class="grid-2">' +
          '<div class="field"><label>最大重启次数</label><input type="number" id="f-maxrestarts" value="' + LD.esc(s.maxRestarts === undefined ? 10 : s.maxRestarts) + '"></div>' +
          '<div class="field"><label>日志缓冲行数</label><input type="number" id="f-bufferlines" value="' + LD.esc(s.bufferLines || 4000) + '"></div>' +
        '</div>' +
        '<div class="field"><label>PATH 前置目录（相对工作目录，逗号分隔）</label><input type="text" id="f-prepend" value="' + LD.esc((s.pathPrepend || []).join(', ')) + '"></div>' +
        '<div class="field"><label>外部启动自动接管（逗号分隔，留空=不接管）</label><input type="text" id="f-takeover" value="' + LD.esc((s.takeoverPatterns || []).join(', ')) + '" placeholder="例如 main.py, AstrBot"><div class="hint">程序被其它工具/窗口启动时，LogDeck 会自动结束它并改为托管运行，日志进入本会话。多个关键词需全部命中（匹配可执行路径+命令行，不区分大小写）。</div></div>' +
        '<div class="field"><label>环境变量（每行 KEY=VALUE）</label><textarea id="f-env" rows="3">' + LD.esc(envToText(s.env)) + '</textarea></div>' +
        '<div class="field"><label>颜色标记</label><input type="text" id="f-color" placeholder="#5ea1ff（可选）" value="' + LD.esc(s.color || '') + '"></div>' +
      '</details>';
    var footer =
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn primary" id="modal-save">' + (isEdit ? '保存' : '创建会话') + '</button>';
    var modal = LD.openModal({
      title: isEdit ? '编辑会话 · ' + s.name : '新增终端 / 日志会话',
      body: body,
      footer: footer,
      width: 720
    });
    if (!modal) return;

    var typeSelect = modal.$('#f-type');
    function syncType() {
      var file = typeSelect.value === 'file';
      var processRow = modal.$('#row-process');
      var fileRow = modal.$('#row-file');
      if (processRow) processRow.classList.toggle('hidden', file);
      if (fileRow) fileRow.classList.toggle('hidden', !file);
    }
    typeSelect.addEventListener('change', syncType);
    syncType();

    modal.$('#modal-save').addEventListener('click', async function () {
      function value(selector) {
        var node = modal.$(selector);
        return node ? String(node.value || '').trim() : '';
      }
      function checked(selector) {
        var node = modal.$(selector);
        return !!(node && node.checked);
      }
      var payload = {
        name: value('#f-name'),
        type: value('#f-type'),
        tags: value('#f-tags').split(',').map(function (item) { return item.trim(); }).filter(Boolean),
        color: value('#f-color'),
        autostart: checked('#f-autostart'),
        restartPolicy: value('#f-restart'),
        maxRestarts: Number(value('#f-maxrestarts')) || 10,
        bufferLines: Number(value('#f-bufferlines')) || 4000,
        pathPrepend: value('#f-prepend').split(',').map(function (item) { return item.trim(); }).filter(Boolean),
        takeoverPatterns: value('#f-takeover').split(',').map(function (item) { return item.trim(); }).filter(Boolean),
        env: parseEnv(value('#f-env')),
        healthPort: Number(value('#f-healthport')) || null,
        startNow: !isEdit && checked('#f-startnow')
      };
      if (payload.type === 'file') {
        payload.path = value('#f-path');
        payload.fromBeginning = checked('#f-frombegin');
      } else {
        payload.command = value('#f-command');
        payload.cwd = value('#f-cwd');
      }
      if (!payload.name) { LD.toast('请填写名称', 'warn'); return; }
      if (payload.type === 'process' && !payload.command) { LD.toast('请填写要运行的命令', 'warn'); return; }
      if (payload.type === 'file' && !payload.path) { LD.toast('请填写日志文件路径', 'warn'); return; }
      try {
        var data;
        if (isEdit) {
          delete payload.startNow;
          data = await LD.api('/api/sessions/' + encodeURIComponent(s.id), { method: 'PATCH', body: payload });
        } else {
          data = await LD.api('/api/sessions', { method: 'POST', body: payload });
        }
        modal.close();
        await LD.reloadSessions();
        LD.renderPanes();
        if (!isEdit && data && data.session) {
          LD.toast('已创建「' + data.session.name + '」', 'success');
          LD.openSession(data.session.id);
        } else {
          LD.toast('已保存会话配置', 'success');
          if (session && session.status === 'running' && (payload.command !== session.command || payload.cwd !== session.cwd)) {
            LD.toast('命令/目录修改会在下次重启后生效', 'info');
          }
        }
      } catch (err) {
        LD.toast(err.message, 'error');
      }
    });
  };

  LD.openSettingsModal = async function () {
    var info = null;
    try { info = await LD.api('/api/info'); } catch (err) { /* ignore */ }
    var settings = LD.state.settings;
    var managerUrl = info ? 'http://127.0.0.1:' + info.port + '/' : (window.location.origin + '/');
    var token = info && info.token ? info.token : LD.TOKEN;
    var body =
      '<div class="settings-section" style="border-top:none;margin-top:0;padding-top:0">' +
        '<h4>界面</h4>' +
        '<div class="grid-2">' +
          '<div class="field"><label>主题</label><select id="s-theme"><option value="dark"' + (settings.theme !== 'light' ? ' selected' : '') + '>深色</option><option value="light"' + (settings.theme === 'light' ? ' selected' : '') + '>浅色</option></select></div>' +
          '<div class="field"><label>每窗格最多显示行数</label><select id="s-maxlines"><option value="500"' + (settings.maxLines === 500 ? ' selected' : '') + '>500</option><option value="1000"' + (settings.maxLines === 1000 ? ' selected' : '') + '>1000</option><option value="2000"' + (settings.maxLines === 2000 ? ' selected' : '') + '>2000</option><option value="5000"' + (settings.maxLines === 5000 ? ' selected' : '') + '>5000</option></select></div>' +
        '</div>' +
        '<div class="field"><label>日志字号：<span id="s-fontsize-label">' + settings.fontSize + 'px</span></label><input type="range" id="s-fontsize" min="10" max="20" step="1" value="' + settings.fontSize + '"></div>' +
        '<label class="inline-check"><input type="checkbox" id="s-showts"' + (settings.showTs ? ' checked' : '') + '><span>显示每行时间戳</span></label>' +
        '<label class="inline-check"><input type="checkbox" id="s-wrap"' + (settings.wrap ? ' checked' : '') + '><span>自动换行</span></label>' +
        '<div class="hint" style="font-size:10.5px;color:var(--faint)">日志颜色按级别标记：错误=红，警告=黄，INFO=正常文字，DEBUG=灰；stderr 输出用左侧橙色细线标记，不再整行标红。</div>' +
      '</div>' +
      '<div class="settings-section">' +
        '<h4>管理器</h4>' +
        (info ? (
          '<div class="info-row"><span>版本</span><span class="v">v' + LD.esc(info.version) + ' · PID ' + info.pid + ' · 运行 ' + LD.fmtDuration(info.uptimeMs) + '</span></div>' +
          '<div class="info-row"><span>地址</span><span class="v">' + LD.esc(managerUrl) + '</span></div>' +
          '<div class="info-row"><span>配置文件</span><span class="v" title="' + LD.esc(info.configPath) + '">' + LD.esc(info.configPath) + '</span></div>' +
          '<div class="info-row"><span>数据目录</span><span class="v" title="' + LD.esc(info.dataDir) + '">' + LD.esc(info.dataDir) + '</span></div>' +
          '<div class="info-row"><span>日志目录</span><span class="v" title="' + LD.esc(info.logsDir) + '">' + LD.esc(info.logsDir) + '</span></div>'
        ) : '<div class="info-row">无法获取管理器信息</div>') +
      '</div>' +
      '<div class="settings-section">' +
        '<h4>AstrBot 插件连接</h4>' +
        '<div class="info-row"><span>地址</span><span class="v">' + LD.esc(managerUrl) + '</span></div>' +
        '<div class="info-row"><span>令牌</span></div>' +
        '<div class="token-box"><input id="s-token" type="text" readonly value="' + LD.esc(token) + '"><button class="btn small" data-copy-token>复制</button></div>' +
        '<div class="hint" style="font-size:10.5px;color:var(--faint);margin-top:6px">LogDeck 与 AstrBot 插件共用同一个本地管理器；令牌只保存在本机，页面已自动携带。</div>' +
      '</div>' +
      '<div class="settings-section">' +
        '<h4>快捷键</h4>' +
        '<div class="kbd-list">' +
          '<span><kbd>Ctrl</kbd> + <kbd>T</kbd> 新建标签</span>' +
          '<span><kbd>Ctrl</kbd> + <kbd>W</kbd> 关闭当前标签</span>' +
          '<span><kbd>Ctrl</kbd> + <kbd>K</kbd> 搜索会话</span>' +
          '<span><kbd>Ctrl</kbd> + <kbd>F</kbd> 过滤当前窗格</span>' +
          '<span><kbd>Alt</kbd> + <kbd>1..4</kbd> 切换分栏数量</span>' +
          '<span><kbd>Ctrl</kbd> + <kbd>1..9</kbd> 切换标签</span>' +
        '</div>' +
      '</div>';
    var footer = '<button class="btn" data-close>关闭</button>';
    var modal = LD.openModal({ title: 'LogDeck 设置', body: body, footer: footer, width: 640 });
    if (!modal) return;

    var themeSelect = modal.$('#s-theme');
    themeSelect.addEventListener('change', function () {
      settings.theme = themeSelect.value;
      LD.saveSettings();
      LD.applySettings();
    });
    var maxSelect = modal.$('#s-maxlines');
    maxSelect.addEventListener('change', function () {
      settings.maxLines = Number(maxSelect.value) || 2000;
      LD.saveSettings();
      LD.renderPanes();
    });
    var fontRange = modal.$('#s-fontsize');
    fontRange.addEventListener('input', function () {
      settings.fontSize = Number(fontRange.value) || 13;
      modal.$('#s-fontsize-label').textContent = settings.fontSize + 'px';
      LD.applySettings();
    });
    fontRange.addEventListener('change', function () { LD.saveSettings(); });
    var showTs = modal.$('#s-showts');
    showTs.addEventListener('change', function () {
      settings.showTs = showTs.checked;
      LD.saveSettings();
      LD.renderPanes();
    });
    var wrapCheck = modal.$('#s-wrap');
    wrapCheck.addEventListener('change', function () {
      settings.wrap = wrapCheck.checked;
      LD.saveSettings();
      LD.updateAllPaneControls();
    });

    var copyButton = modal.$('[data-copy-token]');
    if (copyButton) {
      copyButton.addEventListener('click', function () { LD.copyText(token); });
    }
  };
})();

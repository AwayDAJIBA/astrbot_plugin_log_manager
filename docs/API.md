# LogDeck HTTP API

默认地址：http://127.0.0.1:17890
除静态页面外的所有接口都需要令牌，三选一：

- 请求头 X-LogDeck-Token: <token>
- 请求头 Authorization: Bearer <token>
- 查询参数 ?token=<token>

成功响应一般带 {"ok": true, ...}；失败为 {"ok": false, "error": "..."}，并带非 2xx 状态码。

## 信息

    GET /api/info
    返回版本、PID、端口、启动时间、会话数、运行中数量、配置/数据/日志目录、token。

    GET /api/sessions
    返回 { ok, sessions: [Session] }。

Session 对象主要字段：

    id              会话 id
    name            名称
    type            process=后台进程；file=日志文件跟踪
    status          starting / running / stopping / stopped / exited / crashed / error
    pid             进程 PID（file 类型为 null）
    command         启动命令（process）
    cwd             工作目录（process）
    path            日志文件路径（file）
    tags            标签数组
    autostart       是否随管理器启动
    restartPolicy   never / on-failure / always
    maxRestarts     最大自动重启次数
    healthCheck     { type: "tcp", host, port } 或 { type: "http", url } 或 null
    takeoverPatterns 外部启动接管关键词数组（全部命中才接管，匹配可执行路径+命令行）
    health          { ok, checkedAt, ms, target, error? } 或 null
    startedAt / endedAt / exitCode / signal / restarts
    logBytes        当前日志文件大小
    lines           内存缓冲中的行数
    seq             日志序号（用于增量拉取）
    logFile         日志文件绝对路径（process）

## 会话管理

    POST   /api/sessions                新建会话（body 见下）
    GET    /api/sessions/:id            单个会话
    PATCH  /api/sessions/:id            修改配置（name/command/cwd/tags/healthCheck/...）
    DELETE /api/sessions/:id?deleteLog=1 删除会话（可选删日志）
    POST   /api/sessions/:id/start      启动
    POST   /api/sessions/:id/stop       停止
    POST   /api/sessions/:id/restart    重启
    POST   /api/sessions/:id/clear      清空日志缓冲与日志文件
    POST   /api/sessions/:id/input      { text, enter } 写入进程 stdin
    POST   /api/sessions/:id/health     立即做一次健康检查
    POST   /api/sessions/:id/ensure     确保会话在运行（未运行则启动；供外部启动接管用）

新建会话 body 示例（后台进程）：

    {
      "name": "Vite 开发服务器",
      "type": "process",
      "command": "npm run dev",
      "cwd": "D:\\web",
      "env": { "NODE_ENV": "development" },
      "pathPrepend": [],
      "tags": ["开发", "前端"],
      "autostart": true,
      "restartPolicy": "on-failure",
      "maxRestarts": 10,
      "healthPort": 5173,
      "bufferLines": 4000,
      "startNow": true
    }

新建日志文件跟踪 body：

    {
      "name": "某个日志",
      "type": "file",
      "path": "D:\\logs\\app.log",
      "fromBeginning": false,
      "bufferLines": 8000,
      "startNow": true
    }

## 读日志

    GET /api/sessions/:id/log?tail=200&grep=ERROR&regex=0&afterSeq=0&plain=1&timestamps=1

- tail：最多返回多少行（1-5000，默认 300）
- grep：关键字过滤（不区分大小写；regex=1 时按正则）
- afterSeq：只返回序号大于该值的行（增量轮询）
- plain=1：返回 text/plain（自动去掉 ANSI 颜色），否则返回 JSON
- timestamps=0：plain 模式下不输出时间戳

JSON 返回：

    {
      "ok": true,
      "id": "astrbot",
      "seq": 12345,
      "firstSeq": 12000,
      "lastSeq": 12345,
      "truncated": false,
      "count": 200,
      "lines": [ { "seq": 12146, "ts": 1760000000000, "stream": "stdout", "text": "..." } ]
    }

stream 取值：stdout / stderr / system / input / history / file。

    GET /api/search?q=ERROR&ids=astrbot,netease-api&limit=10
    在内存日志缓冲里搜索，返回每个会话的命中行。

    GET /api/sessions/:id/download
    下载日志文件。

## 外部启动接管

    GET  /api/takeover          查看接管间隔与规则
    POST /api/takeover/scan     立即执行一次接管扫描

会话的 takeoverPatterns 字段定义该会话要接管的外部进程特征，例如 ["main.py", "AstrBot"]。
LogDeck 每 takeoverIntervalMs（默认 5000）扫描一次；命中且不属于 LogDeck 进程树时，
会结束外部进程，并在会话未运行时自动重新托管启动。

## 批量操作

    POST /api/actions/start-all
    POST /api/actions/stop-all

## 实时事件流（SSE）

    GET /api/events?token=<token>
    Content-Type: text/event-stream

连接后先收到一条 hello：

    { "type": "hello", "serverId": "...", "version": "1.0.0", "pid": 123,
      "sessions": [Session...], "time": 1760000000000 }

之后事件：

- { "type": "line", "id": "astrbot", "line": { seq, ts, stream, text } }
  REPLACE 行（seq 相同）表示终端进度条覆盖，用新 text 替换同 seq 的行。
- { "type": "session", "session": Session }   会话状态/配置变化
- { "type": "remove", "id": "..." }           会话删除
- { "type": "reset", "id": "...", "seq": 0 }  日志被清空

每 15 秒有一条 ": ping" 心跳注释。断线后客户端应重新拉取各会话 tail 日志补齐。

## curl 示例

    curl -H "X-LogDeck-Token: <token>" http://127.0.0.1:17890/api/sessions
    curl -H "X-LogDeck-Token: <token>" "http://127.0.0.1:17890/api/sessions/astrbot/log?tail=50&plain=1"
    curl -X POST -H "X-LogDeck-Token: <token>" -H "Content-Type: application/json" \
         -d "{\"name\":\"test\",\"type\":\"process\",\"command\":\"node -e \\\"setInterval(()=>console.log('hello'),1000)\\\"\",\"startNow\":true}" \
         http://127.0.0.1:17890/api/sessions

"""astrbot_plugin_log_manager：让 AstrBot agent 通过 LogDeck 查看、新增、管理本机后台终端日志。

LogDeck（默认 http://127.0.0.1:17890 ）是独立运行的本地多终端/日志管理器：
  - 每个会话要么是后台进程（command + cwd），要么是日志文件跟踪（tail）；
  - 日志实时推送到网页，agent 通过本插件的 LLM 工具读写同一份数据。

只读工具（默认所有人可用）：
    logmgr_list_sessions / logmgr_read_logs / logmgr_search_logs / logmgr_health
管理工具（默认仅管理员）：
    logmgr_create_session / logmgr_add_log_file / logmgr_manage_session
    logmgr_delete_session* / logmgr_clear_logs* / logmgr_send_input*
    （带 * 的默认在插件配置里关闭）

命令：
    /logmgr help | list | tail <id> [行数] [--grep 关键词] | search <关键词>
    /logmgr start|stop|restart <id> | health
    /logmgr new <名称> | <命令> [| 工作目录]
    /logmgr file <名称> | <日志路径>
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, StarTools, register

from .logdeck_client import (
    LogDeckClient,
    LogDeckError,
    format_health,
    format_search_results,
    format_sessions,
    status_text,
)
from .logdeck_launcher import ManagerLauncher, ManagerStartError

PLUGIN_NAME = "astrbot_plugin_log_manager"

HELP_TEXT = """LogDeck 日志管理器命令：
/logmgr list — 列出所有后台终端 / 日志会话
/logmgr tail <id|名称> [行数] [--grep 关键词] — 查看最近日志
/logmgr search <关键词> — 在所有日志里搜索
/logmgr health — 管理器与端口健康状态
/logmgr web — 查看 WebUI 地址（用浏览器打开）
/logmgr start|stop|restart <id|名称> — 管理会话
/logmgr new <名称> | <命令> [| 工作目录] — 新建后台终端
/logmgr file <名称> | <日志路径> — 跟踪一个日志文件
（管理类命令需要 AstrBot 管理员身份）"""


@register(
    PLUGIN_NAME,
    "AwayDAJIBA",
    "LogDeck 日志管理器：内置 WebUI，查看/新增/管理本机后台终端与日志（由 LLM 生成，请自行审查代码）。",
    "v1.0.0",
)
class LogManagerPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None) -> None:
        super().__init__(context)
        self.cfg: dict[str, Any] = dict(config or {})
        self._manager_url = str(
            self._get("manager_url", "http://127.0.0.1:17890")
        ).rstrip("/")
        self._token = str(self._get("token", "")).strip()
        self._auto_start = self._bool("auto_start", True)
        self._node_path = str(self._get("node_path", "")).strip()
        self._start_timeout = float(self._get("start_timeout", 25) or 25)
        self._request_timeout = float(self._get("request_timeout", 10) or 10)
        self._default_lines = self._int("default_lines", 80)
        self._max_lines = self._int("max_lines", 300)
        self.launcher: ManagerLauncher | None = None
        self.client = LogDeckClient(
            self._manager_url, self._token, self._request_timeout
        )
        logger.info(
            "[log_manager] 插件已加载：manager="
            + self._manager_url
            + " auto_start="
            + str(self._auto_start)
            + " 读日志需管理员="
            + str(self._bool("require_admin_read", False))
            + " 管理需管理员="
            + str(self._bool("require_admin_manage", True))
        )

    async def initialize(self) -> None:
        plugin_root = Path(__file__).resolve().parent
        try:
            data_root = Path(StarTools.get_data_dir(PLUGIN_NAME))
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[log_manager] 获取插件数据目录失败，回退到插件目录: " + repr(exc)
            )
            data_root = plugin_root / "plugin_data"
        self.launcher = ManagerLauncher(
            plugin_root=plugin_root,
            data_dir=data_root / "logdeck",
            manager_url=self._manager_url,
            token=self._token,
            node_path=self._node_path,
            auto_start=self._auto_start,
            start_timeout=self._start_timeout,
        )
        try:
            info = await asyncio.to_thread(self.launcher.ensure_running)
        except ManagerStartError as exc:
            logger.error("[log_manager] LogDeck 管理器不可用：" + str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            logger.error("[log_manager] 启动 LogDeck 管理器异常：" + repr(exc))
            return

        self._manager_url = self.launcher.manager_url
        self._token = self.launcher.token
        self.client = LogDeckClient(
            self._manager_url, self._token, self._request_timeout
        )
        try:
            info = await self.client.info()
            logger.info(
                "[log_manager] LogDeck 已就绪：v"
                + str(info.get("version"))
                + " 会话="
                + str(info.get("sessionCount"))
                + " 运行中="
                + str(info.get("runningCount"))
                + " WebUI="
                + self._manager_url
                + "/"
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[log_manager] 暂时连接不上 LogDeck：" + repr(exc))

    # ---------------- 配置 / 权限 ----------------
    def _get(self, key: str, default: Any = None) -> Any:
        try:
            return self.cfg.get(key, default)
        except Exception:  # noqa: BLE001
            return default

    def _bool(self, key: str, default: bool = False) -> bool:
        value = self._get(key, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _int(self, key: str, default: int) -> int:
        try:
            return int(self._get(key, default))
        except Exception:  # noqa: BLE001
            return default

    def _is_admin(self, event: AstrMessageEvent) -> bool:
        try:
            checker = getattr(event, "is_admin", None)
            if callable(checker) and bool(checker()):
                return True
        except Exception:  # noqa: BLE001
            pass
        try:
            if str(getattr(event, "role", "") or "") == "admin":
                return True
        except Exception:  # noqa: BLE001
            pass
        uid = ""
        try:
            uid = str(event.get_sender_id() or "")
        except Exception:  # noqa: BLE001
            uid = ""
        if not uid:
            return False
        admins: list[Any] = []
        try:
            admins = list(getattr(self.context, "admins_id", None) or [])
        except Exception:  # noqa: BLE001
            admins = []
        if not admins:
            try:
                cfg = getattr(self.context, "_config", None) or {}
                admins = list(cfg.get("admins_id", []) or [])
            except Exception:  # noqa: BLE001
                admins = []
        return uid in [str(item) for item in admins]

    def _read_denied(self, event: AstrMessageEvent) -> str:
        if not self._bool("require_admin_read", False):
            return ""
        if self._is_admin(event):
            return ""
        return "读取日志列表/内容需要管理员身份。"

    def _manage_denied(self, event: AstrMessageEvent) -> str:
        if not self._bool("require_admin_manage", True):
            return ""
        if self._is_admin(event):
            return ""
        return "这个日志管理操作需要管理员身份。"

    def _feature_denied(self, key: str, default: bool = True) -> str:
        if self._bool(key, default):
            return ""
        return "插件配置里关闭了该功能（" + key + "）。"

    def _err(self, action: str, exc: Exception) -> str:
        if isinstance(exc, LogDeckError):
            return action + "失败：" + str(exc)
        logger.error("[log_manager] " + action + " 异常: " + repr(exc))
        return action + "失败：" + repr(exc)

    # ---------------- 只读工具 ----------------
    @filter.llm_tool(name="logmgr_list_sessions")
    async def logmgr_list_sessions(self, event: AstrMessageEvent) -> str:
        '''列出日志管理器（LogDeck）里所有后台终端 / 日志会话及运行状态。

        返回每个会话的 id、名称、类型（后台终端 / 日志文件）、状态、PID、端口健康、标签、重启次数和命令或文件路径。
        当用户问「现在有哪些后台服务在跑」「日志管理器里有什么」「某个服务是不是挂了」时先调用本工具获取 id。

        无参数。
        '''
        denied = self._read_denied(event)
        if denied:
            return denied
        try:
            sessions = await self.client.list_sessions()
            return format_sessions(sessions)
        except Exception as exc:  # noqa: BLE001
            return self._err("读取日志会话列表", exc)

    @filter.llm_tool(name="logmgr_read_logs")
    async def logmgr_read_logs(
        self,
        event: AstrMessageEvent,
        session_id: str,
        lines: int = 80,
        keyword: str = "",
    ) -> str:
        '''读取某个日志会话最近的内容（纯文本，已去掉终端颜色控制符）。

        读之前先用 logmgr_list_sessions 获取 session_id；也可以直接传会话名称。
        返回最近若干行、带时间戳；后台终端日志和日志文件跟踪都支持。
        当用户问「某个服务日志里说了什么」「报错了吗」「最近输出」时调用。

        Args:
            session_id(string): 会话的 id 或名称，例如 "astrbot" 或 "网易云 API (3000)"。
            lines(number): 读取最近多少行，默认 80；上限由插件配置 max_lines 限制（默认 300）。
            keyword(string): 可选；只返回包含该关键字的行，不区分大小写。留空=全部。
        '''
        denied = self._read_denied(event)
        if denied:
            return denied
        try:
            lines_int = max(1, min(int(lines or self._default_lines), max(1, self._max_lines)))
        except Exception:  # noqa: BLE001
            lines_int = self._default_lines
        try:
            session = await self.client.get_session(session_id)
            text = await self.client.read_log_text(session_id, lines_int, str(keyword or "").strip())
            session_name = str(session.get("name") or session.get("id") or session_id)
            header = (
                "会话 "
                + str(session.get("id") or session_id)
                + "（"
                + session_name
                + "）状态="
                + status_text(session.get("status"))
                + ("，关键字=" + str(keyword) if keyword else "")
                + "：\n"
            )
            body = text.strip()
            return header + (body if body else "(暂无日志输出)")
        except Exception as exc:  # noqa: BLE001
            return self._err("读取日志", exc)

    @filter.llm_tool(name="logmgr_search_logs")
    async def logmgr_search_logs(
        self,
        event: AstrMessageEvent,
        keyword: str,
        session_id: str = "",
        lines: int = 10,
    ) -> str:
        '''在所有日志会话（或指定会话）里搜索关键字，返回命中行和所属会话。

        只搜索 LogDeck 内存里的最近日志缓冲，适合快速定位报错 / 关键字。
        当用户问「日志里有没有某个报错」「哪个服务打印了 xxx」时调用。

        Args:
            keyword(string): 要搜索的关键字，不区分大小写。
            session_id(string): 可选；只在该会话里搜索，留空=搜索所有会话。
            lines(number): 每个会话最多返回多少条命中，默认 10，最大 50。
        '''
        denied = self._read_denied(event)
        if denied:
            return denied
        text = str(keyword or "").strip()
        if not text:
            return "keyword 不能为空。"
        try:
            results = await self.client.search(
                text,
                str(session_id or "").strip(),
                max(1, min(int(lines or 10), 50)),
            )
            return format_search_results(results, text)
        except Exception as exc:  # noqa: BLE001
            return self._err("搜索日志", exc)

    @filter.llm_tool(name="logmgr_health")
    async def logmgr_health(self, event: AstrMessageEvent) -> str:
        '''检查 LogDeck 日志管理器是否在线，并列出每个会话的状态和端口健康。

        当用户问「日志管理器还开着吗」「服务端口正常吗」时调用。
        无参数。
        '''
        denied = self._read_denied(event)
        if denied:
            return denied
        try:
            info = await self.client.info()
            sessions = await self.client.list_sessions()
            return format_health(info, sessions)
        except Exception as exc:  # noqa: BLE001
            return self._err("检查日志管理器状态", exc)

    # ---------------- 管理工具 ----------------
    @filter.llm_tool(name="logmgr_create_session")
    async def logmgr_create_session(
        self,
        event: AstrMessageEvent,
        name: str,
        command: str,
        cwd: str = "",
        autostart: bool = False,
        start_now: bool = True,
        tags: str = "",
    ) -> str:
        '''在 LogDeck 里新建一个后台终端会话，并立刻开始捕获它的日志。

        新会话的 stdout/stderr 会进入 LogDeck，用户可以在网页里看，agent 可以用 logmgr_read_logs 读。
        默认异常退出会自动重启（最多 20 次）。当用户说「帮我开一个终端跑 xxx」「把某个服务挂到日志管理器里」时调用。

        Args:
            name(string): 会话名称，例如 "Vite 开发服务器"。
            command(string): 要执行的命令，例如 "npm run dev" 或 "node server.js"。
            cwd(string): 工作目录（绝对路径）；留空表示 LogDeck 所在目录。
            autostart(bool): 是否随 LogDeck 启动时自动启动，默认 false。
            start_now(bool): 是否创建后立即启动，默认 true。
            tags(string): 可选标签，用逗号分隔，例如 "开发,前端"。
        '''
        denied = self._manage_denied(event)
        if denied:
            return denied
        feature = self._feature_denied("allow_create", True)
        if feature:
            return feature
        name = str(name or "").strip()
        command = str(command or "").strip()
        if not name:
            return "name 不能为空。"
        if not command:
            return "command 不能为空。"
        payload = {
            "name": name,
            "type": "process",
            "command": command,
            "cwd": str(cwd or "").strip(),
            "autostart": bool(autostart),
            "startNow": bool(start_now),
            "tags": [item.strip() for item in str(tags or "").split(",") if item.strip()],
            "restartPolicy": "on-failure",
            "maxRestarts": 20,
            "restartDelayMs": 3000,
            "bufferLines": 5000,
        }
        try:
            session = await self.client.create_session(payload)
            return (
                "已创建后台终端会话：id="
                + str(session.get("id"))
                + " 名称="
                + str(session.get("name"))
                + " 状态="
                + status_text(session.get("status"))
                + ((" PID=" + str(session.get("pid"))) if session.get("pid") else "")
                + "。可以用 logmgr_read_logs 读取它的输出。"
            )
        except Exception as exc:  # noqa: BLE001
            return self._err("新建后台终端会话", exc)

    @filter.llm_tool(name="logmgr_add_log_file")
    async def logmgr_add_log_file(
        self,
        event: AstrMessageEvent,
        name: str,
        path: str,
        autostart: bool = False,
        start_now: bool = True,
    ) -> str:
        '''在 LogDeck 里新增一个“日志文件跟踪”会话，实时查看某个日志文件的新增内容。

        适合跟踪 AstrBot / 其它程序写在磁盘上的日志文件（Windows 路径或 WSL 的 UNC 路径都可以）。
        当用户说「帮我盯一下某个日志文件」「把这个日志加到管理器」时调用。

        Args:
            name(string): 会话名称，例如 "AstrBot WSL 日志"。
            path(string): 日志文件的完整路径，例如 "C:\\logs\\app.log" 或 "\\\\wsl.localhost\\Ubuntu2204\\var\\log\\x.log"。
            autostart(bool): 是否随 LogDeck 启动自动跟踪，默认 false。
            start_now(bool): 是否创建后立即开始跟踪，默认 true。
        '''
        denied = self._manage_denied(event)
        if denied:
            return denied
        feature = self._feature_denied("allow_create", True)
        if feature:
            return feature
        name = str(name or "").strip()
        file_path = str(path or "").strip()
        if not name:
            return "name 不能为空。"
        if not file_path:
            return "path 不能为空。"
        payload = {
            "name": name,
            "type": "file",
            "path": file_path,
            "autostart": bool(autostart),
            "startNow": bool(start_now),
            "restartPolicy": "never",
            "bufferLines": 8000,
            "historyLines": 400,
        }
        try:
            session = await self.client.create_session(payload)
            return (
                "已新增日志文件跟踪会话：id="
                + str(session.get("id"))
                + " 名称="
                + str(session.get("name"))
                + " 状态="
                + status_text(session.get("status"))
                + " 文件="
                + str(session.get("path"))
            )
        except Exception as exc:  # noqa: BLE001
            return self._err("新增日志文件跟踪会话", exc)

    @filter.llm_tool(name="logmgr_manage_session")
    async def logmgr_manage_session(
        self,
        event: AstrMessageEvent,
        session_id: str,
        action: str,
    ) -> str:
        '''启动、停止或重启 LogDeck 里的一个会话。

        当用户说「把某个服务重启一下」「停掉某个后台终端」「把服务拉起来」时调用。
        session_id 可以先通过 logmgr_list_sessions 获取，也可以直接传名称。

        Args:
            session_id(string): 会话 id 或名称。
            action(string): 要执行的动作：start=启动，stop=停止，restart=重启。
        '''
        denied = self._manage_denied(event)
        if denied:
            return denied
        feature = self._feature_denied("allow_manage", True)
        if feature:
            return feature
        aliases = {
            "start": "start", "启动": "start", "开启": "start",
            "stop": "stop", "停止": "stop", "关闭": "stop",
            "restart": "restart", "重启": "restart", "重开": "restart",
        }
        normalized = aliases.get(str(action or "").strip().lower(), str(action or "").strip().lower())
        if normalized not in {"start", "stop", "restart"}:
            return "action 只能是 start / stop / restart。"
        try:
            session = await self.client.manage_session(str(session_id or "").strip(), normalized)
            return (
                "已对会话 "
                + str(session.get("id") or session_id)
                + "（"
                + str(session.get("name") or "")
                + "）执行 "
                + normalized
                + "，当前状态="
                + status_text(session.get("status"))
                + ((" PID=" + str(session.get("pid"))) if session.get("pid") else "")
            )
        except Exception as exc:  # noqa: BLE001
            return self._err("管理会话", exc)

    @filter.llm_tool(name="logmgr_delete_session")
    async def logmgr_delete_session(self, event: AstrMessageEvent, session_id: str) -> str:
        '''删除 LogDeck 里的一个会话（正在运行的会先被停止，日志文件一并删除）。

        高风险操作，默认在插件配置 allow_delete=false 时禁用。

        Args:
            session_id(string): 会话 id 或名称。
        '''
        denied = self._manage_denied(event)
        if denied:
            return denied
        feature = self._feature_denied("allow_delete", False)
        if feature:
            return feature
        try:
            session = await self.client.get_session(str(session_id or "").strip())
            await self.client.delete_session(str(session_id or "").strip())
            return "已删除会话 " + str(session.get("id") or session_id) + "（" + str(session.get("name") or "") + "）。"
        except Exception as exc:  # noqa: BLE001
            return self._err("删除会话", exc)

    @filter.llm_tool(name="logmgr_clear_logs")
    async def logmgr_clear_logs(self, event: AstrMessageEvent, session_id: str) -> str:
        '''清空一个会话的日志缓冲与日志文件（不停止进程）。

        高风险操作，默认在插件配置 allow_clear=false 时禁用。

        Args:
            session_id(string): 会话 id 或名称。
        '''
        denied = self._manage_denied(event)
        if denied:
            return denied
        feature = self._feature_denied("allow_clear", False)
        if feature:
            return feature
        try:
            session = await self.client.clear_logs(str(session_id or "").strip())
            return "已清空会话 " + str(session.get("id") or session_id) + " 的日志。"
        except Exception as exc:  # noqa: BLE001
            return self._err("清空日志", exc)

    @filter.llm_tool(name="logmgr_send_input")
    async def logmgr_send_input(self, event: AstrMessageEvent, session_id: str, text: str) -> str:
        '''向一个正在运行的后台终端进程发送一行输入（写入它的 stdin，并自动回车）。

        默认在插件配置 allow_input=false 时禁用。只适合支持交互输入的程序。

        Args:
            session_id(string): 会话 id 或名称。
            text(string): 要发送的文本（自动追加回车）。
        '''
        denied = self._manage_denied(event)
        if denied:
            return denied
        feature = self._feature_denied("allow_input", False)
        if feature:
            return feature
        if not str(text or "").strip():
            return "text 不能为空。"
        try:
            session = await self.client.send_input(str(session_id or "").strip(), str(text))
            return "已向会话 " + str(session.get("id") or session_id) + " 发送输入。"
        except Exception as exc:  # noqa: BLE001
            return self._err("发送输入", exc)

    # ---------------- 命令 ----------------
    def _command_args(self, event: AstrMessageEvent, name: str) -> str:
        raw = ""
        try:
            raw = str(getattr(event, "message_str", "") or "")
        except Exception:  # noqa: BLE001
            raw = ""
        if not raw:
            try:
                getter = getattr(event, "get_message_str", None)
                if callable(getter):
                    raw = str(getter() or "")
            except Exception:  # noqa: BLE001
                raw = ""
        text = raw.strip()
        if text.startswith("/"):
            text = text[1:]
        parts = text.split(None, 1)
        if parts:
            head = parts[0].split("@")[0].strip().lower()
            if head == name.lower():
                return parts[1].strip() if len(parts) > 1 else ""
        return text

    @filter.command("logmgr")
    async def logmgr_command(self, event: AstrMessageEvent):
        '''日志管理器命令入口：/logmgr help 查看用法。'''
        args = self._command_args(event, "logmgr")
        if not args or args.lower() in {"help", "?", "h", "帮助"}:
            yield event.plain_result(HELP_TEXT)
            return
        parts = args.split(None, 1)
        sub = parts[0].lower()
        rest = parts[1].strip() if len(parts) > 1 else ""

        if sub in {"web", "ui", "panel", "界面"}:
            yield event.plain_result(
                "LogDeck 网页管理界面：" + self.client.base_url + "/\n"
                "用本机浏览器直接打开即可（页面会自动携带本机访问令牌）。"
            )
            return

        if sub in {"list", "ls", "列表"}:
            denied = self._read_denied(event)
            if denied:
                yield event.plain_result(denied)
                return
            try:
                sessions = await self.client.list_sessions()
                yield event.plain_result(format_sessions(sessions))
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(self._err("读取会话列表", exc))
            return

        if sub in {"health", "状态"}:
            denied = self._read_denied(event)
            if denied:
                yield event.plain_result(denied)
                return
            try:
                info = await self.client.info()
                sessions = await self.client.list_sessions()
                yield event.plain_result(format_health(info, sessions))
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(self._err("检查状态", exc))
            return

        if sub in {"tail", "log", "日志"}:
            denied = self._read_denied(event)
            if denied:
                yield event.plain_result(denied)
                return
            keyword = ""
            if "--grep" in rest:
                rest, _, keyword = rest.partition("--grep")
                keyword = keyword.strip()
            tokens = rest.split()
            if not tokens:
                yield event.plain_result("用法：/logmgr tail <id|名称> [行数] [--grep 关键词]")
                return
            session_id = tokens[0]
            lines = self._default_lines
            if len(tokens) > 1:
                try:
                    lines = max(1, min(int(tokens[1]), max(1, self._max_lines)))
                except Exception:  # noqa: BLE001
                    lines = self._default_lines
            try:
                session = await self.client.get_session(session_id)
                text = await self.client.read_log_text(session_id, lines, keyword)
                header = (
                    "会话 "
                    + str(session.get("id") or session_id)
                    + "（"
                    + str(session.get("name") or "")
                    + "）状态="
                    + status_text(session.get("status"))
                    + "：\n"
                )
                yield event.plain_result(header + (text.strip() or "(暂无日志输出)"))
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(self._err("读取日志", exc))
            return

        if sub in {"search", "grep", "搜索"}:
            denied = self._read_denied(event)
            if denied:
                yield event.plain_result(denied)
                return
            if not rest:
                yield event.plain_result("用法：/logmgr search <关键词>")
                return
            try:
                results = await self.client.search(rest, "", 10)
                yield event.plain_result(format_search_results(results, rest))
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(self._err("搜索日志", exc))
            return

        if sub in {"start", "stop", "restart", "启动", "停止", "重启"}:
            denied = self._manage_denied(event)
            if denied:
                yield event.plain_result(denied)
                return
            feature = self._feature_denied("allow_manage", True)
            if feature:
                yield event.plain_result(feature)
                return
            action_map = {
                "start": "start", "stop": "stop", "restart": "restart",
                "启动": "start", "停止": "stop", "重启": "restart",
            }
            action = action_map.get(sub, sub)
            if not rest:
                yield event.plain_result("用法：/logmgr " + action + " <id|名称>")
                return
            try:
                session = await self.client.manage_session(rest, action)
                yield event.plain_result(
                    "已对会话 "
                    + str(session.get("id") or rest)
                    + "（"
                    + str(session.get("name") or "")
                    + "）执行 "
                    + action
                    + "，当前状态="
                    + status_text(session.get("status"))
                )
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(self._err("管理会话", exc))
            return

        if sub in {"new", "add", "新建"}:
            denied = self._manage_denied(event)
            if denied:
                yield event.plain_result(denied)
                return
            feature = self._feature_denied("allow_create", True)
            if feature:
                yield event.plain_result(feature)
                return
            segments = [segment.strip() for segment in rest.split("|")]
            if len(segments) < 2 or not segments[0] or not segments[1]:
                yield event.plain_result("用法：/logmgr new <名称> | <命令> [| 工作目录]")
                return
            name = segments[0]
            command = segments[1]
            cwd = segments[2] if len(segments) > 2 else ""
            try:
                session = await self.client.create_session(
                    {
                        "name": name,
                        "type": "process",
                        "command": command,
                        "cwd": cwd,
                        "autostart": False,
                        "startNow": True,
                        "restartPolicy": "on-failure",
                        "maxRestarts": 20,
                        "bufferLines": 5000,
                    }
                )
                yield event.plain_result(
                    "已新建后台终端 " + str(session.get("id")) + "（" + name + "），状态=" + status_text(session.get("status"))
                )
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(self._err("新建后台终端", exc))
            return

        if sub in {"file", "logfile", "文件"}:
            denied = self._manage_denied(event)
            if denied:
                yield event.plain_result(denied)
                return
            feature = self._feature_denied("allow_create", True)
            if feature:
                yield event.plain_result(feature)
                return
            segments = [segment.strip() for segment in rest.split("|")]
            if len(segments) < 2 or not segments[0] or not segments[1]:
                yield event.plain_result("用法：/logmgr file <名称> | <日志路径>")
                return
            name = segments[0]
            file_path = segments[1]
            try:
                session = await self.client.create_session(
                    {
                        "name": name,
                        "type": "file",
                        "path": file_path,
                        "autostart": False,
                        "startNow": True,
                        "restartPolicy": "never",
                        "bufferLines": 8000,
                        "historyLines": 400,
                    }
                )
                yield event.plain_result(
                    "已新增日志文件跟踪 " + str(session.get("id")) + "（" + name + "），状态=" + status_text(session.get("status"))
                )
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(self._err("新增日志文件跟踪", exc))
            return

        yield event.plain_result("未知子命令：" + sub + "\n\n" + HELP_TEXT)

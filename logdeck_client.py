"""LogDeck HTTP 客户端（AstrBot 插件用，纯 aiohttp，无其它依赖）。

LogDeck 是本机日志/终端管理器，默认监听 http://127.0.0.1:17890 。
所有请求带 X-LogDeck-Token 头（令牌在 LogDeck 的 config.json 里）。
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

import aiohttp


class LogDeckError(Exception):
    """LogDeck 请求失败（连接错误 / 鉴权错误 / 接口返回错误）。"""


STATUS_MAP = {
    "running": "运行中",
    "starting": "启动中",
    "stopping": "停止中",
    "stopped": "已停止",
    "exited": "已退出",
    "crashed": "已崩溃",
    "error": "错误",
}


_ANSI_RE = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]"
)


def strip_ansi(text: Any) -> str:
    return _ANSI_RE.sub("", str(text or ""))


def status_text(status: Any) -> str:
    return STATUS_MAP.get(str(status or ""), str(status or "未知"))


def format_sessions(sessions: list[dict[str, Any]]) -> str:
    if not sessions:
        return "日志管理器里还没有任何会话。可以用 logmgr_create_session 新建一个后台终端，或 logmgr_add_log_file 跟踪一个日志文件。"
    running = sum(1 for item in sessions if item.get("status") == "running")
    lines = ["日志管理器里共 " + str(len(sessions)) + " 个会话（运行中 " + str(running) + " 个）："]
    for index, item in enumerate(sessions, start=1):
        session_id = str(item.get("id") or "")
        name = str(item.get("name") or "")
        kind = "日志文件" if item.get("type") == "file" else "后台终端"
        parts = [
            str(index) + ". id=" + session_id,
            name,
            kind + "/" + status_text(item.get("status")),
        ]
        pid = item.get("pid")
        if pid:
            parts.append("PID " + str(pid))
        health_check = item.get("healthCheck") or {}
        health = item.get("health") or {}
        if health_check and health:
            port = str(health_check.get("port") or "")
            if health.get("ok"):
                parts.append("端口 " + port + " OK")
            else:
                parts.append("端口 " + port + " 异常")
        tags = item.get("tags") or []
        if tags:
            parts.append("标签 " + "/".join(str(tag) for tag in tags))
        if item.get("restarts"):
            parts.append("已重启 " + str(item.get("restarts")) + " 次")
        if item.get("type") == "file":
            parts.append("文件 " + str(item.get("path") or ""))
        else:
            parts.append("命令 " + str(item.get("command") or ""))
        lines.append(" · ".join(parts))
    lines.append("读日志用 logmgr_read_logs(session_id, lines)；启动/停止用 logmgr_manage_session。")
    return "\n".join(lines)


def format_search_results(results: list[dict[str, Any]], keyword: str) -> str:
    if not results:
        return "在日志缓冲里没有搜到「" + keyword + "」。"
    lines = ["搜索「" + keyword + "」命中 " + str(len(results)) + " 个会话："]
    for item in results:
        lines.append("== " + str(item.get("id")) + "（" + str(item.get("name")) + "）==")
        for match in item.get("matches") or []:
            text = strip_ansi(match.get("text") or "").strip()
            if len(text) > 500:
                text = text[:500] + "…"
            lines.append("  " + text)
    return "\n".join(lines)


def format_health(info: dict[str, Any], sessions: list[dict[str, Any]]) -> str:
    running = [item for item in sessions if item.get("status") == "running"]
    lines = [
        "LogDeck 日志管理器在线：v" + str(info.get("version")) + "，PID " + str(info.get("pid")) + "，地址 " + str(info.get("host")) + ":" + str(info.get("port")),
        "会话 " + str(len(sessions)) + " 个，运行中 " + str(len(running)) + " 个。",
    ]
    for item in sessions:
        line = "- " + str(item.get("id")) + "（" + str(item.get("name")) + "）：" + status_text(item.get("status"))
        health_check = item.get("healthCheck") or {}
        health = item.get("health") or {}
        if health_check and health:
            if health.get("ok"):
                line += "，端口 " + str(health_check.get("port")) + " 正常"
            else:
                line += "，端口 " + str(health_check.get("port")) + " 异常"
        lines.append(line)
    return "\n".join(lines)


class LogDeckClient:
    def __init__(self, base_url: str, token: str = "", timeout: float = 10.0) -> None:
        self.base_url = (base_url or "http://127.0.0.1:17890").rstrip("/")
        self.token = token or ""
        self.timeout = float(timeout or 10.0)

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["X-LogDeck-Token"] = self.token
        return headers

    async def _request_raw(self, method: str, path: str, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> tuple[int, str]:
        url = self.base_url + path
        timeout = aiohttp.ClientTimeout(total=self.timeout)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.request(method, url, params=params, json=body, headers=self._headers()) as response:
                    text = await response.text()
                    return response.status, text
        except LogDeckError:
            raise
        except (aiohttp.ClientError, TimeoutError, OSError) as exc:
            raise LogDeckError("无法连接 LogDeck 管理器（" + self.base_url + "）：" + str(exc)) from exc

    async def _request(self, method: str, path: str, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> Any:
        status, text = await self._request_raw(method, path, params=params, body=body)
        data: Any = None
        if text:
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = None
        if status >= 400:
            message = ""
            if isinstance(data, dict):
                message = str(data.get("error") or "")
            raise LogDeckError(message or ("HTTP " + str(status)))
        if isinstance(data, dict) and data.get("ok") is False:
            raise LogDeckError(str(data.get("error") or "LogDeck 返回了错误"))
        return data

    async def info(self) -> dict[str, Any]:
        data = await self._request("GET", "/api/info")
        return data if isinstance(data, dict) else {}

    async def list_sessions(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/sessions")
        sessions = (data or {}).get("sessions") if isinstance(data, dict) else None
        return list(sessions or [])

    async def get_session(self, session_id: str) -> dict[str, Any]:
        data = await self._request("GET", "/api/sessions/" + quote(str(session_id), safe=""))
        session = (data or {}).get("session") if isinstance(data, dict) else None
        return session if isinstance(session, dict) else {}

    async def read_log_text(self, session_id: str, lines: int = 80, keyword: str = "") -> str:
        params: dict[str, Any] = {
            "tail": str(max(1, min(int(lines), 5000))),
            "plain": "1",
            "timestamps": "1",
        }
        if keyword:
            params["grep"] = keyword
        status, text = await self._request_raw(
            "GET",
            "/api/sessions/" + quote(str(session_id), safe="") + "/log",
            params=params,
        )
        if status >= 400:
            raise LogDeckError("读取日志失败（HTTP " + str(status) + "）")
        return text

    async def search(self, keyword: str, session_id: str = "", lines: int = 10) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "q": keyword,
            "limit": str(max(1, min(int(lines), 50))),
        }
        if session_id:
            params["ids"] = session_id
        data = await self._request("GET", "/api/search", params=params)
        results = (data or {}).get("results") if isinstance(data, dict) else None
        return list(results or [])

    async def create_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        data = await self._request("POST", "/api/sessions", body=payload)
        session = (data or {}).get("session") if isinstance(data, dict) else None
        return session if isinstance(session, dict) else {}

    async def manage_session(self, session_id: str, action: str) -> dict[str, Any]:
        data = await self._request(
            "POST",
            "/api/sessions/" + quote(str(session_id), safe="") + "/" + action,
            body={},
        )
        session = (data or {}).get("session") if isinstance(data, dict) else None
        return session if isinstance(session, dict) else {}

    async def delete_session(self, session_id: str) -> None:
        await self._request(
            "DELETE",
            "/api/sessions/" + quote(str(session_id), safe="") + "?deleteLog=1",
        )

    async def clear_logs(self, session_id: str) -> dict[str, Any]:
        data = await self._request(
            "POST",
            "/api/sessions/" + quote(str(session_id), safe="") + "/clear",
            body={},
        )
        session = (data or {}).get("session") if isinstance(data, dict) else None
        return session if isinstance(session, dict) else {}

    async def send_input(self, session_id: str, text: str) -> dict[str, Any]:
        data = await self._request(
            "POST",
            "/api/sessions/" + quote(str(session_id), safe="") + "/input",
            body={"text": text, "enter": True},
        )
        session = (data or {}).get("session") if isinstance(data, dict) else None
        return session if isinstance(session, dict) else {}

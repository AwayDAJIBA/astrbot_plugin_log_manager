"""LogDeck manager bootstrap for the AstrBot plugin.

The bundled web manager (logdeck/) is a plain Node.js HTTP service. This module
starts it in the background when the plugin loads, generates a local access
token on first run, and waits until /api/info answers.

Only the Python standard library is used here, so it can be unit-tested
without AstrBot.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DEFAULT_MANAGER_URL = "http://127.0.0.1:17890"
DEFAULT_PORT = 17890


class ManagerStartError(RuntimeError):
    """Raised when the bundled manager cannot be started or reached."""


class ManagerLauncher:
    def __init__(
        self,
        plugin_root: str | Path,
        data_dir: str | Path,
        manager_url: str = DEFAULT_MANAGER_URL,
        token: str = "",
        node_path: str = "",
        auto_start: bool = True,
        start_timeout: float = 25.0,
    ) -> None:
        self.plugin_root = Path(plugin_root).resolve()
        self.logdeck_dir = self.plugin_root / "logdeck"
        self.data_dir = Path(data_dir).resolve()
        self.config_path = self.data_dir / "config.json"
        self.launch_log = self.data_dir / "manager-launch.log"
        self.manager_url = (manager_url or DEFAULT_MANAGER_URL).rstrip("/")
        self.token = (token or "").strip()
        self.node_path = (node_path or "").strip().strip('"')
        self.auto_start = bool(auto_start)
        self.start_timeout = max(5.0, float(start_timeout or 25.0))
        self.last_probe_status: int | None = None
        self._process: subprocess.Popen[Any] | None = None

    # ---------------- public API ----------------
    def ensure_running(self) -> dict[str, Any]:
        """Return /api/info, starting the bundled manager when needed."""
        info = self._probe()
        if info:
            return info

        # If a config already exists, its token is authoritative and can make a
        # manually started manager reachable.
        if self.config_path.is_file():
            try:
                cfg = json.loads(self.config_path.read_text("utf-8"))
                cfg_token = str(cfg.get("token") or "").strip()
                if cfg_token:
                    self.token = cfg_token
                    info = self._probe()
                    if info:
                        self._apply_config_endpoint(cfg)
                        return info
            except Exception:  # noqa: BLE001 - corrupted config is handled below
                pass

        if not self.auto_start:
            raise ManagerStartError(
                "LogDeck 管理器未运行（auto_start=false）。请先手动启动管理器，"
                "或在插件配置里打开 auto_start。"
            )

        self._prepare_config()
        self._spawn()
        deadline = time.time() + self.start_timeout
        while time.time() < deadline:
            time.sleep(0.4)
            info = self._probe()
            if info:
                return info
        hint = ""
        if self.last_probe_status == 401:
            hint = "（端口上已有实例在运行，但 token 不匹配，请在插件配置里填写正确的 token）"
        raise ManagerStartError(
            "启动 LogDeck 管理器超时" + hint + "。启动日志：" + self._tail_launch_log()
        )

    # ---------------- internals ----------------
    def _apply_config_endpoint(self, cfg: dict[str, Any]) -> None:
        host = str(cfg.get("host") or "127.0.0.1")
        try:
            port = int(cfg.get("port") or DEFAULT_PORT)
        except Exception:  # noqa: BLE001
            port = DEFAULT_PORT
        self.manager_url = "http://" + host + ":" + str(port)

    def _probe(self) -> dict[str, Any] | None:
        url = self.manager_url + "/api/info"
        headers = {"Accept": "application/json"}
        if self.token:
            headers["X-LogDeck-Token"] = self.token
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=2.0) as response:
                self.last_probe_status = int(response.status)
                if response.status != 200:
                    return None
                data = json.loads(response.read().decode("utf-8", "replace"))
                if isinstance(data, dict) and data.get("ok"):
                    return data
                return None
        except urllib.error.HTTPError as exc:
            self.last_probe_status = int(exc.code)
            return None
        except Exception:  # noqa: BLE001 - connection refused / timeout
            self.last_probe_status = None
            return None

    def _prepare_config(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        cfg: dict[str, Any] | None = None
        if self.config_path.is_file():
            try:
                loaded = json.loads(self.config_path.read_text("utf-8"))
                if isinstance(loaded, dict):
                    cfg = loaded
            except Exception:  # noqa: BLE001
                cfg = None

        if cfg is None:
            parsed = urlparse(self.manager_url)
            host = parsed.hostname or "127.0.0.1"
            if host not in {"127.0.0.1", "localhost", "::1"}:
                raise ManagerStartError(
                    "auto_start 只支持本机地址；当前 manager_url=" + self.manager_url
                )
            port = parsed.port or DEFAULT_PORT
            token = self.token or secrets.token_hex(24)
            cfg = {
                "name": "LogDeck",
                "host": host,
                "port": port,
                "token": token,
                "dataDir": "data",
                "startAllOnBoot": True,
                "takeoverIntervalMs": 5000,
                "sessions": [],
                "ui": {},
            }
            self.config_path.write_text(
                json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            self.token = token
        else:
            token = str(cfg.get("token") or "").strip()
            if not token:
                token = self.token or secrets.token_hex(24)
                cfg["token"] = token
                self.config_path.write_text(
                    json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
            self.token = token

        self._apply_config_endpoint(cfg)

    def _resolve_node(self) -> str:
        candidates = [self.node_path] if self.node_path else []
        candidates.extend(["node", "node.exe", "nodejs"])
        for candidate in candidates:
            if not candidate:
                continue
            found = shutil.which(candidate)
            if found:
                return found
        raise ManagerStartError(
            "未找到 Node.js。LogDeck 管理器需要 Node.js 18+，请安装后把 node 加入 PATH，"
            "或在插件配置里填写 node_path。"
        )

    def _spawn(self) -> None:
        server_js = self.logdeck_dir / "server.js"
        if not server_js.is_file():
            raise ManagerStartError("插件内置的 LogDeck 文件缺失：" + str(server_js))
        node = self._resolve_node()
        self.launch_log.parent.mkdir(parents=True, exist_ok=True)
        command = [node, str(server_js), "--config", str(self.config_path)]
        with open(self.launch_log, "ab") as log_handle:
            payload = (
                "\n[" + time.strftime("%Y-%m-%d %H:%M:%S") + "] launch: "
                + " ".join(command) + "\n"
            ).encode("utf-8", "replace")
            log_handle.write(payload)
            log_handle.flush()
            kwargs: dict[str, Any] = {
                "cwd": str(self.logdeck_dir),
                "stdin": subprocess.DEVNULL,
                "stdout": log_handle,
                "stderr": subprocess.STDOUT,
                "env": dict(os.environ),
            }
            if os.name == "nt":
                flags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
                flags |= int(getattr(subprocess, "DETACHED_PROCESS", 0))
                if flags:
                    kwargs["creationflags"] = flags
            else:
                kwargs["start_new_session"] = True
            self._process = subprocess.Popen(command, **kwargs)
        try:
            (self.data_dir / "manager.pid").write_text(
                json.dumps(
                    {
                        "pid": self._process.pid,
                        "url": self.manager_url,
                        "started_at": time.time(),
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _tail_launch_log(self, max_chars: int = 4000) -> str:
        try:
            text = self.launch_log.read_text("utf-8", errors="replace")
        except OSError:
            return "(no launch log)"
        text = text.strip()
        if not text:
            return "(empty launch log)"
        return text[-max_chars:]

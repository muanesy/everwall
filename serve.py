"""
本地开发服务器。

和 `python -m http.server` 的区别：
1. 给所有文件加上禁止缓存的响应头，改完代码后普通刷新就能拿到最新版本；
2. 提供 `/__build` 接口，把当前 git 提交告诉页面，开始页那行版本标记
   就不用再手工维护（以前是手写的，改了一堆东西它也不会变，
   看起来就像"根本没好"）。

用法：双击 start-game.bat，或者命令行运行 python serve.py
"""

import json
import os
import socket
import subprocess
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765

# /__build 的缓存：1 秒内重复请求直接复用，避免每次刷新都 fork 三个 git
_build_cache = {"at": 0.0, "data": None}


def _git(args, cwd):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=3,
    ).stdout.strip()


def build_info(root):
    """返回 {commit, time, dirty}；没有 git 或不是仓库时返回 None。"""
    now = time.time()
    if now - _build_cache["at"] < 1.0:
        return _build_cache["data"]

    data = None
    try:
        commit = _git(["rev-parse", "--short", "HEAD"], root)
        if commit:
            data = {
                "commit": commit,
                "time": _git(["log", "-1", "--format=%cd", "--date=format:%m-%d %H:%M"], root),
                "dirty": bool(_git(["status", "--porcelain"], root)),
            }
    except (OSError, subprocess.SubprocessError):
        data = None

    _build_cache["at"] = now
    _build_cache["data"] = data
    return data


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_build(self, with_body):
        info = build_info(os.path.dirname(os.path.abspath(__file__))) or {}
        body = json.dumps(info).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if with_body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/__build":
            self._send_build(True)
            return
        super().do_GET()

    def do_HEAD(self):
        # 只为了 curl -I / 一些客户端探测时不报 404，浏览器实际用 GET
        if self.path.split("?")[0] == "/__build":
            self._send_build(False)
            return
        super().do_HEAD()


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    # 不管从哪个目录启动，都服务脚本所在的文件夹
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    try:
        httpd = ThreadingHTTPServer(("", PORT), NoCacheHandler)
    except OSError:
        print(f"端口 {PORT} 被占用，先关掉之前打开的服务器窗口再试。")
        raise SystemExit(1)

    print(f"本机访问：http://localhost:{PORT}/")

    ip = lan_ip()
    if ip:
        print(f"手机访问：http://{ip}:{PORT}/  （手机和电脑要连同一个 WiFi）")

    print("按 Ctrl+C 或关掉窗口停止。")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

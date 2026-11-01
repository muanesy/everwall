"""
本地开发服务器。

和 `python -m http.server` 的区别：给所有文件加上禁止缓存的响应头。
这样改完代码后，浏览器普通刷新就能拿到最新版本，不用无痕窗口或者强制刷新。

用法：双击 start-game.bat，或者命令行运行 python serve.py
"""

import os
import socket
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


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

#!/usr/bin/env python3
"""
Static dev server for the WASM Video Player.

Why this exists instead of `python -m http.server`:
  * Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy, so the page is
    cross-origin isolated and SharedArrayBuffer is available (FFmpeg.wasm's
    pthread build needs it).
  * `application/wasm` MIME type, otherwise the streaming compile fails.
  * HTTP Range support, so <video> can seek a directly-played file instead of
    waiting for the whole thing to download.
  * ThreadingHTTPServer, so the 23 MB wasm and the video file do not block each
    other (or block the worker's chunk fetches).
"""

import http.server
import os
import re
import socketserver
import sys

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = http.server.SimpleHTTPRequestHandler.extensions_map.copy()
    extensions_map[".wasm"] = "application/wasm"
    extensions_map[".js"] = "application/javascript"
    extensions_map[".mjs"] = "application/javascript"
    extensions_map[".vtt"] = "text/vtt"
    extensions_map[".mkv"] = "video/x-matroska"
    extensions_map[".avi"] = "video/x-msvideo"

    # HTTP/1.0 on purpose. Emscripten's synchronous XHR against the wasm binary
    # never completes when the server holds a keep-alive HTTP/1.1 connection, so
    # the worker hangs on "loading ffmpeg-core" forever. HTTP/1.0 closes per
    # request and the loader finishes in ~1.5 s.
    protocol_version = "HTTP/1.0"

    # ------------------------------------------------------------------ headers
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")

        clean_path = self.path.split("?")[0].split("#")[0]
        if clean_path.endswith(".wasm"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif clean_path.endswith((".js", ".mjs")):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "no-store")

        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -------------------------------------------------------------- range support
    def send_head(self):
        """Serve 206 Partial Content when the client sends a Range header."""
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            size = os.fstat(f.fileno()).st_size
            match = RANGE_RE.match(range_header.strip())
            if not match:
                f.close()
                self.send_error(400, "Malformed Range header")
                return None

            start_s, end_s = match.group(1), match.group(2)
            if start_s == "" and end_s == "":
                f.close()
                self.send_error(400, "Empty Range")
                return None
            if start_s == "":
                # suffix range: last N bytes
                length = min(int(end_s), size)
                start = size - length
                end = size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
                end = min(end, size - 1)

            if start > end or start >= size:
                f.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None

            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()

            f.seek(start)
            self._range_remaining = end - start + 1
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)

        self._range_remaining = None
        chunk = 64 * 1024
        try:
            while remaining > 0:
                buf = source.read(min(chunk, remaining))
                if not buf:
                    break
                outputfile.write(buf)
                remaining -= len(buf)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        # Only log errors/warnings; the wasm + chunk traffic is too noisy otherwise.
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_server(port=8000):
    handler = CORSRequestHandler
    with ThreadedServer(("", port), handler) as httpd:
        # ASCII-only: the Windows console code page is cp874 and dies on emoji.
        print(f"Dev server running at http://localhost:{port}")
        print("  cross-origin isolated (COOP/COEP) -> SharedArrayBuffer available")
        print("  application/wasm MIME type -> FFmpeg.wasm compiles")
        print("  HTTP Range requests -> seeking works on directly-played files")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("Server stopped")


if __name__ == "__main__":
    run_server(int(sys.argv[1]) if len(sys.argv) > 1 else 8000)

#!/usr/bin/env python3
"""
Simple HTTP server with CORS headers for FFmpeg.wasm
This enables SharedArrayBuffer support required for multi-threading
"""

import http.server
import socketserver
import os
from urllib.parse import urlparse

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Required headers for SharedArrayBuffer (FFmpeg.wasm multi-threading)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        
        # Additional CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        
        # Cache control for better performance
        if self.path.endswith('.wasm'):
            self.send_header('Cache-Control', 'public, max-age=31536000')
        elif self.path.endswith('.js'):
            self.send_header('Cache-Control', 'public, max-age=86400')
        
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

def run_server(port=8000):
    """Run the server with CORS headers"""
    handler = CORSRequestHandler
    
    with socketserver.TCPServer(("", port), handler) as httpd:
        print(f"🚀 FFmpeg.wasm-compatible server running at http://localhost:{port}")
        print("📋 Features enabled:")
        print("   ✅ Cross-Origin-Opener-Policy: same-origin")
        print("   ✅ Cross-Origin-Embedder-Policy: require-corp")
        print("   ✅ SharedArrayBuffer support")
        print("   ✅ FFmpeg.wasm multi-threading")
        print("\n🎬 Ready for real video conversion!")
        print("Press Ctrl+C to stop the server")
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n👋 Server stopped")

if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    run_server(port)
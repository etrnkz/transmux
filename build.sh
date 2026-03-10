#!/bin/bash

# Build script for WASM Video Player

echo "🔧 Building WASM Video Player..."

# Check if wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "❌ wasm-pack is not installed. Installing..."
    cargo install wasm-pack
fi

# Build the WebAssembly module
echo "📦 Building WebAssembly module..."
wasm-pack build --target web --out-dir pkg

if [ $? -eq 0 ]; then
    echo "✅ Build successful!"
    echo "🚀 You can now run: npm run serve"
    echo "🌐 Then open: http://localhost:8000"
else
    echo "❌ Build failed!"
    exit 1
fi
@echo off
echo 🔧 Building WASM Video Player...

REM Check if wasm-pack is installed
where wasm-pack >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ wasm-pack is not installed. Installing...
    cargo install wasm-pack
)

REM Build the WebAssembly module
echo 📦 Building WebAssembly module...
wasm-pack build --target web --out-dir pkg

if %ERRORLEVEL% EQU 0 (
    echo ✅ Build successful!
    echo 🚀 You can now run: npm run serve
    echo 🌐 Then open: http://localhost:8000
) else (
    echo ❌ Build failed!
    exit /b 1
)
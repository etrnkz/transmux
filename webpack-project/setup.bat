@echo off
echo 🚀 Setting up FFmpeg WASM Video Player with Webpack...

REM Install dependencies
echo 📦 Installing dependencies...
npm install

REM Create dist directory if it doesn't exist
if not exist "dist" mkdir dist

echo ✅ Setup complete!
echo.
echo 🎬 To start development server:
echo    npm run dev
echo.
echo 🏗️  To build for production:
echo    npm run build
echo.
echo 🌐 Development server will run at: http://localhost:8080
pause
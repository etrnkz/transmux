#!/bin/bash

echo "🚀 Setting up FFmpeg WASM Video Player with Webpack..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Create dist directory if it doesn't exist
mkdir -p dist

echo "✅ Setup complete!"
echo ""
echo "🎬 To start development server:"
echo "   npm run dev"
echo ""
echo "🏗️  To build for production:"
echo "   npm run build"
echo ""
echo "🌐 Development server will run at: http://localhost:8080"
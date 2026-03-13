const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: {
    main: './src/index.js',
    'ffmpeg-worker': './src/worker.js'
  },
  
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: (pathData) => {
      return pathData.chunk.name === 'ffmpeg-worker' ? '[name].js' : '[name].[contenthash].js';
    },
    clean: true,
    publicPath: '/'
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },

  plugins: [
    new HtmlWebpackPlugin({
      template: './src/index.html',
      filename: 'index.html',
      chunks: ['main']
    })
  ],

  resolve: {
    fallback: {
      "fs": false,
      "path": false,
      "crypto": false
    }
  },

  // Suppress FFmpeg dynamic import warnings
  ignoreWarnings: [
    {
      module: /node_modules\/@ffmpeg\/ffmpeg/,
      message: /Critical dependency: the request of a dependency is an expression/,
    },
  ],

  devServer: {
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    compress: true,
    port: 8082,
    hot: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
  },

  optimization: {
    splitChunks: {
      chunks: (chunk) => {
        // Don't split the worker chunk
        return chunk.name !== 'ffmpeg-worker';
      },
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          chunks: (chunk) => chunk.name !== 'ffmpeg-worker',
        }
      }
    }
  }
};
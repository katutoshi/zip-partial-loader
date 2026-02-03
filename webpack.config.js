const path = require('path');
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = (env, args) => {
  const lszlConfigs = require('./webpack.config.lszl')(env, args);
  return [
    ...lszlConfigs,
    {
      mode: 'development',
      entry: ['./static/index.ts'],
      output: {
        path: path.resolve(__dirname, "dist"),
        filename: "index.js"
      },
      plugins: [
        new CopyWebpackPlugin({
          patterns: [
            {
              from: './static',
              globOptions: {
                ignore: ['**/*.ts', '**/*.js', '**/.*']
              }
            }
          ]
        })
      ],
      module: {
        rules: [
          {
            test: /\.[tj]s$/,
            exclude: /(node_modules|bower_components)/,
            use: {
              loader: 'esbuild-loader',
              options: {
                loader: 'ts',
                target: 'es2020'
              }
            }
          }
        ]
      },
      resolve: {
        extensions: [".ts", ".js"]
      },
      devServer: {
        allowedHosts: 'all'
      },
      externals: [
        {
          LSZL: true,
        }
      ]
    }
  ];
}

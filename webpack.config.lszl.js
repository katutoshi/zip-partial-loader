const path = require('path');
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = (env, argv) => {
  const entry = [];
  entry.push(path.resolve(__dirname, "./src/lszl/lszl.ts"));
  return [
    require('./webpack.config.lszlw'),
    {
      mode: 'development',
      entry,
      output: {
        path: path.resolve(__dirname, "./dist"),
        filename: "lszl.js",
        library: {
          name: 'LSZL',
          type: 'umd',
          export: 'default',
        },
      },
      plugins: [
        new CopyWebpackPlugin({
          patterns: ['./static/lszl.d.ts']
        }),
      ],
      module: {
        rules: [
          {
            test: /\.[jt]s$/,
            exclude: /(node_modules|bower_components)/,
            loader: 'esbuild-loader',
            options: {
              loader: 'ts',
              target: 'es2020'
            }
          }
        ]
      },
      resolve: {
        extensions: [".ts", ".js"]
      }
    }
  ];
};

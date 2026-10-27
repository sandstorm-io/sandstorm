const { defineConfig } = require("@meteorjs/rspack");
const { IgnorePlugin } = require("@rspack/core");

module.exports = defineConfig((Meteor) => ({
  performance: {
    maxAssetSize: 1024 * 1024,
    maxEntrypointSize: 1536 * 1024,
  },
  resolve: Meteor.isServer
    ? {
        alias: {
          // Undici exposes an optional SQLite cache implementation from its
          // package root. Sandstorm does not enable that interceptor.
          "node:sqlite": false,

          // @root/keypairs probes these native packages only on very old Node
          // releases. Meteor's dev bundle has crypto.generateKeyPairSync().
          ursa: false,
          "ursa-optional": false,
        },
      }
    : undefined,
  module: {
    rules: [
      {
        test: /\.scss$/i,
        use: [
          {
            loader: "sass-loader",
            options: {
              api: "modern-compiler",
              implementation: require.resolve("sass-embedded"),
            },
          },
        ],
        type: "css/auto",
      },
    ],
  },
  plugins: Meteor.isServer
    ? [
        new IgnorePlugin({
          resourceRegExp: /^(node:sqlite|ursa|ursa-optional)$/,
        }),
      ]
    : [],
}));

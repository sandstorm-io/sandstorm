const { defineConfig } = require("@meteorjs/rspack");
const { IgnorePlugin } = require("@rspack/core");

module.exports = defineConfig((Meteor) => ({
  resolve: Meteor.isServer
    ? {
        // Undici exposes an optional SQLite cache implementation from its
        // package root. Sandstorm does not enable that interceptor.
        alias: { "node:sqlite": false },
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
    ? [new IgnorePlugin({ resourceRegExp: /^node:sqlite$/ })]
    : [],
  externals: Meteor.isServer
    ? {
        ursa: "commonjs ursa",
        "ursa-optional": "commonjs ursa-optional",
      }
    : undefined,
}));

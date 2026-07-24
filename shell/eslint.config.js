"use strict";

const eslint = require("@eslint/js");
const globals = require("globals");
const typescriptParser = require("@typescript-eslint/parser");

const files = ["**/*.js", "**/*.ts"];
const commonGlobals = {
  ...globals.es2020,
  ...globals["shared-node-browser"],
};

module.exports = [
  {
    ignores: [
      "**/node_modules/**",
      "**/.meteor/**",
      "**/_build/**",
      "**/build-assets/**",
      "**/build-chunks/**",
    ],
  },
  {
    files,
    languageOptions: {
      parser: typescriptParser,
      ecmaVersion: 2020,
      sourceType: "module",
      parserOptions: {
        allowImportExportEverywhere: true,
      },
      globals: commonGlobals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "no-undef": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-empty": "warn",
      "no-inner-declarations": "warn",
      "no-useless-assignment": "warn",
    },
  },
  {
    files,
    ignores: ["**/client/**", "**/server/**", "**/shared/**"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["**/client/**/*.{js,ts}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ["**/server/**/*.{js,ts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.tests.{js,ts}", "**/packages/**/{rendezvous.tests,*.tests}.{js,ts}"],
    languageOptions: {
      globals: globals.mocha,
    },
  },
];

export default [
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "no-constant-condition": "warn",
      "no-debugger": "warn",
      "no-duplicate-case": "error",
      "no-empty": "warn",
      "no-sparse-arrays": "error",
      "no-unreachable": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "eqeqeq": ["warn", "always", { null: "ignore" }],
      "no-caller": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-self-compare": "error",
    },
  },
  {
    ignores: [".next/", "node_modules/", "out/"],
  },
]

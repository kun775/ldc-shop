import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      // The codebase still has legacy D1/Drizzle boundary casts. Keep them visible
      // without making the newly restored lint command unusable.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".probe/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
])

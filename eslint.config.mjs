import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The Cut: only lib/email/send.ts may talk to Resend; only lib/gemini/ may talk to Gemini.
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "resend", message: "All Resend calls go through lib/email/send.ts." },
            { name: "@google/genai", message: "All Gemini calls go through lib/gemini/." },
          ],
        },
      ],
    },
  },
  { files: ["lib/email/send.ts"], rules: { "no-restricted-imports": "off" } },
  { files: ["lib/gemini/**"], rules: { "no-restricted-imports": "off" } },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "drizzle/**"]),
]);

export default eslintConfig;

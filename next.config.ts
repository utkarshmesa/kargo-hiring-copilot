import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The rubric and seed lists are read at runtime; ship them with every function.
  outputFileTracingIncludes: {
    "/**": ["./docs/kargo_hiring_rubric.md", "./lists/**"],
  },
};

export default nextConfig;

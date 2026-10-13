import process from "node:process";

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir:
    process.env.ZET_UI_REVIEW_VARIANT === "sessions"
      ? ".next-sessions"
      : process.env.ZET_UI_REVIEW_VARIANT === "sidebar"
        ? ".next-sidebar"
        : process.env.ZET_UI_REVIEW_BUILD === "1"
          ? ".next-review"
          : ".next",
  reactStrictMode: true,
  devIndicators: false,
  transpilePackages: ["@zet-harness/shared"],
};

export default nextConfig;

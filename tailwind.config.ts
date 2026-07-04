import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-outfit)", "system-ui", "sans-serif"],
      },
      colors: {
        carysil: {
          stone: "#1a1a1a",
          sand: "#fafafa",
          // Distinct amber accent (was a duplicate of `red`) — validated as a
          // categorical pair with `red` via the dataviz skill's palette
          // validator (CVD ΔE 18.6, well above the 12 target).
          gold: "#ab7400",
          charcoal: "#2d2d2d",
          red: "#c5222f",
          success: "#0ca30c",
          warning: "#fab219",
        },
      },
    },
  },
  plugins: [],
};
export default config;

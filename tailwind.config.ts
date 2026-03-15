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
          gold: "#c5222f",
          charcoal: "#2d2d2d",
          red: "#c5222f",
        },
      },
    },
  },
  plugins: [],
};
export default config;

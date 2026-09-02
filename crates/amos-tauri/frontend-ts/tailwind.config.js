/** @type {import('tailwindcss').Config} */
export default {
  // class strategy so a single `dark` class on <html> drives both our manual
  // toggle and prefers-color-scheme ("auto") without duplicating rules.
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: "#0a84ff",
        danger: "#ff3b30",
      },
    },
  },
  plugins: [],
};

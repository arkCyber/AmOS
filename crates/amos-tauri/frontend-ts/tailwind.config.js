/** @type {import('tailwindcss').Config} */
export default {
  // class strategy so a single `dark` class on <html> drives both our manual
  // toggle and prefers-color-scheme ("auto") without duplicating rules.
  darkMode: "class",
  // REQ-A257: a hover style must never stick on a touch device. With
  // `hoverOnlyWhenSupported`, Tailwind's `hover:*` utilities are wrapped in
  // `@media (hover: hover)` automatically — without it, a `:hover` rule that
  // was meant for a desktop dock would apply on a tablet's last-tap state and
  // trap a control "visible" after the user moves on. The setting was lost in
  // a recent config rewrite; the hover-scan gate fails loudly when it goes.
  future: {
    hoverOnlyWhenSupported: true,
  },
  content: ["./index.html", "./src/**/*.{ts,tsx,svelte}"],
  theme: {
    extend: {
      fontFamily: {
        // macOS SF Pro 字体栈（系统默认）
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'SF Pro Display',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        // 等宽字体（代码、时间戳、SKU）
        mono: [
          'SF Mono',
          'Monaco',
          'Menlo',
          'Consolas',
          'Courier New',
          'monospace',
        ],
      },
      colors: {
        accent: "rgb(var(--accent) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        // iOS system colors for consistency
        ios: {
          blue: "#007AFF",
          green: "#34C759",
          red: "#FF3B30",
          orange: "#FF9500",
          yellow: "#FFCC00",
          gray: "#8E8E93",
          lightGray: "#E5E5EA", // message bubble background
          darkGray: "#3C3C43",
        },
        "ios-green": "#34C759",
        "ios-blue": "#007AFF",
        "ios-red": "#FF3B30",
        "ios-lightGray": "#E5E5EA",
        "ios-darkGray": "#3C3C43",
      },
      fontSize: {
        // iOS Typography Scale (mobile apps)
        "ios-largeTitle": ["34px", { lineHeight: "41px", fontWeight: "700" }],
        "ios-large-title": ["34px", { lineHeight: "41px", fontWeight: "700" }],
        "ios-title1": ["28px", { lineHeight: "34px", fontWeight: "700" }],
        "ios-title2": ["22px", { lineHeight: "28px", fontWeight: "600" }],
        "ios-title3": ["20px", { lineHeight: "25px", fontWeight: "600" }],
        "ios-body": ["17px", { lineHeight: "22px", fontWeight: "400" }],
        "ios-callout": ["16px", { lineHeight: "21px", fontWeight: "400" }],
        "ios-subhead": ["15px", { lineHeight: "20px", fontWeight: "400" }],
        "ios-footnote": ["13px", { lineHeight: "18px", fontWeight: "400" }],
        "ios-caption1": ["12px", { lineHeight: "16px", fontWeight: "400" }],
        "ios-caption2": ["11px", { lineHeight: "13px", fontWeight: "400" }],
        // macOS Typography Scale (desktop chrome/apps)
        "macos-large-title": ["26px", { lineHeight: "32px", fontWeight: "700" }],
        "macos-title1": ["22px", { lineHeight: "26px", fontWeight: "700" }],
        "macos-title2": ["17px", { lineHeight: "22px", fontWeight: "600" }],
        "macos-title3": ["15px", { lineHeight: "20px", fontWeight: "600" }],
        "macos-headline": ["13px", { lineHeight: "16px", fontWeight: "600" }],
        "macos-body": ["13px", { lineHeight: "16px", fontWeight: "400" }],
        "macos-callout": ["12px", { lineHeight: "15px", fontWeight: "400" }],
        "macos-subheadline": ["11px", { lineHeight: "14px", fontWeight: "400" }],
        "macos-footnote": ["10px", { lineHeight: "13px", fontWeight: "400" }],
        "macos-caption": ["10px", { lineHeight: "13px", fontWeight: "400" }],
      },
      borderRadius: {
        // iOS Border Radius Scale
        "ios-sm": "8px",
        "ios-md": "10px",
        "ios-lg": "13px",
        "ios-bubble": "18px",
        "ios-card": "12px",
        "ios-input": "10px",
      },
      minHeight: {
        // iOS minimum touch target
        touch: "44px",
      },
      minWidth: {
        touch: "44px",
      },
      keyframes: {
        "avatar-bounce": {
          "0%, 100%": { transform: "scale(1) rotate(0deg)" },
          "25%": { transform: "scale(1.15) rotate(-5deg)" },
          "50%": { transform: "scale(1.2) rotate(5deg)" },
          "75%": { transform: "scale(1.15) rotate(-3deg)" },
        },
        "avatar-flip": {
          "0%": { transform: "rotateY(0deg)" },
          "100%": { transform: "rotateY(360deg)" },
        },
        "avatar-spin": {
          "0%": { transform: "rotate(0deg) scale(1)" },
          "50%": { transform: "rotate(180deg) scale(1.1)" },
          "100%": { transform: "rotate(360deg) scale(1)" },
        },
      },
      animation: {
        "avatar-bounce": "avatar-bounce 0.6s ease-in-out",
        "avatar-flip": "avatar-flip 0.6s ease-in-out",
        "avatar-spin": "avatar-spin 1.2s ease-in-out",
      },
    },
  },
  plugins: [],
};

<!--
  IconFinder.svelte — macOS Finder icon (happy face)
  Replaces the 💻 emoji with a clean, vector SVG matching macOS Finder design.
-->
<svg
  viewBox="0 0 64 64"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  class="w-full h-full"
  aria-hidden="true"
>
  <!-- Background gradient similar to macOS Finder -->
  <defs>
    <linearGradient id="finder-bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#4A9EED;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#1E7ACC;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- Rounded square background -->
  <rect x="4" y="4" width="56" height="56" rx="12" fill="url(#finder-bg)" />
  
  <!-- Happy Finder face -->
  <g fill="white">
    <!-- Left eye -->
    <circle cx="22" cy="24" r="3" />
    
    <!-- Right eye -->
    <circle cx="42" cy="24" r="3" />
    
    <!-- Smile (using path for better control) -->
    <path
      d="M 18 36 Q 32 48 46 36"
      stroke="white"
      stroke-width="3"
      stroke-linecap="round"
      fill="none"
    />
  </g>
</svg>

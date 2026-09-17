<!--
  IconLaunchpad.svelte — macOS Launchpad icon (3×3 grid of squares)
  Replaces the 🚀 emoji with a clean, vector SVG matching macOS design.
-->
<svg
  viewBox="0 0 64 64"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  class="w-full h-full"
  aria-hidden="true"
>
  <!-- Background gradient similar to macOS Launchpad -->
  <defs>
    <linearGradient id="launchpad-bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#7B8FA0;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#4A5C6A;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- Rounded square background -->
  <rect x="4" y="4" width="56" height="56" rx="12" fill="url(#launchpad-bg)" />
  
  <!-- 3×3 grid of dots/squares -->
  <g fill="white" opacity="0.95">
    <!-- Row 1 -->
    <rect x="14" y="14" width="8" height="8" rx="2" />
    <rect x="28" y="14" width="8" height="8" rx="2" />
    <rect x="42" y="14" width="8" height="8" rx="2" />
    
    <!-- Row 2 -->
    <rect x="14" y="28" width="8" height="8" rx="2" />
    <rect x="28" y="28" width="8" height="8" rx="2" />
    <rect x="42" y="28" width="8" height="8" rx="2" />
    
    <!-- Row 3 -->
    <rect x="14" y="42" width="8" height="8" rx="2" />
    <rect x="28" y="42" width="8" height="8" rx="2" />
    <rect x="42" y="42" width="8" height="8" rx="2" />
  </g>
</svg>

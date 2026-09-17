<!--
  IconTrash.svelte — macOS Trash icon
  Replaces the 🗑️ emoji with a clean, vector SVG matching macOS Trash design.
-->
<svg
  viewBox="0 0 64 64"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  class="w-full h-full"
  aria-hidden="true"
>
  <!-- Background gradient similar to macOS Trash -->
  <defs>
    <linearGradient id="trash-bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#E8E8E8;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#CCCCCC;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- Rounded square background -->
  <rect x="4" y="4" width="56" height="56" rx="12" fill="url(#trash-bg)" />
  
  <!-- Trash can -->
  <g fill="#555555">
    <!-- Lid -->
    <rect x="16" y="18" width="32" height="3" rx="1.5" />
    
    <!-- Handle on lid -->
    <path
      d="M 26 18 L 26 15 Q 26 13 28 13 L 36 13 Q 38 13 38 15 L 38 18"
      stroke="#555555"
      stroke-width="2"
      fill="none"
      stroke-linecap="round"
    />
    
    <!-- Can body (trapezoid shape) -->
    <path
      d="M 18 22 L 20 48 Q 20 50 22 50 L 42 50 Q 44 50 44 48 L 46 22 Z"
      fill="#555555"
    />
    
    <!-- Vertical lines on can -->
    <line x1="26" y1="26" x2="24.5" y2="46" stroke="#888888" stroke-width="1.5" stroke-linecap="round" />
    <line x1="32" y1="26" x2="32" y2="46" stroke="#888888" stroke-width="1.5" stroke-linecap="round" />
    <line x1="38" y1="26" x2="39.5" y2="46" stroke="#888888" stroke-width="1.5" stroke-linecap="round" />
  </g>
</svg>

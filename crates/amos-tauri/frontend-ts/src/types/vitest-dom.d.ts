/**
 * Type extensions for @testing-library/jest-dom matchers in vitest.
 * 
 * Provides DOM-specific assertion methods like `toBeInTheDocument()`.
 */

import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = any> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers {}
}

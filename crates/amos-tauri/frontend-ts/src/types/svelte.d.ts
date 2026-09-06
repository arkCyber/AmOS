/**
 * Ambient module for importing `.svelte` components from TypeScript/JSX.
 *
 * This lets `tsc` (the repo's `typecheck` script, `tsconfig.include: ["src"]`)
 * resolve a dynamic `import("./x.svelte")` made from a React host without
 * erroring on an unknown extension. Svelte files themselves are type-checked
 * by `svelte-check`, which understands real `.svelte` modules directly and is
 * not affected by this broad declaration.
 */
declare module "*.svelte" {
  const component: any;
  export default component;
}

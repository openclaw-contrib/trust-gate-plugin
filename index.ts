/**
 * Root entry point — re-exports from src/index.ts
 * OpenClaw discovers plugins via index.{ts,js} at the plugin root,
 * ignoring package.json "main" field.
 */
export { default } from "./src/index.js";

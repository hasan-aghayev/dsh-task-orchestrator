import { defineConfig } from 'tsdown'

const packageName = 'dsh-task-orchestrator'

/** Build the module-loader-compatible browser half beside the Host package. */
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outDir: 'lib',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: { neverBundle: specifier => ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'].includes(specifier) },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    footer: 'return module.exports; } });',
  },
})

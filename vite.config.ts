import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

/**
 * Where `/llm/*` is forwarded in dev. Override with `LLM_PROXY_TARGET` to test
 * another provider, e.g. `LLM_PROXY_TARGET=https://api.deepseek.com pnpm dev`.
 */
const LLM_PROXY_TARGET = process.env.LLM_PROXY_TARGET ?? 'https://ollama.com'

export default defineConfig({
  plugins: [
    tailwindcss(),
  ],
  server: {
    /**
     * A browser page cannot call most LLM APIs directly: they answer no
     * `Access-Control-Allow-Origin`, and the `Authorization` header forces a
     * preflight the provider refuses. Forwarding through the dev server makes the
     * call same-origin, so the browser sends no preflight at all.
     *
     * Pair it with `* Base URL: /llm` in `secret.md` (no `/v1` suffix — the
     * request path adds `/v1/chat/completions`). This exists only in dev; GitHub
     * Pages serves static files, so a deployed build needs a hosted proxy.
     */
    proxy: {
      '/llm': {
        target: LLM_PROXY_TARGET,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/llm/, ''),
      },
    },
  },
})

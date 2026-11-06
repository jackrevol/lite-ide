import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [
      react(),
      {
        name: 'development-csp',
        transformIndexHtml: {
          order: 'pre',
          handler(html, context) {
            // 개발 서버의 React Fast Refresh 초기화 스크립트만 허용합니다.
            return context.server
              ? html.replace(
                  "script-src 'self';",
                  "script-src 'self' 'unsafe-inline';",
                )
              : html
          },
        },
      },
    ],
  },
})

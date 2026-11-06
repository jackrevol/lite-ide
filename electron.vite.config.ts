import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const packageInfo = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
)
function gitValue(args: string[]) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export default defineConfig(({ command }) => ({
  main: {
    define: {
      __APP_BUILD_INFO__: JSON.stringify({
        name: packageInfo.build.productName,
        version: packageInfo.version,
        repositoryUrl: 'https://github.com/jackrevol/lite-ide',
        buildTime: command === 'build' ? new Date().toISOString() : null,
        commit: gitValue(['rev-parse', 'HEAD']),
        dirty:
          gitValue(['status', '--porcelain']) === null
            ? null
            : !!gitValue(['status', '--porcelain']),
      }),
    },
  },
  preload: {},
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
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
}))

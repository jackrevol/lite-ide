import type { AppInfo } from '../shared/types'

declare const __APP_BUILD_INFO__: Pick<
  AppInfo,
  'name' | 'version' | 'buildTime' | 'repositoryUrl' | 'commit' | 'dirty'
>

export function appInfo(packaged: boolean, version: string): AppInfo {
  return {
    ...__APP_BUILD_INFO__,
    version: packaged ? version : __APP_BUILD_INFO__.version,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    packaged,
  }
}

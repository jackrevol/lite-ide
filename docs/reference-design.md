# 워크스페이스 개편 근거

2026-11-06에 다음 소스를 읽고 화면 구성과 작업 흐름을 참고했습니다. 참조 앱의 런타임이나 번들을 제품에 포함하지 않고 Electron·React와 타입이 정의된 preload API로 구현했습니다.

## Paseo

- [left-sidebar.tsx](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/src/components/left-sidebar.tsx): 프로젝트 그룹, 접기·펼치기, Worktree 중심 탐색, 하단 호스트 표시.
- [styles/theme.ts](https://github.com/getpaseo/paseo/blob/3ed57e9dd72df4927b08f16859eaf8d4d2d70ac2/packages/app/src/styles/theme.ts): 중성 회색 계층과 작업 상태의 의미별 색상 분리.
- 설치된 앱의 `resources/app-dist/_expo/static/js/web/index-20289e95fe638c0b31ff16e72eb99fed.js`: 사이드바·패널 전환과 작업 입력 흐름을 확인했습니다.

## Superset

- 기존 `superset-sh/superset` 저장소의 리디렉션을 따라 [ParadevAI/Paradev의 WorkspaceListFrame.tsx](https://github.com/ParadevAI/Paradev/blob/main/apps/desktop/src/renderer/commandPalette/ui/WorkspaceList/WorkspaceListFrame.tsx)를 확인했습니다.
- 프로젝트별 작업 그룹, 프로젝트·브랜치·작업 이름으로 검색하는 빠른 이동을 참고했습니다.

## Orca

- 설치된 `resources/app.asar`의 `out/renderer/assets/AgentDashboardSidebarEntry-ChHRxJGu.js`와 `AgentDashboardSidebarHost-G-GlEgYT.js`를 읽었습니다.
- Worktree별 작업 연결, 작업 중·응답 필요·완료 상태 표현을 참고했습니다. 번들 코드를 복사하거나 Orca 서비스에 의존하지 않습니다.

## Codex 실행

- 로컬 `codex-cli 0.166.0`의 `app-server generate-ts`가 생성한 프로토콜 타입을 기준으로 구현했습니다. 생성 결과는 검증용 `artifacts/codex-protocol/`에만 보관하며 배포하지 않습니다.
- `initialize`, `account/read`, `model/list`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`와 스트리밍 알림을 사용합니다.
- 명령·파일·추가 권한 승인 및 질문에 대한 응답은 전용 IPC로 전달합니다. 미지원 서버 요청은 명시적 오류로 반환합니다.
- 기본 작업 권한은 YOLO 모드의 `danger-full-access`, 승인 정책은 `never`입니다. 새 대화·재개와 각 턴에 적용합니다. 렌더러는 임의 셸 명령을 직접 실행할 수 없습니다.
- 프로젝트 및 대화는 Electron 사용자 데이터 디렉터리에 원자적 파일 교체 방식으로 저장합니다. 입력 내용·선택 작업·테마는 렌더러 로컬 저장소에 보관합니다.

## 검증 구분

- 단위 테스트: Git 경로 파서, Codex RPC 동시 요청·종료·재연결.
- UI 테스트: 실제 Electron main/preload/renderer와 별도 stdio 프로토콜 픽스처로 전송·스트리밍·재개·승인·질문·중단·Worktree·diff·재시작 복원 검증. 외부 모델을 호출하지 않습니다.
- 실제 연결 테스트: 설치된 Codex와 계정으로 모델 목록을 조회합니다. `--live`는 실제 모델을 호출하며, `--write`는 재시작 후 같은 대화를 재개하고 격리된 임시 디렉터리에서 파일 생성을 확인합니다.

## 통합 타이틀바

- [Electron 공식 Custom Title Bar 문서](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)와 설치된 Electron 43.8.6 타입 선언을 확인했습니다.
- `titleBarStyle: 'hidden'`과 `titleBarOverlay`를 사용하여 네이티브 최소화·최대화·닫기 버튼을 유지하고 앱 상단을 같은 43px 행에 배치했습니다.
- `env(titlebar-area-x)`와 `env(titlebar-area-width)`로 운영체제가 제공하는 창 버튼 영역을 피합니다. macOS에서는 왼쪽 traffic light 위치와 여백을 적용합니다.
- 제목 표시줄은 `-webkit-app-region: drag`, 검색·패널 전환 영역은 `no-drag`입니다. 테마 변경은 제한된 `window:theme` IPC를 거쳐 main에서 네이티브 테마와 버튼 색상에 반영합니다.
- 숨김 UI 테스트에서 중복 제목 표시줄 유무, 드래그 영역, 창 버튼 안전 영역, 상단 버튼 클릭, 테마 동기화를 확인합니다. macOS 네이티브 동작은 실기기 검증이 필요합니다.

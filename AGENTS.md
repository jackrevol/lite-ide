# 프로젝트 지침

- 기본 응답, 진행 상황, 커밋 메시지는 한국어 존댓말로 작성합니다.
- 텍스트 파일은 UTF-8 without BOM으로 저장하고 한글 변경 후 diff를 확인합니다.
- macOS와 Windows용 Electron 앱입니다. AI는 Codex만 지원합니다.
- 기본 화면은 프로젝트·Worktree / Codex 작업 / 변경 사항의 3열 구조입니다.
- 렌더러에서는 Node.js에 직접 접근하지 않고, 타입이 정의된 preload API를 사용합니다.
- 아직 연동하지 않은 기능을 작동하는 것처럼 표시하지 않습니다.
- 검증: `npm run typecheck`, `npm test`, `npm run build`.
- UI 검증은 `npm run test:ui`로 숨겨진 창에서 실행합니다. 사용자 화면의 포커스를 가져오지 않습니다.

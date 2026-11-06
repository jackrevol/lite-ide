# Lite IDE

macOS·Windows용 경량 데스크톱 IDE의 새 베이스입니다. Electron, React, TypeScript로 작성했으며 Orca 소스와 런타임에 의존하지 않습니다.

## 화면

- 왼쪽: 프로젝트 열기·전환, Git Worktree 목록·전환
- 가운데: Codex 전용 작업 탭, 탭별 작업 초안
- 오른쪽: Git 변경 파일 목록, 새로고침, 파일별 diff 검토

실제 Codex CLI 실행은 아직 연결하지 않았습니다. 전송 버튼은 비활성화되며, 작업 초안은 현재 앱 실행 동안만 보관합니다. Worktree 생성·삭제, 코드 편집기, 자동 저장도 후속 구현 대상입니다.

## 실행

Node.js 24 이상과 Git이 필요합니다.

```sh
npm install
npm run dev
```

## 검증

```sh
npm test
npm run build
npm run test:ui
```

UI 검증은 숨겨진 Electron 창에서 실행하며 `artifacts/`에 스크린샷을 저장합니다.

## 패키징

Windows에서는 `npm run package:win`, macOS에서는 `npm run package:mac`을 실행합니다. 배포용 서명·공증은 별도 설정해야 합니다. macOS 실기기 검증은 아직 수행하지 않았습니다.

Git이 없거나 저장소가 아닌 폴더에서는 프로젝트와 작업 초안만 사용할 수 있습니다. 변경 파일은 최대 200개까지 표시하고 전체 파일 수는 별도로 표시합니다. 새 파일의 diff는 `git add` 이후 확인할 수 있습니다.

## UI 컴포넌트

[coss UI](https://coss.com/ui)의 공식 레지스트리에서 Button, Tabs, Badge, Textarea, Separator와 필요한 의존 컴포넌트를 가져왔습니다. Base UI와 Tailwind CSS v4를 사용하며, 소스는 `src/renderer/src/components/ui/`, 색상 토큰은 `theme.css`에서 관리합니다. 레지스트리 import 경로만 프로젝트에 맞게 조정했습니다. 원본의 MIT 라이선스는 `LICENSE.coss-ui`에 포함되어 있습니다.

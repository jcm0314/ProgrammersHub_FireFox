# 프로그래머스허브 (ProgrammersHub for Firefox)

기존 백준허브(BaekjoonHub)가 Firefox에서 동작하지 않는 원인들을 해결하여, 프로그래머스 문제 풀이 통과 시 **백준허브와 100% 동일한 폴더/파일/README/커밋 메시지 규격**으로 GitHub 저장소에 자동 커밋해 주는 Firefox 전용 확장 프로그램입니다.

---

## 왜 기존 백준허브가 Firefox에서 동작하지 않았나요?

1. **Manifest V3 Background 호환성 문제**: Chrome 전용 `"service_worker"` 설정만 선언되어 있어 Firefox에서 백그라운드 스크립트가 로드되지 않던 문제를 Firefox 표준 `"background": { "scripts": ["background.js"] }` 및 `browser_specific_settings.gecko` 설정으로 해결했습니다.
2. **Firefox Xray Vision (`CodeMirror` 접근 차단)**: Firefox의 Content Script 보안 격리(Xray wrapper) 때문에 `.CodeMirror.CodeMirror.getValue()`가 `undefined`를 반환하여 코드가 추출되지 않던 문제를 `wrappedJSObject` 및 다중 폴백(`textarea#code`, 빈칸 채우기 등)으로 해결했습니다.
3. **OAuth 리다이렉트 파이프 차단**: 기존 웹 리다이렉트 탭 가로채기 방식 대신 **GitHub OAuth Device Flow** (백그라운드 폴링) 및 **PAT(Personal Access Token)** 방식을 모두 지원하여 팝업이 닫혀도 백그라운드에서 안전하게 인증이 완료됩니다.

---

## Firefox에 설치 및 적용하는 방법

### 방법 1: 개발자 모드로 바로 로드하기 (가장 빠름)
1. Firefox 주소창에 `about:debugging#/runtime/this-firefox` 를 입력하여 이동합니다.
2. 상단의 **[임시 부가 기능 로드… (Load Temporary Add-on...)]** 버튼을 클릭합니다.
3. 이 폴더 안의 `manifest.json` 파일(또는 `programmers-hub-firefox.zip`)을 선택하면 즉시 설치됩니다.

### 방법 2: 영구 설치 (Firefox Developer Edition / Nightly 또는 서명 후 설치)
- `programmers-hub-firefox.zip` 파일을 [Firefox Add-on Developer Hub](https://addons.mozilla.org/ko/developers/)에서 자체 서명(Self-hosted)하면 일반 Firefox에서도 영구 설치(`.xpi`)가 가능합니다.

---

## 사용 방법

1. **GitHub 로그인 (Device Flow)**
   - Firefox 우측 상단 확장 프로그램 아이콘(**프로그래머스허브**)을 클릭합니다.
   - **[GitHub Device Flow로 로그인]** 버튼을 클릭하면 8자리 인증 코드가 표시됩니다.
   - **[코드 복사 & GitHub 인증 페이지 열기 ↗]** 버튼을 눌러 열리는 GitHub 페이지(`https://github.com/login/device`)에 복사된 코드를 붙여넣고 승인(Authorize)합니다.
   - *(기본 내장된 백준허브 호환 Client ID로 즉시 동작하며, 원하시면 '고급 인증 설정'에서 본인의 OAuth App Client ID나 Personal Access Token을 사용할 수도 있습니다.)*
2. **저장소(Repository) 선택**
   - 로그인 완료 후 기존에 사용하던 백준허브 GitHub 저장소를 그대로 선택하거나, **[+ 새 GitHub 저장소 직접 생성하기]**로 새 저장소를 만들어 연결합니다.
3. **문제 풀이 & 자동 커밋**
   - [프로그래머스](https://school.programmers.co.kr/)에서 문제를 풀고 [제출 후 채점하기]를 눌러 **정답** 판정을 받으면:
     - 화면 우측 상단 **토스트 알림**과 채점 결과 모달 하단 **상태 배지**에 업로드 진행 상태가 실시간으로 표시됩니다.
     - `프로그래머스/{레벨}/{문제번호}. {제목}/{제목}.{확장자}` 및 `README.md`가 백준허브와 100% 동일한 포맷으로 단일 커밋됩니다.


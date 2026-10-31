/**
 * 프로그래머스허브 (ProgrammersHub for Firefox) - Content Script
 * - 프로그래머스 문제 페이지에서 채점 결과 모달('정답') 감지
 * - Firefox Xray wrapper(wrappedJSObject) 대응으로 CodeMirror 에디터 코드 100% 추출
 * - 백준허브(BaekjoonHub)와 100% 동일한 디렉토리/파일명/README.md/커밋 메시지 포맷 생성
 * - 화면 우측 상단 토스트 알림 + 채점 모달 내부 상태 배지 표시
 */

(function () {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  let passHandled = false;
  let lastParsedPayload = null;
  let activeToastEl = null;

  // ============================================================================
  // 백준허브(BaekjoonHub) 100% 호환 문자열 및 경로 유틸리티
  // ============================================================================

  /**
   * 일반 특수문자를 전각문자로 변환하고 공백을 FOUR-PER-EM SPACE(\u2005)로 변환 (백준허브 동일 규격)
   */
  function convertSingleCharToDoubleChar(text) {
    if (!text) return '';
    const map = {
      '!': '！',
      '%': '％',
      '&': '＆',
      '(': '（',
      ')': '）',
      '*': '＊',
      '+': '＋',
      ',': '，',
      '-': '－',
      '.': '．',
      '/': '／',
      ':': '：',
      ';': '；',
      '<': '＜',
      '=': '＝',
      '>': '＞',
      '?': '？',
      '@': '＠',
      '[': '［',
      '\\': '＼',
      ']': '］',
      '^': '＾',
      _: '＿',
      '`': '｀',
      '{': '｛',
      '|': '｜',
      '}': '｝',
      '~': '～',
      ' ': ' ', // FOUR-PER-EM SPACE (\u2005)
    };
    return String(text).replace(/[!%&()*+,\-./:;<=>?@\[\\\]^_`{|}~ ]/g, (m) => map[m] || m);
  }

  /**
   * 파이썬 계열 언어명을 백준허브 표준 폴더명 'Python'으로 통일
   */
  function normalizeLanguageName(language) {
    if (typeof language !== 'string') return 'Unknown';
    return /^(python|pypy)[ \u2005]?[0-9.]*$/i.test(language.trim()) ? 'Python' : language.trim();
  }

  /**
   * 에디터 탭 라벨('solution.py', 'solution.sql' 등) 또는 언어 버튼 텍스트에서 확장자 추출
   */
  function resolveExtension(tabLabel, languageBtnText) {
    const text = typeof tabLabel === 'string' ? tabLabel.trim() : '';
    const dot = text.lastIndexOf('.');
    if (dot > 0) {
      const extPart = text.slice(dot + 1).trim().toLowerCase();
      if (extPart) return extPart;
    }

    // 탭 라벨에 확장자가 없는 경우(일부 SQL/객관식/빈칸 문제 등) 언어 버튼 텍스트로 매핑
    const langLower = (languageBtnText || '').trim().toLowerCase();
    const langMap = {
      python3: 'py',
      python: 'py',
      pypy3: 'py',
      java: 'java',
      'c++': 'cpp',
      cpp: 'cpp',
      c: 'c',
      javascript: 'js',
      'node.js': 'js',
      typescript: 'ts',
      kotlin: 'kt',
      swift: 'swift',
      go: 'go',
      rust: 'rs',
      'c#': 'cs',
      ruby: 'rb',
      scala: 'scala',
      mysql: 'sql',
      oracle: 'sql',
      sql: 'sql',
    };

    for (const [k, v] of Object.entries(langMap)) {
      if (langLower === k || langLower.startsWith(k)) {
        return v;
      }
    }
    return 'txt';
  }

  /**
   * 백준허브 날짜 포맷 (예: 2026년 11월 01일 02:16:01)
   */
  function getDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}년 ${month}월 ${day}일 ${hours}:${minutes}:${seconds}`;
  }

  /**
   * 빈칸 채우기 문제 코드 재구성
   */
  function reconstructFillBlankCode(node) {
    let result = '';
    for (const child of node.childNodes) {
      if (child.tagName === 'INPUT') {
        result += child.value;
      } else if (child.childNodes && child.childNodes.length > 0) {
        result += reconstructFillBlankCode(child);
      } else {
        result += child.textContent;
      }
    }
    return result;
  }

  /**
   * Firefox Xray vision 대응 소스코드 추출
   */
  function extractSourceCode() {
    const codeMirrorEl = document.querySelector('.CodeMirror');

    // 1. Firefox content script Xray wrapper 우회 (wrappedJSObject)
    try {
      if (codeMirrorEl && codeMirrorEl.wrappedJSObject && codeMirrorEl.wrappedJSObject.CodeMirror) {
        const val = codeMirrorEl.wrappedJSObject.CodeMirror.getValue();
        if (typeof val === 'string' && val.length > 0) return val;
      }
    } catch (e) {
      // ignore Xray error and fallback
    }

    // 2. 일반 CodeMirror 인스턴스 접근
    if (codeMirrorEl && codeMirrorEl.CodeMirror && typeof codeMirrorEl.CodeMirror.getValue === 'function') {
      const val = codeMirrorEl.CodeMirror.getValue();
      if (typeof val === 'string' && val.length > 0) return val;
    }

    // 3. textarea#code 접근
    const codeTextarea = document.querySelector('textarea#code');
    if (codeTextarea && typeof codeTextarea.value === 'string' && codeTextarea.value.length > 0) {
      return codeTextarea.value;
    }

    // 4. 빈칸 채우기 (input[name^="input_code"])
    const fillBlankInputs = document.querySelectorAll('input[name^="input_code"]');
    if (fillBlankInputs.length > 0) {
      const pre = fillBlankInputs[0].closest('pre');
      if (pre) return reconstructFillBlankCode(pre);
    }

    return codeTextarea ? codeTextarea.value : '';
  }

  // ============================================================================
  // 프로그래머스 DOM 파싱
  // ============================================================================

  async function parseProgrammersProblem() {
    const lessonEl =
      document.querySelector('.lesson-content') ||
      document.querySelector('[data-lesson-id]');

    const urlMatch = window.location.pathname.match(/\/lessons\/(\d+)/);
    const problemId =
      (lessonEl && lessonEl.getAttribute('data-lesson-id')) ||
      (urlMatch ? urlMatch[1] : '');

    if (!problemId) {
      throw new Error('문제 번호(problemId)를 찾을 수 없습니다.');
    }

    let level =
      (lessonEl && lessonEl.getAttribute('data-challenge-level')) || '';
    if (!level) {
      const breadcrumbLevel = document.querySelector('ol.breadcrumb li');
      const lvMatch = breadcrumbLevel ? breadcrumbLevel.textContent.match(/\d+/) : null;
      level = lvMatch ? lvMatch[0] : '0';
    }

    const link = `https://school.programmers.co.kr/learn/courses/30/lessons/${problemId}`;

    // 구분 (Breadcrumb)
    const breadcrumbEl = document.querySelector('ol.breadcrumb');
    let division = '코딩테스트 연습';
    if (breadcrumbEl) {
      const items = [...breadcrumbEl.childNodes]
        .filter((x) => x.nodeType === 1 && x.className !== 'active')
        .map((x) => (x.innerText || x.textContent || '').trim())
        .filter(Boolean)
        .map((x) => convertSingleCharToDoubleChar(x));
      if (items.length > 0) {
        division = items.reduce((a, b) => `${a}/${b}`);
      }
    }

    // 제목
    const titleEl =
      document.querySelector('.algorithm-title .challenge-title') ||
      document.querySelector('.challenge-title') ||
      document.querySelector('ol.breadcrumb li.active');
    const title = titleEl
      ? titleEl.textContent.replace(/\\n/g, '').replace(/\n/g, '').trim()
      : `문제 ${problemId}`;

    // 문제 설명 HTML
    const descEl =
      document.querySelector('div.guide-section-description > div.markdown') ||
      document.querySelector('.guide-section-description .markdown');
    const problem_description = descEl ? descEl.innerHTML : '';

    // 언어 및 파일 확장자
    const tabEl =
      document.querySelector('div.editor > ul > li.nav-item > a') ||
      document.querySelector('.editor .nav-item a');
    const langBtnEl =
      document.querySelector('div#tour7 > button') ||
      document.querySelector('.language-select button');
    const language = langBtnEl ? langBtnEl.textContent.trim() : 'Python3';
    const language_extension = resolveExtension(
      tabEl ? tabEl.innerText || tabEl.textContent : '',
      language
    );

    // 작성한 소스코드
    const code = extractSourceCode();
    if (!code || !code.trim()) {
      throw new Error('작성된 소스코드를 추출할 수 없습니다.');
    }

    // 채점 콘솔 요약 메시지
    const result_message =
      [...document.querySelectorAll('#output .console-message')]
        .map((node) => node.textContent)
        .filter((text) => text.includes(':'))
        .reduce((cur, next) => (cur ? `${cur}<br/>${next}` : next), '') || 'Empty';

    // 최대 소요 시간 및 메모리 추출
    const passedCells = [...document.querySelectorAll('td.result.passed')];
    let runtime = '0.00 ms';
    let memory = '0.0 MB';
    if (passedCells.length > 0) {
      const parsedMetrics = passedCells
        .map((x) => x.innerText || x.textContent || '')
        .map((x) => x.replace(/[^., 0-9a-zA-Z]/g, '').trim())
        .map((x) => x.split(', '))
        .filter((pair) => pair.length >= 2)
        .reduce(
          (x, y) => (Number(x[0].slice(0, -2)) > Number(y[0].slice(0, -2)) ? x : y),
          ['0.00ms', '0.0MB']
        )
        .map((x) => x.replace(/(?<=[0-9])(?=[A-Za-z])/, ' '));
      runtime = parsedMetrics[0] || '0.00 ms';
      memory = parsedMetrics[1] || '0.0 MB';
    }

    // 저장소 폴더 정리 옵션 확인 (플랫폼별 vs 언어별)
    const configRes = await ext.runtime.sendMessage({ type: 'GET_CONFIG' });
    const orgOption = configRes?.data?.orgOption || 'platform';

    const convertedTitle = convertSingleCharToDoubleChar(title);
    let directory = `프로그래머스/${level}/${problemId}. ${convertedTitle}`;
    if (orgOption === 'language') {
      const normLang = normalizeLanguageName(language);
      directory = `${normLang}/프로그래머스/${level}/${problemId}. ${convertedTitle}`;
    }

    const levelWithLv = `${level}`.includes('lv')
      ? level
      : `lv${level}`.replace('lv', 'level ');
    const commitMessage = `[${levelWithLv}] Title: ${title}, Time: ${runtime}, Memory: ${memory} -BaekjoonHub`;
    const fileName = `${convertedTitle}.${language_extension}`;
    const dateInfo = getDateString(new Date());

    const readme =
      `# [${levelWithLv}] ${title} - ${problemId} \n\n` +
      `[문제 링크](${link}) \n\n` +
      `### 성능 요약\n\n` +
      `메모리: ${memory}, ` +
      `시간: ${runtime}\n\n` +
      `### 구분\n\n` +
      `${division.replace('/', ' > ')}\n\n` +
      `### 채점결과\n\n` +
      `${result_message}\n\n` +
      `### 제출 일자\n\n` +
      `${dateInfo}\n\n` +
      `### 문제 설명\n\n` +
      `${problem_description}\n\n` +
      `> 출처: 프로그래머스 코딩 테스트 연습, https://school.programmers.co.kr/learn/challenges`;

    return {
      problemId,
      title,
      level,
      directory,
      fileName,
      code,
      readme,
      commitMessage,
    };
  }

  // ============================================================================
  // UI: 토스트 알림 & 모달 배지 렌더링
  // ============================================================================

  function getToastContainer() {
    let container = document.getElementById('pghub-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'pghub-toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function createStatusIcon(state) {
    if (state === 'loading') {
      const spinner = document.createElement('div');
      spinner.className = 'pghub-spinner';
      return spinner;
    }

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('fill', 'none');

    const path = document.createElementNS(svgNS, 'path');
    if (state === 'success') {
      path.setAttribute(
        'd',
        'M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z'
      );
      path.setAttribute('fill', '#22c55e');
    } else if (state === 'skipped') {
      path.setAttribute(
        'd',
        'M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2a1 1 0 102 0V7zm-1 6a1 1 0 100-2 1 1 0 000 2z'
      );
      path.setAttribute('fill', '#eab308');
    } else {
      path.setAttribute(
        'd',
        'M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z'
      );
      path.setAttribute('fill', '#ef4444');
    }
    svg.appendChild(path);
    return svg;
  }

  function showToast({ state, title, desc, folderUrl, onRetry, onForceUpload, autoHideMs = 0 }) {
    const container = getToastContainer();
    if (activeToastEl) {
      activeToastEl.remove();
      activeToastEl = null;
    }

    const toast = document.createElement('div');
    toast.className = `pghub-toast pghub-toast-${state}`;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'pghub-toast-icon';
    iconWrap.appendChild(createStatusIcon(state));

    const bodyEl = document.createElement('div');
    bodyEl.className = 'pghub-toast-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'pghub-toast-title';
    titleEl.textContent = title;

    const descEl = document.createElement('div');
    descEl.className = 'pghub-toast-desc';
    descEl.textContent = desc || '';

    const actionsEl = document.createElement('div');
    actionsEl.className = 'pghub-toast-actions';

    if (folderUrl) {
      const linkBtn = document.createElement('a');
      linkBtn.className = 'pghub-btn pghub-btn-primary';
      linkBtn.href = folderUrl;
      linkBtn.target = '_blank';
      linkBtn.rel = 'noopener noreferrer';
      linkBtn.textContent = 'GitHub에서 보기 ↗';
      actionsEl.appendChild(linkBtn);
    }

    if (onForceUpload) {
      const forceBtn = document.createElement('button');
      forceBtn.className = 'pghub-btn';
      forceBtn.textContent = '강제 재커밋';
      forceBtn.addEventListener('click', () => onForceUpload());
      actionsEl.appendChild(forceBtn);
    }

    if (onRetry) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'pghub-btn pghub-btn-primary';
      retryBtn.textContent = '다시 시도';
      retryBtn.addEventListener('click', () => onRetry());
      actionsEl.appendChild(retryBtn);
    }

    bodyEl.appendChild(titleEl);
    bodyEl.appendChild(descEl);
    if (actionsEl.children.length > 0) {
      bodyEl.appendChild(actionsEl);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pghub-toast-close';
    closeBtn.title = '닫기';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      toast.remove();
      if (activeToastEl === toast) activeToastEl = null;
    });

    toast.appendChild(iconWrap);
    toast.appendChild(bodyEl);
    toast.appendChild(closeBtn);

    container.appendChild(toast);
    activeToastEl = toast;

    if (autoHideMs > 0) {
      setTimeout(() => {
        if (activeToastEl === toast) {
          toast.classList.add('pghub-toast-hide');
          setTimeout(() => toast.remove(), 300);
        }
      }, autoHideMs);
    }
  }

  function updateModalBadge({ state, text, folderUrl, onAction, actionLabel }) {
    const modalFooter =
      document.querySelector('#modal-dialog .modal-footer') ||
      document.querySelector('.modal-footer');
    if (!modalFooter) return;

    let badge = document.getElementById('pghub-modal-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'pghub-modal-badge';
      modalFooter.prepend(badge);
    }

    badge.replaceChildren();

    if (state === 'loading') {
      const spinner = document.createElement('div');
      spinner.className = 'pghub-spinner';
      badge.appendChild(spinner);
    } else if (state === 'success') {
      const check = document.createElement('span');
      check.textContent = '✅';
      badge.appendChild(check);
    } else if (state === 'skipped') {
      const info = document.createElement('span');
      info.textContent = 'ℹ️';
      badge.appendChild(info);
    } else {
      const err = document.createElement('span');
      err.textContent = '❌';
      badge.appendChild(err);
    }

    const label = document.createElement('span');
    label.textContent = text;
    badge.appendChild(label);

    if (folderUrl) {
      const link = document.createElement('a');
      link.className = 'pghub-badge-link';
      link.href = folderUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'GitHub 열기 ↗';
      badge.appendChild(link);
    }

    if (onAction && actionLabel) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pghub-badge-action';
      btn.textContent = actionLabel;
      btn.addEventListener('click', onAction);
      badge.appendChild(btn);
    }
  }

  // ============================================================================
  // 채점 결과 모달 감지 및 업로드 실행
  // ============================================================================

  function getSolvedResultElement() {
    return (
      document.querySelector('div.modal-header > h4') ||
      document.querySelector('#modal-dialog h4') ||
      document.querySelector('.modal-header h4') ||
      document.querySelector('[class*="modal"] h4')
    );
  }

  function isResultModalOpen() {
    const elem = getSolvedResultElement();
    if (!elem) return false;
    return Boolean(elem.offsetWidth || elem.offsetHeight || elem.getClientRects().length);
  }

  function getSolvedResultText() {
    const elem = getSolvedResultElement();
    return elem ? (elem.innerText || elem.textContent || '').trim() : '';
  }

  async function executeUpload(force = false) {
    try {
      updateModalBadge({
        state: 'loading',
        text: 'GitHub에 커밋 중...',
      });
      showToast({
        state: 'loading',
        title: 'GitHub에 자동 커밋 중...',
        desc: '문제 풀이 코드와 README.md를 업로드하고 있습니다.',
      });

      const payload = force && lastParsedPayload
        ? { ...lastParsedPayload, force: true }
        : await parseProgrammersProblem();

      lastParsedPayload = payload;

      const response = await ext.runtime.sendMessage({
        type: 'UPLOAD_PROBLEM',
        payload: { ...payload, force },
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || 'GitHub 업로드 중 알 수 없는 오류가 발생했습니다.');
      }

      const result = response.data;

      if (result.status === 'disabled') {
        updateModalBadge({
          state: 'skipped',
          text: '자동 업로드 꺼짐',
          actionLabel: '수동 커밋하기',
          onAction: () => executeUpload(true),
        });
        if (activeToastEl) activeToastEl.remove();
        return;
      }

      if (result.status === 'skipped') {
        updateModalBadge({
          state: 'skipped',
          text: '이미 동일한 코드 커밋됨',
          folderUrl: result.folderUrl,
          actionLabel: '강제 재커밋',
          onAction: () => executeUpload(true),
        });
        showToast({
          state: 'skipped',
          title: '이미 동일한 코드가 커밋되어 있습니다',
          desc: `${payload.directory}/${payload.fileName}`,
          folderUrl: result.folderUrl,
          onForceUpload: () => executeUpload(true),
          autoHideMs: 8000,
        });
        return;
      }

      updateModalBadge({
        state: 'success',
        text: 'GitHub 커밋 완료!',
        folderUrl: result.folderUrl,
      });
      showToast({
        state: 'success',
        title: 'GitHub 자동 커밋 완료!',
        desc: `${payload.directory}/${payload.fileName}`,
        folderUrl: result.folderUrl,
        autoHideMs: 9000,
      });
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error('[ProgrammersHub] 업로드 실패:', err);
      updateModalBadge({
        state: 'error',
        text: 'GitHub 커밋 실패',
        actionLabel: '다시 시도',
        onAction: () => executeUpload(force),
      });
      showToast({
        state: 'error',
        title: 'GitHub 커밋 실패',
        desc: errMsg,
        onRetry: () => executeUpload(force),
      });
    }
  }

  function checkAndHandleSolvedModal() {
    if (!window.location.pathname.includes('/lessons/')) return;

    const modalOpen = isResultModalOpen();
    if (!modalOpen) {
      if (passHandled) {
        passHandled = false;
        const oldBadge = document.getElementById('pghub-modal-badge');
        if (oldBadge) oldBadge.remove();
      }
      return;
    }

    if (passHandled) return;

    const resultText = getSolvedResultText();
    if (resultText.includes('정답')) {
      passHandled = true;
      executeUpload(false);
    }
  }

  // ============================================================================
  // 감시 시작 (MutationObserver + 폴백 타이머)
  // ============================================================================

  const observer = new MutationObserver(() => {
    checkAndHandleSolvedModal();
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  }

  setInterval(checkAndHandleSolvedModal, 1200);
})();


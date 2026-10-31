/**
 * 프로그래머스허브 (ProgrammersHub for Firefox) - Popup Script
 */

(function () {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  // DOM Elements
  const statusPill = document.getElementById('status-pill');
  const alertBox = document.getElementById('alert-box');

  const authSection = document.getElementById('auth-section');
  const deviceFlowIdle = document.getElementById('device-flow-idle');
  const deviceFlowPending = document.getElementById('device-flow-pending');
  const btnStartDeviceFlow = document.getElementById('btn-start-device-flow');
  const deviceUserCode = document.getElementById('device-user-code');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnOpenGithubDevice = document.getElementById('btn-open-github-device');
  const btnCancelDevice = document.getElementById('btn-cancel-device');

  const inputClientId = document.getElementById('input-client-id');
  const btnSaveClientId = document.getElementById('btn-save-client-id');
  const inputPat = document.getElementById('input-pat');
  const btnLoginPat = document.getElementById('btn-login-pat');

  const mainSection = document.getElementById('main-section');
  const userAvatar = document.getElementById('user-avatar');
  const userLogin = document.getElementById('user-login');
  const userAuthBadge = document.getElementById('user-auth-badge');
  const userProfileLink = document.getElementById('user-profile-link');
  const btnLogout = document.getElementById('btn-logout');

  const selectRepo = document.getElementById('select-repo');
  const btnRefreshRepos = document.getElementById('btn-refresh-repos');
  const selectedRepoInfo = document.getElementById('selected-repo-info');
  const linkCurrentRepo = document.getElementById('link-current-repo');

  const detailsCreateRepo = document.getElementById('details-create-repo');
  const inputNewRepoName = document.getElementById('input-new-repo-name');
  const checkNewRepoPrivate = document.getElementById('check-new-repo-private');
  const btnCreateRepo = document.getElementById('btn-create-repo');

  const selectOrgOption = document.getElementById('select-org-option');
  const checkAutoUpload = document.getElementById('check-auto-upload');
  const historyList = document.getElementById('history-list');

  let currentVerificationUri = 'https://github.com/login/device';

  // ============================================================================
  // Helpers
  // ============================================================================

  function showAlert(message, isSuccess = false) {
    if (!message) {
      alertBox.classList.add('hidden');
      alertBox.textContent = '';
      return;
    }
    alertBox.textContent = message;
    alertBox.classList.remove('hidden');
    if (isSuccess) {
      alertBox.classList.add('alert-success');
    } else {
      alertBox.classList.remove('alert-success');
    }
  }

  async function sendMsg(type, extra = {}) {
    const res = await ext.runtime.sendMessage({ type, ...extra });
    if (!res || !res.ok) {
      throw new Error(res?.error || '요청 처리 중 오류가 발생했습니다.');
    }
    return res.data;
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return '방금 전';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
    return `${Math.floor(diffSec / 86400)}일 전`;
  }

  // ============================================================================
  // UI Rendering
  // ============================================================================

  function renderHistory(items) {
    historyList.replaceChildren();
    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-history';
      empty.textContent = '아직 커밋된 문제가 없습니다.';
      historyList.appendChild(empty);
      return;
    }

    for (const item of items.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'history-item';

      const left = document.createElement('div');
      left.className = 'history-item-left';

      const title = document.createElement('div');
      title.className = 'history-item-title';
      title.textContent = `[Lv.${item.level}] ${item.problemId}. ${item.title}`;

      const meta = document.createElement('div');
      meta.className = 'history-item-meta';
      meta.textContent = `${item.repo} · ${formatRelativeTime(item.timestamp)}`;

      left.appendChild(title);
      left.appendChild(meta);

      const link = document.createElement('a');
      link.className = 'history-item-link';
      link.href = item.folderUrl || item.commitUrl || `https://github.com/${item.repo}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '열기 ↗';

      row.appendChild(left);
      row.appendChild(link);
      historyList.appendChild(row);
    }
  }

  function updateRepoLinkUI(repoFullName) {
    if (repoFullName) {
      selectedRepoInfo.classList.remove('hidden');
      linkCurrentRepo.textContent = `${repoFullName} ↗`;
      linkCurrentRepo.href = `https://github.com/${repoFullName}`;
      statusPill.textContent = '준비 완료';
      statusPill.className = 'status-pill status-connected';
    } else {
      selectedRepoInfo.classList.add('hidden');
      statusPill.textContent = '저장소 미선택';
      statusPill.className = 'status-pill status-disconnected';
    }
  }

  async function loadRepoList(selectedRepo) {
    try {
      btnRefreshRepos.disabled = true;
      const repos = await sendMsg('LIST_REPOS');

      selectRepo.replaceChildren();
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '-- 커밋할 저장소를 선택하세요 --';
      selectRepo.appendChild(defaultOpt);

      for (const r of repos) {
        const opt = document.createElement('option');
        opt.value = r.fullName;
        opt.textContent = `${r.fullName} ${r.private ? '🔒' : ''}`;
        if (r.fullName === selectedRepo) {
          opt.selected = true;
        }
        selectRepo.appendChild(opt);
      }

      if (selectedRepo && !repos.some((r) => r.fullName === selectedRepo)) {
        const customOpt = document.createElement('option');
        customOpt.value = selectedRepo;
        customOpt.textContent = selectedRepo;
        customOpt.selected = true;
        selectRepo.appendChild(customOpt);
      }
    } catch (err) {
      showAlert(`저장소 목록 조회 실패: ${err.message}`);
    } finally {
      btnRefreshRepos.disabled = false;
    }
  }

  async function refreshUI() {
    try {
      const cfg = await sendMsg('GET_CONFIG');
      inputClientId.value = cfg.clientId || '';

      if (!cfg.isLoggedIn) {
        authSection.classList.remove('hidden');
        mainSection.classList.add('hidden');
        statusPill.textContent = '미연결';
        statusPill.className = 'status-pill status-disconnected';

        const flow = cfg.deviceFlowState;
        if (flow && flow.status === 'pending' && flow.expiresAt > Date.now()) {
          deviceFlowIdle.classList.add('hidden');
          deviceFlowPending.classList.remove('hidden');
          deviceUserCode.textContent = flow.userCode;
          currentVerificationUri = flow.verificationUri || 'https://github.com/login/device';
        } else {
          deviceFlowIdle.classList.remove('hidden');
          deviceFlowPending.classList.add('hidden');
          if (flow && flow.error) {
            showAlert(flow.error);
          }
        }
        return;
      }

      // Logged In State
      authSection.classList.add('hidden');
      mainSection.classList.remove('hidden');

      userLogin.textContent = `@${cfg.username}`;
      userAvatar.src = cfg.avatarUrl || 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png';
      userAuthBadge.textContent = cfg.authMethod === 'pat' ? 'PAT' : 'OAuth Device';
      userProfileLink.href = `https://github.com/${cfg.username}`;

      selectOrgOption.value = cfg.orgOption || 'platform';
      checkAutoUpload.checked = cfg.enableAutoUpload !== false;

      updateRepoLinkUI(cfg.repo);
      renderHistory(cfg.uploadHistory || []);
      await loadRepoList(cfg.repo);
    } catch (err) {
      showAlert(err.message);
    }
  }

  // ============================================================================
  // Event Listeners
  // ============================================================================

  btnStartDeviceFlow.addEventListener('click', async () => {
    showAlert('');
    btnStartDeviceFlow.disabled = true;
    try {
      const customClientId = inputClientId.value.trim();
      const flowState = await sendMsg('START_DEVICE_FLOW', { clientId: customClientId });
      deviceFlowIdle.classList.add('hidden');
      deviceFlowPending.classList.remove('hidden');
      deviceUserCode.textContent = flowState.userCode;
      currentVerificationUri = flowState.verificationUri || 'https://github.com/login/device';
    } catch (err) {
      showAlert(err.message);
    } finally {
      btnStartDeviceFlow.disabled = false;
    }
  });

  btnCopyCode.addEventListener('click', async () => {
    const code = deviceUserCode.textContent.trim();
    if (!code) return;
    await navigator.clipboard.writeText(code);
    btnCopyCode.textContent = '복사됨 ✓';
    setTimeout(() => {
      btnCopyCode.textContent = '복사';
    }, 1500);
  });

  btnOpenGithubDevice.addEventListener('click', async () => {
    const code = deviceUserCode.textContent.trim();
    if (code && code !== '----') {
      try {
        await navigator.clipboard.writeText(code);
      } catch (e) {
        // ignore clipboard permission errors
      }
    }
    ext.tabs.create({ url: currentVerificationUri });
  });

  btnCancelDevice.addEventListener('click', async () => {
    await sendMsg('CANCEL_DEVICE_FLOW');
    await refreshUI();
  });

  btnSaveClientId.addEventListener('click', async () => {
    const clientId = inputClientId.value.trim();
    await sendMsg('SAVE_SETTINGS', { githubClientId: clientId });
    showAlert('OAuth Client ID가 저장되었습니다.', true);
  });

  btnLoginPat.addEventListener('click', async () => {
    showAlert('');
    const token = inputPat.value.trim();
    if (!token) {
      showAlert('Personal Access Token을 입력해주세요.');
      return;
    }
    btnLoginPat.disabled = true;
    try {
      await sendMsg('LOGIN_WITH_PAT', { token });
      inputPat.value = '';
      showAlert('GitHub 계정이 성공적으로 연결되었습니다!', true);
      await refreshUI();
    } catch (err) {
      showAlert(`PAT 로그인 실패: ${err.message}`);
    } finally {
      btnLoginPat.disabled = false;
    }
  });

  btnLogout.addEventListener('click', async () => {
    showAlert('');
    await sendMsg('LOGOUT');
    await refreshUI();
  });

  selectRepo.addEventListener('change', async () => {
    const selected = selectRepo.value;
    await sendMsg('SAVE_SETTINGS', { githubRepo: selected });
    updateRepoLinkUI(selected);
    if (selected) {
      showAlert(`'${selected}' 저장소가 연결되었습니다.`, true);
    }
  });

  btnRefreshRepos.addEventListener('click', async () => {
    showAlert('');
    await loadRepoList(selectRepo.value);
  });

  btnCreateRepo.addEventListener('click', async () => {
    showAlert('');
    const name = inputNewRepoName.value.trim();
    if (!name) {
      showAlert('새 저장소 이름을 입력해주세요.');
      return;
    }
    btnCreateRepo.disabled = true;
    try {
      const created = await sendMsg('CREATE_REPO', {
        payload: {
          name,
          isPrivate: checkNewRepoPrivate.checked,
        },
      });
      inputNewRepoName.value = '';
      detailsCreateRepo.open = false;
      showAlert(`'${created.fullName}' 저장소가 생성 및 연결되었습니다!`, true);
      await loadRepoList(created.fullName);
      updateRepoLinkUI(created.fullName);
    } catch (err) {
      showAlert(`저장소 생성 실패: ${err.message}`);
    } finally {
      btnCreateRepo.disabled = false;
    }
  });

  selectOrgOption.addEventListener('change', async () => {
    await sendMsg('SAVE_SETTINGS', { orgOption: selectOrgOption.value });
    showAlert('폴더 정리 방식이 저장되었습니다.', true);
  });

  checkAutoUpload.addEventListener('change', async () => {
    await sendMsg('SAVE_SETTINGS', { enableAutoUpload: checkAutoUpload.checked });
  });

  // 백그라운드에서 Device Flow 폴링이 완료되면 즉시 UI 갱신
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.githubToken || changes.deviceFlowState || changes.uploadHistory) {
        refreshUI();
      }
    }
  });

  // 초기 로드
  refreshUI();
})();


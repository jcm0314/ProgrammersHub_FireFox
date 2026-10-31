/**
 * 프로그래머스허브 (ProgrammersHub for Firefox) - Background Script
 * - GitHub OAuth Device Flow 인증 (Device Flow 공식 활성화 Client ID + credentials: 'omit')
 * - Personal Access Token (PAT) 인증 지원
 * - GitHub Git Data API를 통한 단일 커밋 업로드 (소스코드 + README.md 동시 커밋)
 * - 빈 저장소(Empty Repository) 자동 초기화 폴백 지원
 */

const ext = typeof browser !== 'undefined' ? browser : chrome;

// Device Flow가 공식 활성화된 기본 Client ID
const DEFAULT_GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';
const LEGACY_BROKEN_CLIENT_ID = '975f8d5cf6686dd1faed';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

let pollingAbortController = null;

// ============================================================================
// Storage Helpers
// ============================================================================

async function getStorage(keys) {
  return await ext.storage.local.get(keys);
}

async function setStorage(obj) {
  return await ext.storage.local.set(obj);
}

async function removeStorage(keys) {
  return await ext.storage.local.remove(keys);
}

// ============================================================================
// SHA-1 Git Blob Hash Calculation (Web Crypto API)
// ============================================================================

async function calculateGitBlobSHA(content) {
  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(content);
  const headerBytes = encoder.encode(`blob ${bodyBytes.length}\0`);
  const combined = new Uint8Array(headerBytes.length + bodyBytes.length);
  combined.set(headerBytes, 0);
  combined.set(bodyBytes, headerBytes.length);

  const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64Unicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ============================================================================
// GitHub REST API Helper
// ============================================================================

async function githubFetch(endpoint, token, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API_BASE}${endpoint}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {}),
  };
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const fetchOptions = {
    ...options,
    headers,
    credentials: 'omit',
    cache: options.method && options.method !== 'GET' ? undefined : 'no-cache',
  };

  const response = await fetch(url, fetchOptions);
  if (options.allow404 && response.status === 404) {
    return null;
  }
  if (options.allow409 && response.status === 409) {
    return { _emptyRepoConflict: true };
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || `GitHub API 오류 (HTTP ${response.status})`);
    err.status = response.status;
    err.details = data;
    throw err;
  }
  return data;
}

// ============================================================================
// GitHub OAuth Device Flow
// ============================================================================

async function resolveEffectiveClientId(customClientId) {
  const stored = await getStorage(['githubClientId']);
  let candidate = (customClientId || stored.githubClientId || DEFAULT_GITHUB_CLIENT_ID).trim();
  if (!candidate || candidate === LEGACY_BROKEN_CLIENT_ID) {
    candidate = DEFAULT_GITHUB_CLIENT_ID;
  }
  await setStorage({ githubClientId: candidate });
  return candidate;
}

async function startDeviceFlow(customClientId) {
  if (pollingAbortController) {
    pollingAbortController.abort();
    pollingAbortController = null;
  }

  const clientId = await resolveEffectiveClientId(customClientId);

  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: 'repo',
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.device_code) {
    throw new Error(
      data.error_description ||
        data.error ||
        `Device Flow 코드 발급에 실패했습니다 (HTTP ${res.status}). Client ID를 확인해주세요.`
    );
  }

  const expiresAt = Date.now() + (data.expires_in || 900) * 1000;
  const intervalSec = data.interval || 5;

  const deviceFlowState = {
    status: 'pending',
    clientId,
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://github.com/login/device',
    expiresAt,
    interval: intervalSec,
    startedAt: Date.now(),
    error: null,
  };

  await setStorage({ deviceFlowState });

  // 백그라운드에서 폴링 시작 (팝업이 닫혀도 계속 동작)
  pollDeviceFlowToken(deviceFlowState);

  return deviceFlowState;
}

async function pollDeviceFlowToken(flowState) {
  const controller = new AbortController();
  pollingAbortController = controller;
  let intervalMs = (flowState.interval || 5) * 1000;

  while (!controller.signal.aborted && Date.now() < flowState.expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (controller.signal.aborted) return;

    try {
      const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: flowState.clientId,
          device_code: flowState.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: controller.signal,
      });

      const data = await res.json().catch(() => ({}));

      if (data.access_token) {
        const user = await githubFetch('/user', data.access_token);
        await setStorage({
          githubToken: data.access_token,
          githubUsername: user.login,
          githubAvatarUrl: user.avatar_url || '',
          githubAuthMethod: 'device_flow',
          enableAutoUpload: true,
          deviceFlowState: {
            status: 'authorized',
            completedAt: Date.now(),
          },
        });
        pollingAbortController = null;
        return;
      }

      if (data.error === 'authorization_pending') {
        continue;
      } else if (data.error === 'slow_down') {
        intervalMs = (data.interval ? data.interval : flowState.interval + 5) * 1000;
        continue;
      } else if (data.error === 'expired_token') {
        await setStorage({
          deviceFlowState: {
            status: 'expired',
            error: '인증 코드가 만료되었습니다. 다시 시도해주세요.',
          },
        });
        pollingAbortController = null;
        return;
      } else if (data.error === 'access_denied') {
        await setStorage({
          deviceFlowState: {
            status: 'error',
            error: '사용자가 인증을 취소했습니다.',
          },
        });
        pollingAbortController = null;
        return;
      } else if (data.error) {
        await setStorage({
          deviceFlowState: {
            status: 'error',
            error: data.error_description || data.error,
          },
        });
        pollingAbortController = null;
        return;
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn('[ProgrammersHub] Device flow poll warning:', err);
    }
  }

  if (!controller.signal.aborted && Date.now() >= flowState.expiresAt) {
    await setStorage({
      deviceFlowState: {
        status: 'expired',
        error: '인증 시간이 초과되었습니다. 다시 시도해주세요.',
      },
    });
  }
}

async function cancelDeviceFlow() {
  if (pollingAbortController) {
    pollingAbortController.abort();
    pollingAbortController = null;
  }
  await removeStorage(['deviceFlowState']);
  return { ok: true };
}

// ============================================================================
// PAT Login & Logout
// ============================================================================

async function loginWithPAT(token) {
  const cleanToken = (token || '').trim();
  if (!cleanToken) {
    throw new Error('Personal Access Token을 입력해주세요.');
  }
  const user = await githubFetch('/user', cleanToken);
  await setStorage({
    githubToken: cleanToken,
    githubUsername: user.login,
    githubAvatarUrl: user.avatar_url || '',
    githubAuthMethod: 'pat',
    enableAutoUpload: true,
    deviceFlowState: { status: 'authorized', completedAt: Date.now() },
  });
  return {
    username: user.login,
    avatarUrl: user.avatar_url || '',
  };
}

async function logoutGitHub() {
  if (pollingAbortController) {
    pollingAbortController.abort();
    pollingAbortController = null;
  }
  await removeStorage([
    'githubToken',
    'githubUsername',
    'githubAvatarUrl',
    'githubAuthMethod',
    'githubRepo',
    'deviceFlowState',
  ]);
  return { ok: true };
}

// ============================================================================
// Repository Listing & Creation
// ============================================================================

async function listRepositories() {
  const { githubToken } = await getStorage(['githubToken']);
  if (!githubToken) {
    throw new Error('GitHub 로그인이 필요합니다.');
  }

  const repos = await githubFetch(
    '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    githubToken
  );

  return repos.map((r) => ({
    fullName: r.full_name,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch || 'main',
    htmlUrl: r.html_url,
    updatedAt: r.updated_at,
  }));
}

async function createRepository({ name, isPrivate, description }) {
  const { githubToken } = await getStorage(['githubToken']);
  if (!githubToken) {
    throw new Error('GitHub 로그인이 필요합니다.');
  }
  const cleanName = (name || '').trim();
  if (!cleanName) {
    throw new Error('생성할 저장소 이름을 입력해주세요.');
  }

  const repo = await githubFetch('/user/repos', githubToken, {
    method: 'POST',
    body: {
      name: cleanName,
      description: description || '프로그래머스 & 코딩 테스트 문제 풀이 자동 아카이브 (ProgrammersHub)',
      private: Boolean(isPrivate),
      auto_init: true,
    },
  });

  await setStorage({
    githubRepo: repo.full_name,
    githubDefaultBranch: repo.default_branch || 'main',
  });

  return {
    fullName: repo.full_name,
    defaultBranch: repo.default_branch || 'main',
    htmlUrl: repo.html_url,
  };
}

// ============================================================================
// GitHub Upload (Single Problem Commit - BaekjoonHub Compatible)
// ============================================================================

function encodeGitHubPath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function uploadProblemToGitHub(payload) {
  const {
    problemId,
    title,
    level,
    directory,
    fileName,
    code,
    readme,
    commitMessage,
    force = false,
  } = payload;

  const {
    githubToken,
    githubRepo,
    enableAutoUpload = true,
    uploadedShaCache = {},
    uploadHistory = [],
  } = await getStorage([
    'githubToken',
    'githubRepo',
    'enableAutoUpload',
    'uploadedShaCache',
    'uploadHistory',
  ]);

  if (!enableAutoUpload && !force) {
    return {
      status: 'disabled',
      message: '자동 업로드가 비활성화되어 있습니다.',
    };
  }

  if (!githubToken) {
    throw new Error('GitHub 계정이 연결되어 있지 않습니다. 확장 프로그램 아이콘을 눌러 로그인해주세요.');
  }

  if (!githubRepo) {
    throw new Error('커밋할 GitHub 저장소(Repository)가 선택되지 않았습니다. 확장 프로그램 팝업에서 저장소를 선택해주세요.');
  }

  const codeFilePath = `${directory}/${fileName}`;
  const readmeFilePath = `${directory}/README.md`;
  const calcCodeSha = await calculateGitBlobSHA(code);

  // 1. 저장소 기본 브랜치 확인
  const repoInfo = await githubFetch(`/repos/${githubRepo}`, githubToken);
  const defaultBranch = repoInfo.default_branch || 'main';

  // 2. 원격 파일 존재 및 SHA 비교 (중복 커밋 방지)
  if (!force) {
    const remoteFile = await githubFetch(
      `/repos/${githubRepo}/contents/${encodeGitHubPath(codeFilePath)}?ref=${encodeURIComponent(defaultBranch)}`,
      githubToken,
      { allow404: true }
    );

    if (remoteFile && remoteFile.sha === calcCodeSha) {
      const folderUrl = `https://github.com/${githubRepo}/tree/${encodeURIComponent(defaultBranch)}/${encodeGitHubPath(directory)}`;
      return {
        status: 'skipped',
        message: '이미 동일한 코드가 GitHub에 커밋되어 있습니다.',
        folderUrl,
        branch: defaultBranch,
        repo: githubRepo,
      };
    }
  }

  // 3. Git Data API로 코드 파일 + README.md 단일 원자적 커밋 수행
  let commitSha = null;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const refData = await githubFetch(
      `/repos/${githubRepo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      githubToken,
      { allow404: true, allow409: true }
    );

    // 완전히 비어 있는 초기 저장소(커밋 0개)인 경우 Contents API로 초기화 후 커밋
    if (!refData || refData._emptyRepoConflict) {
      await githubFetch(
        `/repos/${githubRepo}/contents/${encodeGitHubPath(readmeFilePath)}`,
        githubToken,
        {
          method: 'PUT',
          body: {
            message: commitMessage,
            content: toBase64Unicode(readme),
            branch: defaultBranch,
          },
        }
      );
      const codePutRes = await githubFetch(
        `/repos/${githubRepo}/contents/${encodeGitHubPath(codeFilePath)}`,
        githubToken,
        {
          method: 'PUT',
          body: {
            message: commitMessage,
            content: toBase64Unicode(code),
            branch: defaultBranch,
          },
        }
      );
      commitSha = codePutRes?.commit?.sha || null;
      break;
    }

    const headCommitSha = refData.object.sha;

    const parentCommit = await githubFetch(
      `/repos/${githubRepo}/git/commits/${headCommitSha}`,
      githubToken
    );
    const baseTreeSha = parentCommit.tree.sha;

    const newTree = await githubFetch(`/repos/${githubRepo}/git/trees`, githubToken, {
      method: 'POST',
      body: {
        base_tree: baseTreeSha,
        tree: [
          {
            path: codeFilePath,
            mode: '100644',
            type: 'blob',
            content: code,
          },
          {
            path: readmeFilePath,
            mode: '100644',
            type: 'blob',
            content: readme,
          },
        ],
      },
    });

    const newCommit = await githubFetch(`/repos/${githubRepo}/git/commits`, githubToken, {
      method: 'POST',
      body: {
        message: commitMessage,
        tree: newTree.sha,
        parents: [headCommitSha],
      },
    });

    try {
      await githubFetch(
        `/repos/${githubRepo}/git/refs/heads/${encodeURIComponent(defaultBranch)}`,
        githubToken,
        {
          method: 'PATCH',
          body: {
            sha: newCommit.sha,
            force: false,
          },
        }
      );
      commitSha = newCommit.sha;
      break;
    } catch (patchErr) {
      if (attempt === maxAttempts) {
        throw patchErr;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  // 4. 업로드 캐시 및 히스토리 기록
  const cacheKey = `${githubRepo}/${codeFilePath}`;
  uploadedShaCache[cacheKey] = calcCodeSha;

  const folderUrl = `https://github.com/${githubRepo}/tree/${encodeURIComponent(defaultBranch)}/${encodeGitHubPath(directory)}`;
  const commitUrl = commitSha
    ? `https://github.com/${githubRepo}/commit/${commitSha}`
    : folderUrl;

  const newHistoryEntry = {
    problemId,
    title,
    level,
    repo: githubRepo,
    directory,
    fileName,
    folderUrl,
    commitUrl,
    timestamp: Date.now(),
  };

  const updatedHistory = [
    newHistoryEntry,
    ...uploadHistory.filter((item) => !(item.problemId === problemId && item.repo === githubRepo)),
  ].slice(0, 30);

  await setStorage({
    uploadedShaCache,
    uploadHistory: updatedHistory,
  });

  return {
    status: 'uploaded',
    message: 'GitHub 커밋 완료!',
    folderUrl,
    commitUrl,
    commitSha,
    branch: defaultBranch,
    repo: githubRepo,
  };
}

// ============================================================================
// Message Listener
// ============================================================================

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleAsync = async () => {
    switch (message?.type) {
      case 'START_DEVICE_FLOW':
        return await startDeviceFlow(message.clientId);

      case 'CANCEL_DEVICE_FLOW':
        return await cancelDeviceFlow();

      case 'LOGIN_WITH_PAT':
        return await loginWithPAT(message.token);

      case 'LOGOUT':
        return await logoutGitHub();

      case 'LIST_REPOS':
        return await listRepositories();

      case 'CREATE_REPO':
        return await createRepository(message.payload || {});

      case 'UPLOAD_PROBLEM':
        return await uploadProblemToGitHub(message.payload || {});

      case 'GET_CONFIG': {
        const data = await getStorage([
          'githubToken',
          'githubUsername',
          'githubAvatarUrl',
          'githubAuthMethod',
          'githubClientId',
          'githubRepo',
          'orgOption',
          'enableAutoUpload',
          'deviceFlowState',
          'uploadHistory',
        ]);

        let effectiveClientId = data.githubClientId || DEFAULT_GITHUB_CLIENT_ID;
        if (effectiveClientId === LEGACY_BROKEN_CLIENT_ID) {
          effectiveClientId = DEFAULT_GITHUB_CLIENT_ID;
          await setStorage({ githubClientId: effectiveClientId });
        }

        let flowState = data.deviceFlowState || null;
        if (flowState && flowState.clientId === LEGACY_BROKEN_CLIENT_ID) {
          flowState = null;
          await removeStorage(['deviceFlowState']);
        }

        return {
          isLoggedIn: Boolean(data.githubToken),
          username: data.githubUsername || '',
          avatarUrl: data.githubAvatarUrl || '',
          authMethod: data.githubAuthMethod || 'device_flow',
          clientId: effectiveClientId,
          repo: data.githubRepo || '',
          orgOption: data.orgOption || 'platform',
          enableAutoUpload: data.enableAutoUpload !== false,
          deviceFlowState: flowState,
          uploadHistory: data.uploadHistory || [],
        };
      }

      case 'SAVE_SETTINGS': {
        const updates = {};
        if (message.githubRepo !== undefined) updates.githubRepo = message.githubRepo;
        if (message.orgOption !== undefined) updates.orgOption = message.orgOption;
        if (message.enableAutoUpload !== undefined) updates.enableAutoUpload = Boolean(message.enableAutoUpload);
        if (message.githubClientId !== undefined) {
          updates.githubClientId = message.githubClientId.trim() || DEFAULT_GITHUB_CLIENT_ID;
        }
        await setStorage(updates);
        return { ok: true };
      }

      default:
        throw new Error(`알 수 없는 메시지 타입입니다: ${message?.type}`);
    }
  };

  handleAsync()
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => {
      console.error('[ProgrammersHub Background Error]', err);
      sendResponse({
        ok: false,
        error: err?.message || String(err),
        status: err?.status || 500,
      });
    });

  return true;
});

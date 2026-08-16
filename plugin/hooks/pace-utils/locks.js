const fs = require('fs');
const path = require('path');
const {
  ARTIFACT_WRITER_LOCK_FILE,
  ARTIFACT_WRITER_LOCK_TTL_MS,
  ARTIFACT_RESOURCE_LOCK_TTL_MS,
  ARTIFACT_RESOURCE_LOCK_WAIT_MS,
  ARTIFACT_SEQUENCE_LOCK_TTL_MS,
  ARTIFACT_SEQUENCE_LOCK_WAIT_MS,
} = require('./constants');
const {
  normalizeChangeId,
  slugForChangeId,
} = require('./change-id');

module.exports = function createLockUtils(ctx) {
  function getArtifactWriterLockPath(cwd) {
    return path.join(ctx.getProjectRuntimeDir(cwd), ARTIFACT_WRITER_LOCK_FILE);
  }

  function readArtifactWriterLock(cwd) {
    const lockPath = getArtifactWriterLockPath(cwd);
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ok: true,
        path: lockPath,
        sessionId: ctx.normalizeSessionId(parsed.sessionId || parsed.session_id),
        agentId: String(parsed.agentId || parsed.agent_id || '').trim(),
        artifactDir: String(parsed.artifactDir || parsed.artifact_dir || ''),
        cwd: String(parsed.cwd || ''),
        operation: String(parsed.operation || ''),
        createdAt: String(parsed.createdAt || parsed.created_at || ''),
        timestampMs: Number(parsed.timestampMs || parsed.timestamp_ms || 0) || 0,
        raw: parsed,
      };
    } catch(e) {
      return { ok: false, path: lockPath, error: e.message, code: e.code || '' };
    }
  }

  function isArtifactWriterLockStale(lock, now = Date.now()) {
    if (!lock) return false;
    if (!lock.ok) return true;
    if (!lock.timestampMs) return true;
    return now - lock.timestampMs > ARTIFACT_WRITER_LOCK_TTL_MS;
  }

  function operationFromAgentPrompt(prompt) {
    const text = String(prompt || '');
    const byField = text.match(/^\s*(?:operation|指令)\s*[:=][^\S\n]*([a-z0-9-]+)/mi);
    if (byField) return byField[1].toLowerCase();
    const known = text.match(/\b(create-chg|update-chg|archive-chg|close-chg|record-finding|record-correction)\b/i);
    if (known) return known[1].toLowerCase();
    if (/(?:^|[\n,，;；])\s*(approve-and-start|approve|update-status)(?=$|[\s,，;；:：])/i.test(text)) return 'update-chg';
    return '';
  }

  function changeIdFromAgentPrompt(prompt) {
    const text = String(prompt || '');
    const target = text.match(/^\s*(?:target|change-id|chg-id)\s*[:=]\s*["']?((?:CHG|HOTFIX)-\d{8}-\d{2})["']?\s*$/mi);
    if (target) return target[1].toUpperCase();
    const reserved = text.match(/^\s*reserved-id\s*[:=]\s*["']?((?:CHG|HOTFIX)-\d{8}-\d{2})["']?\s*$/mi);
    if (reserved) return reserved[1].toUpperCase();
    const any = text.match(/\b((?:CHG|HOTFIX)-\d{8}-\d{2})\b/i);
    return any ? any[1].toUpperCase() : '';
  }

  function explicitChangeTargetFromAgentPrompt(prompt) {
    const text = String(prompt || '');
    const target = text.match(/^\s*(?:target|change-id|chg-id)\s*[:=]\s*["']?((?:CHG|HOTFIX)-\d{8}-\d{2})["']?\s*$/mi);
    return target ? target[1].toUpperCase() : '';
  }

  function artifactWriterLockMatches(cwd, sessionId) {
    const lock = readArtifactWriterLock(cwd);
    if (!lock.ok) return { ok: false, lock, reason: 'missing' };
    if (isArtifactWriterLockStale(lock)) {
      try { fs.unlinkSync(lock.path); } catch(e) {}
      return { ok: false, lock, reason: 'stale-cleared' };
    }
    const sid = ctx.normalizeSessionId(sessionId || ctx.currentSessionId());
    if (!sid || !lock.sessionId || lock.sessionId !== sid) {
      return { ok: false, lock, reason: 'owner-mismatch' };
    }
    return { ok: true, lock, reason: '' };
  }

  function sleepSync(ms) {
    if (!ms || ms <= 0) return;
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, Math.floor(ms)));
  }

  function lockOwnerInfo(info = {}) {
    const sessionId = ctx.normalizeSessionId(info.sessionId || ctx.currentSessionId());
    const agentId = String(info.agentId || '').trim();
    const ownerKey = agentId ? `agent:${agentId}` : (sessionId ? `session:${sessionId}` : '');
    return { sessionId, agentId, ownerKey };
  }

  function lockMatchesOwner(lock, info = {}) {
    if (!lock || !lock.ok) return false;
    const owner = lockOwnerInfo(info);
    if (owner.agentId && lock.agentId) return owner.agentId === lock.agentId;
    if (owner.ownerKey && lock.ownerKey && owner.ownerKey === lock.ownerKey) return true;
    return !!owner.sessionId && !!lock.sessionId && owner.sessionId === lock.sessionId;
  }

  function safeLockName(value) {
    return encodeURIComponent(String(value || 'unknown')).replace(/%/g, '_');
  }

  function readJsonLock(lockPath) {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ok: true,
        path: lockPath,
        sessionId: ctx.normalizeSessionId(parsed.sessionId || parsed.session_id),
        agentId: String(parsed.agentId || parsed.agent_id || '').trim(),
        ownerKey: String(parsed.ownerKey || parsed.owner_key || '').trim(),
        resource: String(parsed.resource || ''),
        artifactDir: String(parsed.artifactDir || parsed.artifact_dir || ''),
        cwd: String(parsed.cwd || ''),
        file: String(parsed.file || ''),
        operation: String(parsed.operation || ''),
        createdAt: String(parsed.createdAt || parsed.created_at || ''),
        timestampMs: Number(parsed.timestampMs || parsed.timestamp_ms || 0) || 0,
        raw: parsed,
      };
    } catch(e) {
      // ROB-02：读取/解析失败时附带锁文件 mtime，供 jsonLockIsStale 区分 in-flight 空窗口与真损坏锁
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(lockPath).mtimeMs; } catch(e2) {}
      return { ok: false, path: lockPath, error: e.message, code: e.code || '', mtimeMs };
    }
  }

  function jsonLockIsStale(lock, ttlMs, now = Date.now()) {
    if (!lock) return false;
    if (!lock.ok) {
      // ROB-02：读取/解析失败（含另一进程 openSync(wx) 后尚未写 body 的 in-flight 空文件窗口）
      // 不立即判 stale，给 mtime 短宽限期；超过宽限才视为损坏锁清理，避免抢占 in-flight 锁致双持。
      const INFLIGHT_GRACE_MS = 1000;
      if (lock.mtimeMs && now - lock.mtimeMs <= INFLIGHT_GRACE_MS) return false;
      return true;
    }
    if (!lock.timestampMs) return true;
    return now - lock.timestampMs > ttlMs;
  }

  function acquireJsonLock(lockPath, payload, { ttlMs, waitMs, reentrant = true } = {}) {
    const started = Date.now();
    const deadline = started + Math.max(0, waitMs || 0);
    let delay = 50;
    for (;;) {
      const now = Date.now();
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const fd = fs.openSync(lockPath, 'wx');
        try { fs.writeFileSync(fd, `${JSON.stringify({ ...payload, timestampMs: now, createdAt: new Date(now).toISOString() }, null, 2)}\n`, 'utf8'); }
        finally { fs.closeSync(fd); }
        return { acquired: true, path: lockPath, lock: readJsonLock(lockPath), waitedMs: now - started };
      } catch(e) {
        if (e && e.code === 'EEXIST') {
          const existing = readJsonLock(lockPath);
          if (jsonLockIsStale(existing, ttlMs, now)) {
            try {
              fs.unlinkSync(lockPath);
            } catch(e2) {
              if (!e2 || e2.code !== 'ENOENT') {
                return { acquired: false, path: lockPath, lock: existing, reason: e2 && e2.message || String(e2), waitedMs: Date.now() - started };
              }
            }
            continue;
          }
          if (reentrant && lockMatchesOwner(existing, payload)) {
            return { acquired: true, reentrant: true, path: lockPath, lock: existing, waitedMs: now - started };
          }
          if (now < deadline) {
            sleepSync(Math.min(delay, deadline - now));
            delay = Math.min(250, delay * 2);
            continue;
          }
          return { acquired: false, path: lockPath, lock: existing, reason: 'locked', waitedMs: now - started };
        }
        return { acquired: false, path: lockPath, lock: null, reason: e.message || String(e), waitedMs: Date.now() - started };
      }
    }
  }

  function releaseJsonLock(lockPath, info = {}, { ttlMs = ARTIFACT_RESOURCE_LOCK_TTL_MS } = {}) {
    const lock = readJsonLock(lockPath);
    if (!lock.ok) return { released: false, lock, reason: 'missing' };
    if (!lockMatchesOwner(lock, info) && !jsonLockIsStale(lock, ttlMs)) {
      return { released: false, lock, reason: 'owner-mismatch' };
    }
    try {
      fs.unlinkSync(lockPath);
      return { released: true, lock, reason: '' };
    } catch(e) {
      return { released: false, lock, reason: e.message || String(e) };
    }
  }

  function getArtifactResourceLockDir(cwd) {
    return path.join(ctx.getProjectRuntimeDir(cwd), 'locks', 'artifacts');
  }

  function getArtifactResourceLockPath(cwd, resource) {
    return path.join(getArtifactResourceLockDir(cwd), `${safeLockName(resource)}.lock`);
  }

  function readArtifactResourceLock(cwd, resource, { ttlMs = ARTIFACT_RESOURCE_LOCK_TTL_MS } = {}) {
    const lockPath = getArtifactResourceLockPath(cwd, resource);
    const lock = readJsonLock(lockPath);
    if (!lock.ok && lock.code === 'ENOENT') return lock;
    if (jsonLockIsStale(lock, ttlMs)) {
      try {
        fs.unlinkSync(lockPath);
      } catch(e) {
        if (!e || e.code !== 'ENOENT') {
          return { ...lock, stale: true, cleanupError: e && e.message || String(e) };
        }
      }
      return { ok: false, path: lockPath, stale: true, lock };
    }
    return lock;
  }

  function artifactResourceForRel(artifactRel) {
    const rel = String(artifactRel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel === 'spec.md') return '';
    // v7（CHG-20260611-08）：双文件合并后只有 task.md 映射 index:changes。资源名不改——
    // 旧版本并发 session 用同名锁同一文件，改名会使新旧两把锁互不互斥。
    // impl_plan 不再映射（tombstone 受 PROTECTED 保护，artifact-writer 不再写它）。
    if (rel === 'task.md') return 'index:changes';
    if (rel === 'findings.md' || rel === 'corrections.md' || rel === 'walkthrough.md') return `index:${rel}`;
    if (/^changes\/.+\.md$/i.test(rel)) return `detail:${rel}`;
    return '';
  }

  function formatArtifactResourceLock(lock) {
    if (!lock || !lock.ok) return 'unknown lock';
    const ageSec = lock.timestampMs ? Math.max(0, Math.round((Date.now() - lock.timestampMs) / 1000)) : '?';
    return `resource=${lock.resource || '-'} session=${lock.sessionId || '-'} agent=${lock.agentId || '-'} file=${lock.file || '-'} age=${ageSec}s lock=${lock.path}`;
  }

  function acquireArtifactResourceLock(cwd, resource, info = {}) {
    if (!resource) return { acquired: true, path: '', lock: null, reason: 'no-resource' };
    const owner = lockOwnerInfo(info);
    const payload = {
      version: 'resource-v1',
      resource,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      ownerKey: owner.ownerKey,
      artifactDir: String(info.artifactDir || ''),
      cwd: String(cwd || ''),
      file: String(info.file || ''),
      operation: String(info.operation || ''),
      toolName: String(info.toolName || ''),
    };
    return acquireJsonLock(getArtifactResourceLockPath(cwd, resource), payload, {
      ttlMs: ARTIFACT_RESOURCE_LOCK_TTL_MS,
      waitMs: ARTIFACT_RESOURCE_LOCK_WAIT_MS,
    });
  }

  function releaseArtifactResourceLock(cwd, resource, info = {}) {
    if (!resource) return { released: false, lock: null, reason: 'no-resource' };
    return releaseJsonLock(getArtifactResourceLockPath(cwd, resource), info, { ttlMs: ARTIFACT_RESOURCE_LOCK_TTL_MS });
  }

  function ownerScopedPath(cwd, dirName, info = {}) {
    const owner = lockOwnerInfo(info);
    if (!owner.ownerKey) return '';
    return path.join(ctx.getProjectRuntimeDir(cwd), dirName, `${safeLockName(owner.ownerKey)}.json`);
  }

  function getArtifactReservationPath(cwd, info = {}) {
    return ownerScopedPath(cwd, 'reservations', info);
  }

  function getArtifactReservationDir(cwd) {
    return path.join(ctx.getProjectRuntimeDir(cwd), 'reservations');
  }

  function reservationMatchesOwner(reservation, info = {}) {
    if (!reservation) return false;
    const owner = lockOwnerInfo(info);
    if (owner.agentId && reservation.agentId) return owner.agentId === reservation.agentId;
    if (owner.ownerKey && reservation.ownerKey && owner.ownerKey === reservation.ownerKey) return true;
    return !!owner.sessionId && !!reservation.sessionId && owner.sessionId === reservation.sessionId;
  }

  // HOTFIX-20260816-03（审计 P1-2）：超期 reservation 一律视为不存在——此前只有 findArtifactReservationForRel /
  // reserve helper 判 TTL，派遣门经本函数读到超期预留会回吐已过期 id，调用方带它重派又被 lookup 判「无效或已过期」，
  // 两轮无效 deny 才自恢复。统一在读取处过滤，与 findArtifactReservationForRel / reusableReservation 对齐。
  function reservationExpired(reservation, now = Date.now()) {
    return !!(reservation && reservation.timestampMs && now - reservation.timestampMs > ARTIFACT_WRITER_LOCK_TTL_MS);
  }

  function readArtifactReservation(cwd, info = {}) {
    const fp = getArtifactReservationPath(cwd, info);
    if (fp) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (!reservationExpired(parsed)) return parsed;
      } catch(e) {}
    }
    if (info.agentId) {
      const fallback = getArtifactReservationPath(cwd, { ...info, agentId: '' });
      if (fallback && fallback !== fp) {
        try {
          const parsed = JSON.parse(fs.readFileSync(fallback, 'utf8'));
          if (!reservationExpired(parsed)) return parsed;
        } catch(e) {}
      }
    }
    return null;
  }

  function writeArtifactReservation(cwd, info = {}, reservation = {}) {
    const fp = getArtifactReservationPath(cwd, info);
    if (!fp) return { ok: false, reason: 'missing-owner' };
    try {
      const data = { ...reservation, ...lockOwnerInfo(info), createdAt: new Date().toISOString(), timestampMs: Date.now() };
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      const uniqueKey = reservation.id || reservation.fileRel || reservation.filePrefix || '';
      if (uniqueKey) {
        const uniquePath = path.join(getArtifactReservationDir(cwd), `${safeLockName(`${data.ownerKey}:${uniqueKey}`)}.json`);
        if (uniquePath !== fp) fs.writeFileSync(uniquePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      }
      return { ok: true, path: fp };
    } catch(e) {
      return { ok: false, reason: e.message || String(e) };
    }
  }

  function clearArtifactReservation(cwd, info = {}) {
    const fp = getArtifactReservationPath(cwd, info);
    let cleared = false;
    if (fp) {
      try { fs.unlinkSync(fp); cleared = true; } catch(e) {}
    }
    let files = [];
    try { files = fs.readdirSync(getArtifactReservationDir(cwd)); } catch(e) { files = []; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const target = path.join(getArtifactReservationDir(cwd), file);
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); } catch(e) {}
      const shouldClear = info.agentId
        ? (String(parsed && parsed.agentId || '').trim() === String(info.agentId).trim())
        : reservationMatchesOwner(parsed, info);
      if (shouldClear) {
        try { fs.unlinkSync(target); cleared = true; } catch(e) {}
      }
    }
    return cleared;
  }

  function clearArtifactReservationForRel(cwd, info = {}, artifactRel = '') {
    const rel = String(artifactRel || '').replace(/\\/g, '/');
    if (!rel) return false;
    let cleared = false;
    let files = [];
    try { files = fs.readdirSync(getArtifactReservationDir(cwd)); } catch(e) { files = []; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const target = path.join(getArtifactReservationDir(cwd), file);
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); } catch(e) {}
      if (!reservationMatchesOwner(parsed, info)) continue;
      // HOTFIX-20260816-03：消费用精确判据（rel 必须是该 reservation 自己的目标文件），不复用默认放行的校验判据
      if (!reservationConsumedByRel(parsed, rel)) continue;
      try { fs.unlinkSync(target); cleared = true; } catch(e) {}
    }
    return cleared;
  }

  function findArtifactReservationForRel(cwd, info = {}, artifactRel = '') {
    const candidates = [];
    const direct = readArtifactReservation(cwd, info);
    if (direct) candidates.push(direct);
    let files = [];
    try { files = fs.readdirSync(getArtifactReservationDir(cwd)); } catch(e) { files = []; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try { candidates.push(JSON.parse(fs.readFileSync(path.join(getArtifactReservationDir(cwd), file), 'utf8'))); } catch(e) {}
    }
    const seen = new Set();
    for (const candidate of candidates) {
      const key = `${candidate && candidate.ownerKey}:${candidate && (candidate.fileRel || candidate.filePrefix || candidate.id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (candidate && candidate.timestampMs && Date.now() - candidate.timestampMs > ARTIFACT_WRITER_LOCK_TTL_MS) continue;
      if (!reservationMatchesOwner(candidate, info)) continue;
      if (reservationMatchesArtifactRel(candidate, artifactRel).ok) return candidate;
    }
    return null;
  }

  function releaseArtifactResourcesForOwner(cwd, info = {}) {
    const owner = lockOwnerInfo(info);
    const released = [];
    const dirs = [
      getArtifactResourceLockDir(cwd),
      path.join(ctx.getProjectRuntimeDir(cwd), 'locks', 'sequences'),
    ];
    for (const dir of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch(e) { continue; }
      for (const file of files) {
        if (!file.endsWith('.lock')) continue;
        const fp = path.join(dir, file);
        const lock = readJsonLock(fp);
        if (lockMatchesOwner(lock, owner) || jsonLockIsStale(lock, ARTIFACT_RESOURCE_LOCK_TTL_MS)) {
          try {
            fs.unlinkSync(fp);
            released.push(fp);
          } catch(e) {}
        }
      }
    }
    // HOTFIX-20260816-03：调用方有三处——SubagentStop（agent 上下文，宿主字段可缺，缺 agent_id 已有实录）、
    // PostToolUseFailure-Agent（跑在派遣方上下文，主 session 派遣时 agentId 恒空）、MCP writer-pipeline 失败回滚（agentId 非空）。
    // owner 无 agentId 时它退化成 session 级——此时清 reservation 会把主 session 的预留一并删掉，所以只有带 agentId 才清
    // 该 agent 自己的 reservation。副作用：Agent 派遣失败后 session 级预留保留（下次 reserve 由 reusableReservation 复用，
    // 超期由 readArtifactReservation 过滤 + SessionStart sweep 回收），不再像修前那样被派遣失败顺手清掉。资源锁清理不受影响
    // （lockMatchesOwner 在 agentId 空时回落 sessionId 比对，仍能清子 agent 持有的锁）。
    if (owner.agentId) clearArtifactReservation(cwd, owner);
    const txPath = ownerScopedPath(cwd, 'index-transactions', owner);
    try { fs.unlinkSync(txPath); } catch(e) {}
    return released;
  }

  function getChangeOwnerDir(cwd) {
    return path.join(ctx.getProjectRuntimeDir(cwd), 'change-owners');
  }

  // RSL-01/02：按 mtime + TTL 清理 change-owners / reservations 的 stale json，遏制无界增长与
  // owner-key 不匹配的孤儿泄漏。closed owner 与超 TTL 文件清理，活跃（fresh）记录保留。
  // 由 SessionStart 每会话调用一次。
  function sweepStaleRuntimeOwners(cwd, { ttlMs = ctx.CHANGE_OWNER_TTL_MS, now = Date.now() } = {}) {
    const swept = [];
    for (const dir of [getChangeOwnerDir(cwd), getArtifactReservationDir(cwd)]) {
      let files = [];
      try { files = fs.readdirSync(dir); } catch(e) { continue; }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const fp = path.join(dir, file);
        let parsed = null;
        try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) {}
        const closed = !!parsed && parsed.state === 'closed';
        // CHG-20260614-02 T-001：staleness 用 owner 内部 timestampMs（与 jsonLockIsStale/changeOwnerStatus 一致），
        // 不用文件 mtime——避免活跃 session 持有的 owner（内部 timestampMs 已被 heartbeat 刷新）因 mtime 静止被误清。
        // 内部 timestampMs 缺失（异常记录）回退文件 mtime，仍能清理孤儿。
        const ts = parsed ? (Number(parsed.timestampMs || parsed.timestamp_ms || 0) || 0) : 0;
        let stale;
        if (ts) {
          stale = now - ts > ttlMs;
        } else {
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(fp).mtimeMs; } catch(e) { continue; }
          stale = now - mtimeMs > ttlMs;
        }
        if (closed || stale) {
          try { fs.unlinkSync(fp); swept.push(fp); } catch(e) {}
        }
      }
    }
    return swept;
  }

  function getChangeOwnerPath(cwd, changeId) {
    const id = normalizeChangeId(changeId);
    if (!id) return '';
    return path.join(getChangeOwnerDir(cwd), `${slugForChangeId(id)}.json`);
  }

  function readChangeOwner(cwd, changeId) {
    const fp = getChangeOwnerPath(cwd, changeId);
    if (!fp) return { ok: false, path: '', reason: 'invalid-id' };
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      return {
        ok: true,
        path: fp,
        changeId: normalizeChangeId(parsed.changeId || parsed.change_id || changeId),
        sessionId: ctx.normalizeSessionId(parsed.sessionId || parsed.session_id),
        agentId: String(parsed.agentId || parsed.agent_id || '').trim(),
        ownerKey: String(parsed.ownerKey || parsed.owner_key || '').trim(),
        state: String(parsed.state || 'active'),
        cwd: String(parsed.cwd || ''),
        stateDir: String(parsed.stateDir || parsed.state_dir || ''),
        worktree: String(parsed.worktree || ''),
        branch: String(parsed.branch || ''),
        operation: String(parsed.operation || ''),
        createdAt: String(parsed.createdAt || parsed.created_at || ''),
        updatedAt: String(parsed.updatedAt || parsed.updated_at || ''),
        timestampMs: Number(parsed.timestampMs || parsed.timestamp_ms || 0) || 0,
        raw: parsed,
      };
    } catch(e) {
      return { ok: false, path: fp, reason: e.message || String(e) };
    }
  }

  function writeChangeOwner(cwd, changeId, info = {}) {
    const id = normalizeChangeId(changeId);
    const fp = getChangeOwnerPath(cwd, id);
    if (!id || !fp) return { ok: false, reason: 'invalid-id' };
    const owner = lockOwnerInfo(info);
    if (!owner.sessionId && !owner.agentId) return { ok: false, reason: 'missing-owner' };
    const existing = readChangeOwner(cwd, id);
    const context = ctx.executionContextForCwd(cwd);
    const now = Date.now();
    const payload = {
      version: 'change-owner-v1',
      changeId: id,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      ownerKey: owner.ownerKey,
      state: String(info.state || 'active'),
      cwd: context.cwd,
      stateDir: context.stateDir,
      worktree: context.worktree,
      branch: context.branch,
      executionContext: context.text,
      operation: String(info.operation || ''),
      createdAt: existing.ok && existing.createdAt ? existing.createdAt : new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      timestampMs: now,
    };
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      return { ok: true, path: fp, owner: payload };
    } catch(e) {
      return { ok: false, path: fp, reason: e.message || String(e) };
    }
  }

  function markChangeOwnerClosed(cwd, changeId, info = {}) {
    const current = readChangeOwner(cwd, changeId);
    if (!current.ok) return { ok: false, reason: 'missing' };
    const owner = lockOwnerInfo(info);
    if (!lockMatchesOwner({ ok: true, ...current }, owner) && !jsonLockIsStale(current, ctx.CHANGE_OWNER_TTL_MS)) {
      return { ok: false, reason: 'owner-mismatch', owner: current };
    }
    return writeChangeOwner(cwd, changeId, { ...info, state: 'closed', operation: info.operation || current.operation || 'close' });
  }

  // 本 session owner 记录的通用改写骨架：sessionId 匹配 + state 过滤（fromStates 为 null 时仅排除
  // closed，对齐 touch 旧语义）后，刷新执行上下文与 timestampMs 并应用 patch。touch/detach/revive 共用。
  function _rewriteChangeOwnersForSession(cwd, info = {}, { fromStates = null, patch = {} } = {}) {
    const sid = ctx.normalizeSessionId(info.sessionId || info.session_id || ctx.currentSessionId());
    if (!sid) return [];
    const states = Array.isArray(fromStates) && fromStates.length > 0 ? new Set(fromStates) : null;
    const dir = getChangeOwnerDir(cwd);
    let files = [];
    try { files = fs.readdirSync(dir); } catch(e) { return []; }
    const context = ctx.executionContextForCwd(cwd);
    const now = Date.now();
    const touched = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fp = path.join(dir, file);
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) { continue; }
      const ownerSid = ctx.normalizeSessionId(parsed.sessionId || parsed.session_id);
      const state = String(parsed.state || 'active');
      if (ownerSid !== sid || state === 'closed') continue;
      if (states && !states.has(state)) continue;
      const next = {
        ...parsed,
        cwd: context.cwd,
        stateDir: context.stateDir,
        worktree: context.worktree,
        branch: context.branch,
        executionContext: context.text,
        updatedAt: new Date(now).toISOString(),
        timestampMs: now,
        ...patch,
      };
      try {
        fs.writeFileSync(fp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        touched.push(normalizeChangeId(parsed.changeId || parsed.change_id || file.replace(/\.json$/, '')) || file.replace(/\.json$/, ''));
      } catch(e) {}
    }
    return touched;
  }

  function touchChangeOwnersForSession(cwd, info = {}) {
    const states = Array.isArray(info.states) && info.states.length > 0 ? info.states : null;
    return _rewriteChangeOwnersForSession(cwd, info, { fromStates: states, patch: {} });
  }

  // CHG-20260611-02：SessionEnd 把本 session 持有的活跃 owner 记录降级 detached（原 session 已
  // 正常关闭、CHG 待接手）；crash 不触发 SessionEnd 时由 CHANGE_OWNER_TTL_MS 转 sibling-stale 兜底。
  // detach 刷新 timestampMs 即 W6 sweep 30min 窗口起点（两段式接手窗口，spec §3.2）。
  function detachChangeOwnersForSession(cwd, info = {}) {
    return _rewriteChangeOwnersForSession(cwd, info, { fromStates: ['active', 'closing'], patch: { state: 'detached' } });
  }

  // CHG-20260611-02：同 session resume 后心跳把本 session 的 detached 记录升回 active——否则
  // state 停留 detached 会让 sibling 误判「可接手」，在原 session 活跃时抢走 CHG（spec §3.2）。
  function reviveDetachedChangeOwnersForSession(cwd, info = {}) {
    return _rewriteChangeOwnersForSession(cwd, info, { fromStates: ['detached'], patch: { state: 'active' } });
  }

  function changeOwnerStatus(cwd, changeId, sessionId = ctx.currentSessionId()) {
    const owner = readChangeOwner(cwd, changeId);
    if (!owner.ok) return { disposition: 'unknown', owner, current: false, fresh: false, stale: false };
    const sid = ctx.normalizeSessionId(sessionId || ctx.currentSessionId());
    const sameSession = !!sid && !!owner.sessionId && sid === owner.sessionId;
    const context = ctx.executionContextForCwd(cwd);
    const sameCwd = !!owner.cwd && ctx.normalizePath(path.resolve(owner.cwd)) === ctx.normalizePath(context.cwd);
    const sameStateDir = !!owner.stateDir && ctx.normalizePath(path.resolve(owner.stateDir)) === ctx.normalizePath(context.stateDir);
    const sameWorktreeName = !!owner.worktree && owner.worktree === context.worktree;
    const sameBranch = !!owner.branch && owner.branch === context.branch;
    const sameCheckout = sameCwd ||
      (sameStateDir && sameWorktreeName && sameBranch) ||
      (!owner.cwd && !owner.stateDir && sameWorktreeName && sameBranch);
    const stale = jsonLockIsStale(owner, ctx.CHANGE_OWNER_TTL_MS);
    const closed = owner.state === 'closed';
    if (sameSession) return { disposition: closed ? 'current-closed' : 'current', owner, current: true, sameSession: true, sameCheckout, fresh: true, stale: false };
    if (closed) return { disposition: 'closed', owner, current: false, fresh: true, stale: false };
    if (sameCheckout) {
      // STOP-03 对称：sid 空时无法区分同 session 与 sibling，保留 current-worktree 保守路径，
      // 避免把可能属于当前 session 的 running CHG 误降级（CHG-20260611-02，spec 2026-06-11 §3.1）。
      if (!sid) return { disposition: 'current-worktree', owner, current: true, sameSession: false, sameCheckout: true, fresh: !stale, stale };
      // sibling 三态：同 checkout 不同 session。detached（原 session 已正常关闭）优先判，
      // 其余按新鲜度分 fresh（原 session 活跃，B 只软提醒）/ stale（疑似 crash，可接手）。
      if (owner.state === 'detached') return { disposition: 'sibling-detached', owner, current: false, sameSession: false, sameCheckout: true, fresh: !stale, stale };
      if (stale) return { disposition: 'sibling-stale', owner, current: false, sameSession: false, sameCheckout: true, fresh: false, stale: true };
      return { disposition: 'sibling-fresh', owner, current: false, sameSession: false, sameCheckout: true, fresh: true, stale: false };
    }
    // STOP-03：无法确定 current session（sid 空——stdin 缺 session_id 且 env 无）时不判 foreign，
    // 避免把可能属于当前 session 的 running CHG 误当 foreign 跳过、放行未完成 CHG。
    if (!sid) return { disposition: 'unknown', owner, current: false, fresh: false, stale: false };
    if (stale) return { disposition: 'foreign-stale', owner, current: false, fresh: false, stale: true };
    return { disposition: 'foreign-fresh', owner, current: false, fresh: true, stale: false };
  }

  function ownerTakeoverConfirmed(prompt) {
    const text = String(prompt || '');
    return /^\s*owner-takeover-confirmed\s*[:=]\s*true\b/mi.test(text) &&
      /^\s*owner-takeover-source\s*[:=]\s*user-directive\b/mi.test(text) &&
      /^\s*owner-takeover-evidence\s*[:=]\s*\S+/mi.test(text);
  }

  // CHG-20260611-03：session 级 pause 标志（sessionId 键控）。SESSION_SCOPED_FLAGS 是项目级
  // 共享标志且被任何新 session 的 W3/W4 startup 清理，不可用于 per-session 状态——此处独立
  // 键控（不入 SESSION_SCOPED_FLAG_PREFIXES）。失效三路径：/paceflow:resume 删除、SessionEnd
  // 删除、mtime 超 SESSION_PAUSE_TTL_MS 懒清理（crash 残留兜底）。
  function sessionPausePath(cwd, sessionId) {
    const sid = ctx.normalizeSessionId(sessionId);
    // safeLockName 对齐全仓 session-keyed 文件名约定（R 审计 P3-1）：恶意 --session 值的
    // 路径分隔符被转义，穿越中和；真实 UUID sid 经 encodeURIComponent 原样不变。
    return sid ? path.join(ctx.getProjectRuntimeDir(cwd), `paused-${safeLockName(sid)}`) : '';
  }

  function writeSessionPause(cwd, sessionId) {
    const fp = sessionPausePath(cwd, sessionId);
    if (!fp) return false;
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, `${JSON.stringify({ sessionId: ctx.normalizeSessionId(sessionId), createdAt: new Date().toISOString(), timestampMs: Date.now() }, null, 2)}\n`, 'utf8');
      return true;
    } catch (e) { return false; }
  }

  function clearSessionPause(cwd, sessionId) {
    const fp = sessionPausePath(cwd, sessionId);
    if (!fp) return false;
    try {
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); return true; }
    } catch (e) {}
    return false;
  }

  function isSessionPaused(cwd, sessionId, now = Date.now()) {
    const fp = sessionPausePath(cwd, sessionId);
    if (!fp) return false;
    let st;
    try { st = fs.statSync(fp); } catch (e) { return false; }
    if (now - st.mtimeMs > ctx.SESSION_PAUSE_TTL_MS) {
      try { fs.unlinkSync(fp); } catch (e) {}
      return false;
    }
    return true;
  }

  function markIndexChangesTouchedAndMaybeRelease(cwd, artifactRel, info = {}) {
    // v7（CHG-20260611-08）：双文件合并后 index:changes 单文件直接释放；index-transaction
    // 双 touched 事务退役。保留函数名与签名（PostToolUse 等调用点零扰动）；
    // 残留 .pace/index-transactions/ 旧文件由 releaseArtifactResourcesForOwner 在 owner
    // 释放路径逐个清理（v7 不再产生新事务文件），整目录由 migrate-v7 一次性移除。
    const rel = String(artifactRel || '').replace(/\\/g, '/');
    return releaseArtifactResourceLock(cwd, artifactResourceForRel(rel), info);
  }

  function scanMaxNumberInDir(dir, re) {
    let max = 0;
    let files = [];
    try { files = fs.readdirSync(dir); } catch(e) { return 0; }
    for (const file of files) {
      const m = String(file).match(re);
      if (m) max = Math.max(max, Number(m[1]) || 0);
    }
    return max;
  }

  // 在同一序列锁内连续取 N 个编号，保证 batch 预留连号原子、避免并发插号。
  // count=1 时等价于单条取号；返回 number=首号（向后兼容单数调用方）+ numbers=全部 N 个。
  function nextSequenceNumbers(cwd, sequenceName, existingMax, count = 1) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const runtime = ctx.getProjectRuntimeDir(cwd);
    const lockPath = path.join(runtime, 'locks', 'sequences', `${safeLockName(sequenceName)}.lock`);
    const counterPath = path.join(runtime, 'sequences', `${safeLockName(sequenceName)}.counter`);
    const owner = lockOwnerInfo({ sessionId: ctx.currentSessionId() });
    const lock = acquireJsonLock(lockPath, {
      version: 'sequence-v1',
      resource: `sequence:${sequenceName}`,
      sessionId: owner.sessionId,
      ownerKey: owner.ownerKey,
    }, { ttlMs: ARTIFACT_SEQUENCE_LOCK_TTL_MS, waitMs: ARTIFACT_SEQUENCE_LOCK_WAIT_MS, reentrant: false });
    if (!lock.acquired) return { ok: false, reason: 'sequence-locked', lock: lock.lock };
    try {
      let current = 0;
      try { current = Math.floor(Number(fs.readFileSync(counterPath, 'utf8').trim())) || 0; } catch(e) {}   // Math.floor（CHG-20260616-03 T-002 / P3.4）：counter 文件被外部损坏成浮点('3.7')时整数化，防产非整数编号；NaN 经 || 0 兜底
      const first = Math.max(current, existingMax || 0) + 1;
      const numbers = [];
      for (let i = 0; i < n; i++) numbers.push(first + i);
      fs.mkdirSync(path.dirname(counterPath), { recursive: true });
      fs.writeFileSync(counterPath, `${first + n - 1}\n`, 'utf8');
      return { ok: true, number: first, numbers, counterPath };
    } finally {
      if (!lock.reentrant) {
        try { fs.unlinkSync(lockPath); } catch(e) {}
      }
    }
  }

  function inferChangeKindFromPrompt(prompt) {
    const text = String(prompt || '');
    if (/^\s*type\s*[:=]\s*["']?hotfix["']?\s*$/mi.test(text) || /["']type["']\s*:\s*["']hotfix["']/i.test(text)) {
      return 'HOTFIX';
    }
    return 'CHG';
  }

  // 批量预留 N 个唯一编号；count=1 时与单条预留等价。返回 reservations 数组，
  // 每个元素形如单数 reserveArtifactId 的成功返回（create-chg: {id,filePrefix,...}；
  // record-correction: {id,filePrefix,...}）。N 个编号在同一序列锁内连续取号保证连号。
  function reserveArtifactIds(cwd, info = {}, count = 1) {
    const n = Math.max(1, Math.floor(Number(count) || 1));
    const operation = String(info.operation || operationFromAgentPrompt(info.prompt)).toLowerCase();
    const artDir = info.artifactDir || ctx.getArtifactDir(cwd);
    const owner = lockOwnerInfo(info);
    if (!owner.ownerKey) return { reserved: false, reason: 'missing-owner', operation, reservations: [] };

    if (operation === 'create-chg') {
      const kind = inferChangeKindFromPrompt(info.prompt);
      const dateCompact = ctx.todayISO().replace(/-/g, '');
      const lower = kind.toLowerCase();
      // R-47（HOTFIX-20260612-01）：文件名自 slug 改造后是 chg-DATE-NN-<slug>.md 形态，
      //   可选 slug 段必须计入 existingMax，否则 counter 丢失（fresh clone/换机）时安全网失效重发同 ID。
      const existingMax = scanMaxNumberInDir(path.join(artDir, 'changes'), new RegExp(`^${lower}-${dateCompact}-(\\d{2})(?:-[a-z0-9][a-z0-9-]*)?\\.md$`, 'i'));
      const seq = nextSequenceNumbers(cwd, `${lower}-${dateCompact}`, existingMax, n);
      if (!seq.ok) return { reserved: false, reason: seq.reason, lock: seq.lock, operation, reservations: [] };
      const reservations = seq.numbers.map((num) => {
        const nn = String(num).padStart(2, '0');
        const id = `${kind}-${dateCompact}-${nn}`;
        // CHG/HOTFIX 文件名 slug：用 filePrefix（末尾 `-` 留 slug 占位，对称 correction），
        //   reserve 输出 reserved-file-prefix；artifact-writer 按 title 生成 slug 补全文件名。
        const filePrefix = `changes/${lower}-${dateCompact}-${nn}-`;
        const written = writeArtifactReservation(cwd, owner, { operation, kind, id, filePrefix });
        return { reserved: true, operation, kind, id, filePrefix, path: written.path };
      });
      return { reserved: true, operation, reservations };
    }

    if (operation === 'record-correction') {
      const date = ctx.todayISO();
      const existingMax = scanMaxNumberInDir(path.join(artDir, 'changes', 'corrections'), new RegExp(`^correction-${date}-(\\d{2})-.+\\.md$`, 'i'));
      const seq = nextSequenceNumbers(cwd, `correction-${date}`, existingMax, n);
      if (!seq.ok) return { reserved: false, reason: seq.reason, lock: seq.lock, operation, reservations: [] };
      const reservations = seq.numbers.map((num) => {
        const nn = String(num).padStart(2, '0');
        const id = `CORRECTION-${date}-${nn}`;
        const filePrefix = `changes/corrections/correction-${date}-${nn}-`;
        const written = writeArtifactReservation(cwd, owner, { operation, id, filePrefix });
        return { reserved: true, operation, id, filePrefix, path: written.path };
      });
      return { reserved: true, operation, reservations };
    }

    return { reserved: false, reason: 'operation-no-reservation', operation, reservations: [] };
  }

  function reserveArtifactId(cwd, info = {}) {
    const result = reserveArtifactIds(cwd, info, 1);
    if (!result.reserved) return { reserved: false, reason: result.reason, lock: result.lock, operation: result.operation };
    return result.reservations[0];
  }

  // @see pre-tool-use/agent-lifecycle-guard.js reservationMatchesExplicit 与下方 reservationConsumedByRel —— 三函数防守同一不变量
  //   （编号必来自 hook 预留）：本函数判实际写入的目标文件 rel（宽松校验），reservationConsumedByRel 判该 rel 是否消费预留（严格），reservationMatchesExplicit 判
  //   agent prompt 声明的 explicit 字段。两者 filePrefix 容错须同为 startsWith；改一侧须同步另一侧。
  function reservationMatchesArtifactRel(reservation, artifactRel) {
    if (!reservation || !artifactRel) return { ok: true };
    const rel = String(artifactRel || '').replace(/\\/g, '/');
    if (reservation.filePrefix && /^changes\/(?:chg|hotfix)-\d{8}-\d{2}(?:-[^/]+)?\.md$/i.test(rel)) {
      // rel 两种来源都须匹配本 reservation 的 id 主干（filePrefix 去末尾 `-`）：
      //   ① lookup 用 reserved-id 推的精确 `chg-date-nn.md`（无 slug，batch 块仅有 reserved-id 时走此路）；
      //   ② artifact-writer 实际写入的带 slug 全名 `chg-date-nn-<slug>.md`（startsWith filePrefix）。
      //   只认带 slug 会让精确 lookup rel 落入末尾默认放行，多 reservation 时按遍历顺序误取（BCG-1 回归）。
      const stem = reservation.filePrefix.replace(/-$/, '');
      return (rel === `${stem}.md` || (rel.startsWith(reservation.filePrefix) && rel.endsWith('.md')))
        ? { ok: true }
        : { ok: false, expected: `${reservation.filePrefix}<slug>.md`, actual: rel };
    }
    if (reservation.filePrefix && /^changes\/corrections\/correction-\d{4}-\d{2}-\d{2}-\d{2}-.+\.md$/i.test(rel)) {
      return rel.startsWith(reservation.filePrefix) && rel.endsWith('.md')
        ? { ok: true }
        : { ok: false, expected: `${reservation.filePrefix}<slug>.md`, actual: rel };
    }
    return { ok: true };
  }

  // HOTFIX-20260816-03：「消费」判据与上面的「校验」判据分开。reservationMatchesArtifactRel 对非 CHG/HOTFIX、
  // 非 correction 的 rel（task.md / findings.md / walkthrough / finding 详情…）默认放行——用于派遣门/写盘门 lookup
  // 是对的（写索引不与 reservation 冲突），但 clearArtifactReservationForRel 曾拿它当消费判据，导致 artifact-writer
  // 一次 Write finding 详情就把同 session 全部 reservation（含 batch 连号）清空，随后 create-chg 派遣被拒「无效或已过期」。
  // 消费必须精确命中 reservation 自身的目标文件模式：CHG/HOTFIX 预留只被 changes/(chg|hotfix)-<id>[-slug].md 消费，
  // CORRECTION 预留只被 changes/corrections/correction-<id>-*.md 消费，其余路径一律不消费。
  function reservationConsumedByRel(reservation, artifactRel) {
    if (!reservation || !reservation.filePrefix || !artifactRel) return false;
    const rel = String(artifactRel || '').replace(/\\/g, '/');
    const prefix = String(reservation.filePrefix).replace(/\\/g, '/');
    if (/^changes\/(?:chg|hotfix)-\d{8}-\d{2}(?:-[^/]+)?\.md$/i.test(rel)) {
      if (!/^changes\/(?:chg|hotfix)-\d{8}-\d{2}-$/i.test(prefix)) return false;
      const stem = prefix.replace(/-$/, '');
      return rel === `${stem}.md` || (rel.startsWith(prefix) && rel.endsWith('.md'));
    }
    if (/^changes\/corrections\/correction-\d{4}-\d{2}-\d{2}-\d{2}-.+\.md$/i.test(rel)) {
      if (!/^changes\/corrections\/correction-\d{4}-\d{2}-\d{2}-\d{2}-$/i.test(prefix)) return false;
      return rel.startsWith(prefix) && rel.endsWith('.md');
    }
    return false;
  }

  function isArtifactRuntimeControlPath(cwd, targetPath) {
    const fp = ctx.normalizePath(path.resolve(String(targetPath || '')));
    const runtime = ctx.normalizePath(ctx.getProjectRuntimeDir(cwd));
    const runtimeSlash = runtime.endsWith('/') ? runtime : `${runtime}/`;
    const rel = fp.startsWith(runtimeSlash) ? fp.slice(runtimeSlash.length) : '';
    if (!rel) return false;
    // This guard covers high-impact runtime controls. Plan bridge state, v5
    // migration state, and Stop loop flags are owned by their dedicated
    // helpers/hooks; accidental writes there are lower impact.
    return rel === ARTIFACT_WRITER_LOCK_FILE ||
      rel === ctx.PROJECT_ROOT_FILE ||
      rel === 'locks' || /^locks\//.test(rel) ||
      rel === 'sequences' || /^sequences\//.test(rel) ||
      rel === 'reservations' || /^reservations\//.test(rel) ||
      rel === 'index-transactions' || /^index-transactions\//.test(rel) ||
      rel === 'change-owners' || /^change-owners\//.test(rel);
  }

  return {
    getArtifactWriterLockPath,
    readArtifactWriterLock,
    artifactWriterLockMatches,
    operationFromAgentPrompt,
    changeIdFromAgentPrompt,
    explicitChangeTargetFromAgentPrompt,
    artifactResourceForRel,
    getArtifactResourceLockPath,
    readArtifactResourceLock,
    acquireArtifactResourceLock,
    releaseArtifactResourceLock,
    releaseArtifactResourcesForOwner,
    sweepStaleRuntimeOwners,
    markIndexChangesTouchedAndMaybeRelease,
    formatArtifactResourceLock,
    reserveArtifactId,
    reserveArtifactIds,
    readArtifactReservation,
    findArtifactReservationForRel,
    clearArtifactReservation,
    clearArtifactReservationForRel,
    reservationMatchesArtifactRel,
    reservationConsumedByRel,
    isArtifactRuntimeControlPath,
    getChangeOwnerPath,
    readChangeOwner,
    writeChangeOwner,
    markChangeOwnerClosed,
    touchChangeOwnersForSession,
    detachChangeOwnersForSession,
    reviveDetachedChangeOwnersForSession,
    sessionPausePath,
    writeSessionPause,
    clearSessionPause,
    isSessionPaused,
    changeOwnerStatus,
    ownerTakeoverConfirmed,
    acquireJsonLock,
  };
};

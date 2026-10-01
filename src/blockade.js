'use strict';

/**
 * 临时封锁（管理员按区段编号 + 封锁原因发起）。
 *
 * 语义（与需求一一对应）：
 *  - 申请：未知区段、空白原因一律拒绝；同一区段已有未结束（待生效/已生效）封锁时
 *    返回原申请（created:false），不产生第二笔。
 *  - 申请提交后立即阻止该区段参与新的进路预检、直接开放和等待兑现；等待申请保留
 *    顺位，阻断原因中显示封锁原因（checkOpen / openRouteInTxn 中读取本表）。
 *  - 已开放进路保持原锁闭、走行与延时取消规则，不因封锁申请强制解除：申请只登记
 *    封锁，不触碰 route_locks / route_instances / sections.occ_state。
 *  - 区段空闲且无进路锁时，待生效申请立即/随后自动转为已生效；占用、未知或仍
 *    锁闭时维持待生效。复核发生在：申请提交后、走行出清、独立区段状态变化、
 *    延时取消到期、管理员结束封锁及服务重启后（见 triggerSweep）。
 *  - 管理员可结束待生效或已生效封锁；结束后按现有联锁规则重试等待兑现，不改变
 *    区段占用状态。
 *  - 管理员重置推演时清除封锁记录。
 *
 * 状态转换（pending -> effective）与资源检查在同一 SQLite 事务内完成：复核时
 * 再次读取区段占用状态与 route_locks，条件满足才置为 effective，保证转换结果与
 * 随后等待兑现扫描看到的资源状态一致。
 */

const { getDb } = require('./db');
const { InterlockError } = require('./interlocking');

const REASON_MAX = 200;

/* ------------------------------ 基础查询 ------------------------------ */

function activeBlockadeRow(sectionId) {
  return getDb().prepare(
    `SELECT * FROM section_blockades
      WHERE section_id=? AND status IN ('pending','effective')`
  ).get(sectionId);
}

/**
 * 当前未结束（待生效/已生效）封锁。可在 better-sqlite3 事务内调用：同连接同步
 * 事务下能读到本事务尚未提交的写入（等待兑现扫描据此撞到封锁）。
 */
function activeBlockadeInTxn(sectionId) {
  return activeBlockadeRow(sectionId);
}

/* ------------------------------ 待生效原因 ------------------------------ */

/**
 * 资源检查：区段为何还不能转为已生效。
 * @returns {Array<string>} 阻断原因列表；空数组表示"空闲且无进路锁"，可转已生效
 */
function pendingReasonsInTxn(sectionId) {
  const db = getDb();
  const reasons = [];
  const sec = db.prepare(`SELECT occ_state FROM sections WHERE id=?`).get(sectionId);
  if (!sec) {
    // 区段已被删除（理论上外键级联会清掉记录，防御性兜底）
    reasons.push(`区段 ${sectionId} 已不存在`);
    return reasons;
  }
  if (sec.occ_state === 'occupied') reasons.push(`区段 ${sectionId} 当前被占用`);
  if (sec.occ_state === 'unknown') reasons.push(`区段 ${sectionId} 占用状态未知（按占用处理）`);
  const holder = db.prepare(
    `SELECT i.id, i.route_id FROM route_locks l
       JOIN route_instances i ON i.id=l.instance_id
      WHERE l.resource_type='section' AND l.resource_id=? AND i.status='open'`
  ).get(sectionId);
  if (holder) {
    reasons.push(`区段 ${sectionId} 仍被已开放进路 #${holder.id}（${holder.route_id}）锁闭，` +
      '待其走行出清/解除后自动生效；既有进路不强制解除');
  }
  return reasons;
}

/* -------------------------------- 申请 -------------------------------- */

/**
 * 发起临时封锁。
 * @returns {{blockade:Object, created:boolean}} created=false 表示命中同区段原申请
 */
function requestBlockade(sectionId, reason, applicant) {
  const db = getDb();
  const sid = String(sectionId == null ? '' : sectionId).trim();
  const why = String(reason == null ? '' : reason).trim();
  if (!sid) {
    throw new InterlockError(400, 'BAD_SECTION_ID', '封锁申请必须提供区段编号');
  }
  if (!why) {
    throw new InterlockError(400, 'BLOCKADE_REASON_REQUIRED', '封锁原因不能为空，请填写封锁原因');
  }
  if (why.length > REASON_MAX) {
    throw new InterlockError(400, 'BLOCKADE_REASON_TOO_LONG',
      `封锁原因需在 ${REASON_MAX} 字以内（收到 ${why.length} 字）`);
  }

  const run = db.transaction(() => {
    const sec = db.prepare(`SELECT id FROM sections WHERE id=?`).get(sid);
    if (!sec) {
      throw new InterlockError(404, 'SECTION_NOT_FOUND', `区段 ${sid} 不存在，不能发起封锁`);
    }

    // 同一区段未结束的重复申请：返回原申请
    const existing = activeBlockadeRow(sid);
    if (existing) return { row: existing, created: false };

    const info = db.prepare(
      `INSERT INTO section_blockades(section_id, reason, applicant, status)
       VALUES(?, ?, ?, 'pending')`
    ).run(sid, why, applicant || '管理员');
    let row = db.prepare(`SELECT * FROM section_blockades WHERE id=?`).get(info.lastInsertRowid);

    // 申请提交即与资源检查一致地复核一次：空闲且无进路锁 → 立即已生效
    const reasons = pendingReasonsInTxn(sid);
    if (reasons.length === 0) {
      db.prepare(
        `UPDATE section_blockades SET status='effective', pending_reason=NULL,
                effective_at=datetime('now') WHERE id=?`
      ).run(row.id);
    } else {
      db.prepare(`UPDATE section_blockades SET pending_reason=? WHERE id=?`)
        .run(reasons.join('；'), row.id);
    }
    row = db.prepare(`SELECT * FROM section_blockades WHERE id=?`).get(row.id);
    return { row, created: true };
  });

  const { row, created } = run();
  // 新登记的封锁本身不释放任何资源：仅重试等待兑现（让等待申请刷新封锁阻断原因）
  triggerSweep('blockade_requested');
  return { blockade: rowToBlockade(row), created };
}

/* -------------------------------- 结束 -------------------------------- */

/**
 * 管理员结束封锁（待生效或已生效均可）。结束不改变区段占用状态；结束后按现有
 * 联锁规则重试等待兑现。
 */
function endBlockade(blockadeId, operator, note) {
  const db = getDb();
  const id = Number(blockadeId);
  if (!Number.isInteger(id)) {
    throw new InterlockError(400, 'BAD_BLOCKADE_ID', `封锁申请编号必须是整数（收到 ${blockadeId}）`);
  }
  const { row, ended } = db.transaction(() => {
    const cur = db.prepare(`SELECT * FROM section_blockades WHERE id=?`).get(id);
    if (!cur) {
      throw new InterlockError(404, 'BLOCKADE_NOT_FOUND', `封锁申请 ${id} 不存在`);
    }
    if (cur.status === 'ended') {
      return { row: cur, ended: false };
    }
    const reasonText = String(note || '').trim()
      ? `管理员结束封锁：${String(note).trim()}`
      : '管理员结束封锁';
    db.prepare(
      `UPDATE section_blockades SET status='ended', ended_at=datetime('now'), end_reason=? WHERE id=?`
    ).run(reasonText, id);
    return {
      row: db.prepare(`SELECT * FROM section_blockades WHERE id=?`).get(id),
      ended: true
    };
  })();

  if (ended) {
    // 封锁解除后等待申请可能具备兑现条件；不改写区段占用状态，只按既有规则重试
    triggerSweep('blockade_ended');
  }
  return { blockade: rowToBlockade(row), ended };
}

/* ------------------------------ 待生效复核 ------------------------------ */

/**
 * 复核全部待生效封锁：在单个事务内对每笔申请重新做资源检查，区段空闲且无进路锁
 * 时转为已生效。已生效封锁不回退（之后再次占用不影响封锁状态）。
 * @returns {{effective:Array<number>}} 本轮转为已生效的封锁编号
 */
function sweepPending(reason) {
  const db = getDb();
  const effective = [];
  const run = db.transaction(() => {
    const rows = db.prepare(
      `SELECT * FROM section_blockades WHERE status='pending' ORDER BY id`
    ).all();
    for (const row of rows) {
      const reasons = pendingReasonsInTxn(row.section_id);
      if (reasons.length === 0) {
        db.prepare(
          `UPDATE section_blockades SET status='effective', pending_reason=NULL,
                  effective_at=datetime('now') WHERE id=?`
        ).run(row.id);
        effective.push(row.id);
      } else {
        const joined = reasons.join('；');
        if (joined !== row.pending_reason) {
          db.prepare(`UPDATE section_blockades SET pending_reason=? WHERE id=?`)
            .run(joined, row.id);
        }
      }
    }
  });
  run();
  if (effective.length) {
    console.log(`[blockade] 待生效封锁复核（${reason || 'trigger'}）转为已生效：#${effective.join('、#')}`);
  }
  return { effective };
}

/**
 * 状态可能变化后的统一触发：先复核待生效封锁（与资源检查一致地转换状态），
 * 再按既有联锁规则重试等待兑现。任何一步异常都不影响调用方主操作（主操作此时
 * 已提交）。
 */
function triggerSweep(reason) {
  try {
    sweepPending(reason);
  } catch (e) {
    console.error('[blockade] 待生效复核失败:', e);
  }
  try {
    require('./waiting').sweepFulfillments(reason ? `after_${reason}` : 'after_blockade');
  } catch (e) {
    console.error('[blockade] 结束/复核后等待兑现扫描失败:', e);
  }
}

/* --------------------------- 管理员重置：清除记录 --------------------------- */

/** 管理员重置推演：清除全部封锁记录（含未结束与已结束）。应在重置事务内调用。 */
function clearAllByReset(reasonText) {
  getDb().prepare(
    `UPDATE section_blockades SET status='ended', ended_at=datetime('now'),
            end_reason=COALESCE(end_reason, ?) WHERE status IN ('pending','effective')`
  ).run(reasonText || '管理员重置推演，封锁记录清除');
  // 与延时取消一致，重置后不保留封锁历史记录
  getDb().prepare(`DELETE FROM section_blockades`).run();
  return true;
}

/* ------------------------------ 查询 / 快照 ------------------------------ */

function rowToBlockade(row) {
  if (!row) return null;
  const active = row.status === 'pending' || row.status === 'effective';
  return {
    id: row.id,
    sectionId: row.section_id,
    reason: row.reason,
    applicant: row.applicant,
    status: row.status,                  // pending / effective / ended
    pendingReason: row.pending_reason,  // 待生效期间最近一次未生效原因
    createdAt: row.created_at,
    effectiveAt: row.effective_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    // 供展示：当前是否仍占用/锁闭（与状态转换所依据的资源检查同源）；
    // canActivate 仅对待生效有意义（空闲且无锁的待生效申请将在下一次复核时生效）
    resourceCheck: active
      ? (() => {
          const blockers = pendingReasonsInTxn(row.section_id);
          return { blockers, canActivate: blockers.length === 0 };
        })()
      : null
  };
}

function getBlockade(id) {
  return rowToBlockade(getDb().prepare(`SELECT * FROM section_blockades WHERE id=?`).get(id));
}

/**
 * 封锁列表：未结束（待生效在前、已生效在后）在前，已结束按编号倒序在后。
 */
function listBlockades(filter = {}) {
  const db = getDb();
  let rows;
  if (filter.sectionId) {
    rows = db.prepare(
      `SELECT * FROM section_blockades WHERE section_id=?
        ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'effective' THEN 1 ELSE 2 END,
                 CASE status WHEN 'ended' THEN -id ELSE id END`
    ).all(filter.sectionId);
  } else {
    rows = db.prepare(
      `SELECT * FROM section_blockades
        ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'effective' THEN 1 ELSE 2 END,
                 CASE status WHEN 'ended' THEN -id ELSE id END`
    ).all();
  }
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.map(rowToBlockade);
}

/** 全部未结束封锁按区段索引（供 /api/state 快照下发，两页面显示封锁状态） */
function activeBySection() {
  const rows = getDb().prepare(
    `SELECT * FROM section_blockades WHERE status IN ('pending','effective') ORDER BY id`
  ).all();
  const map = {};
  for (const r of rows) map[r.section_id] = rowToBlockade(r);
  return map;
}

module.exports = {
  REASON_MAX,
  activeBlockadeInTxn,
  requestBlockade,
  endBlockade,
  sweepPending,
  triggerSweep,
  clearAllByReset,
  getBlockade,
  listBlockades,
  activeBySection
};

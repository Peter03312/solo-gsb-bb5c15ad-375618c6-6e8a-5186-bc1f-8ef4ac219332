'use strict';

/**
 * 临时封锁 HTTP 集成测试：
 *   临时库启动真实服务 → 管理员按区段+原因发起封锁 →
 *   验证申请编号/待生效·已生效状态、未知区段与空白原因拒绝、重复申请返回原申请、
 *   封锁立即阻止预检/直接开放/等待兑现（等待保留顺位并显示封锁原因）、
 *   已开放进路不被强制解除（锁闭/走行/延时取消规则不变）、待生效在走行出清/
 *   独立区段状态变化/延时取消到期/服务重启后继续复核、结束封锁重试等待兑现且
 *   不改写占用状态、管理员/值班员状态下发、管理员重置清除封锁记录。
 *
 * 运行：node test/blockade-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3919;
const DB_PATH = process.env.SMOKE_DB_BLOCKADE || path.join(__dirname, '..', 'data', 'blockade-test.db');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
      }
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code !== 0) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}

async function api(pathName, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + pathName, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}

async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const { status, data } = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (status !== 200) throw new Error('登录失败: ' + data.error);
  return data.token;
}

async function getState(token) {
  return (await api('/api/state', { token })).data.state;
}

async function openR1(token) {
  const r = await api('/api/routes/R1/open', {
    token, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  if (r.status !== 200) throw new Error('开放 R1 失败: ' + JSON.stringify(r.data));
  return r.data.instance.id;
}

async function walkClear(token, instanceId, sections) {
  let seq = 1;
  for (let i = 0; i < sections.length; i++) {
    await api(`/api/instances/${instanceId}/events`,
      { token, method: 'POST', body: { seq: seq++, sectionId: sections[i], action: 'occupy' } });
    if (i >= 1) {
      await api(`/api/instances/${instanceId}/events`,
        { token, method: 'POST', body: { seq: seq++, sectionId: sections[i - 1], action: 'clear' } });
    }
  }
  await api(`/api/instances/${instanceId}/events`,
    { token, method: 'POST', body: { seq: seq++, sectionId: sections[sections.length - 1], action: 'clear' } });
}

async function findBlockade(token, id) {
  const r = await api('/api/admin/blockades', { token });
  return r.data.blockades.find((x) => x.id === id);
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  console.log('\n[1] 鉴权与前置校验：未知区段、空白原因拒绝；值班员无权');
  let r = await api('/api/admin/sections/999/blockade', {
    token: admin, method: 'POST', body: { reason: '施工' }
  });
  eq('未知区段 404', r.status, 404);
  eq('错误码 SECTION_NOT_FOUND', r.data.code, 'SECTION_NOT_FOUND');
  for (const bad of ['', '   ', null]) {
    r = await api('/api/admin/sections/1/blockade', {
      token: admin, method: 'POST', body: { reason: bad }
    });
    eq(`空白原因拒绝（${JSON.stringify(bad)}）400`, r.status, 400);
    eq('错误码 BLOCKADE_REASON_REQUIRED', r.data.code, 'BLOCKADE_REASON_REQUIRED');
  }
  r = await api('/api/admin/sections/1/blockade', { method: 'POST', body: { reason: 'x' } });
  eq('未登录 401', r.status, 401);
  r = await api('/api/admin/sections/1/blockade', {
    token: jia, method: 'POST', body: { reason: 'x' }
  });
  eq('值班员 403', r.status, 403);

  console.log('\n[2] 空闲无锁区段：立即已生效，返回申请编号与原因');
  r = await api('/api/admin/sections/5/blockade', {
    token: admin, method: 'POST', body: { reason: '线路检修，禁止排路' }
  });
  eq('返回 201', r.status, 201);
  eq('created=true', r.data.created, true);
  const b1 = r.data.blockade;
  ok('申请编号为正整数', Number.isInteger(b1.id) && b1.id > 0, b1);
  eq('区段 5', b1.sectionId, '5');
  eq('原因回显', b1.reason, '线路检修，禁止排路');
  eq('状态已生效', b1.status, 'effective');
  ok('生效时刻已记录', !!b1.effectiveAt, b1);
  let st = await getState(jia);
  eq('state.activeBlockades 含区段5', st.activeBlockades['5'].id, b1.id);
  eq('state.blockades 含记录', st.blockades.some((x) => x.id === b1.id), true);

  console.log('\n[3] 已生效封锁立即阻止预检、直接开放与等待兑现');
  r = await api('/api/routes/R1/check', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('预检不通过', r.data.check.ok, false);
  ok('预检原因含封锁与封锁原因',
    r.data.check.reasons.some((x) => x.includes('临时封锁') && x.includes('线路检修')),
    r.data.check.reasons);
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('直接开放 409', r.status, 409);
  eq('错误码 SECTION_BLOCKED', r.data.code, 'SECTION_BLOCKED');
  eq('错误携带封锁编号', r.data.blockadeId, b1.id);
  eq('错误携带封锁原因', r.data.blockadeReason, '线路检修，禁止排路');
  r = await api('/api/routes/R1/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('等待申请可提交 201', r.status, 201);
  const w1 = r.data.waiting;
  eq('等待未兑现', w1.status, 'waiting');
  ok('等待阻断原因显示封锁原因',
    w1.blockReasons.some((x) => x.includes('临时封锁') && x.includes('线路检修')),
    w1.blockReasons);
  // 不经过封锁区段的进路不受影响
  r = await api('/api/sections/2/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('准备：区段2核实清空', r.status, 200);

  console.log('\n[4] 同一区段未结束的重复申请返回原申请');
  r = await api('/api/admin/sections/5/blockade', {
    token: admin, method: 'POST', body: { reason: '另一个原因' }
  });
  eq('重复申请 200', r.status, 200);
  eq('created=false', r.data.created, false);
  eq('返回原申请编号', r.data.blockade.id, b1.id);
  eq('原因未被改写', r.data.blockade.reason, '线路检修，禁止排路');

  console.log('\n[5] 结束已生效封锁：按既有联锁规则重试等待兑现；不改写占用状态');
  r = await api('/api/admin/sections/5/state', { token: admin, method: 'POST', body: { action: 'occupy' } });
  // 管理员无值班员接口权限，改用值班员把区段5置占用后再结束封锁
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('独立置区段5占用成功', r.status, 200);
  r = await api(`/api/admin/blockades/${b1.id}/end`, { token: admin, method: 'POST', body: {} });
  eq('结束返回 200', r.status, 200);
  eq('ended=true', r.data.ended, true);
  eq('状态 ended', r.data.blockade.status, 'ended');
  st = await getState(jia);
  eq('结束后区段仍占用（不改写占用状态）',
    st.sections.find((x) => x.id === '5').occ_state, 'occupied');
  const w1row = (await api('/api/waiting', { token: yi })).data.waiting.find((x) => x.id === w1.id);
  eq('占用未解除时等待仍不兑现', w1row.status, 'waiting');
  r = await api(`/api/admin/blockades/${b1.id}/end`, { token: admin, method: 'POST', body: {} });
  eq('重复结束 ended=false（幂等）', r.data.ended, false);
  r = await api('/api/admin/blockades/9999/end', { token: admin, method: 'POST', body: {} });
  eq('结束不存在申请 404', r.status, 404);
  eq('错误码 BLOCKADE_NOT_FOUND', r.data.code, 'BLOCKADE_NOT_FOUND');
  // 区段恢复空闲 → 下一次状态变化触发兑现扫描，等待申请兑现
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('区段5核实清空', r.status, 200);
  const wDeadline = Date.now() + 3000;
  let w1after;
  for (;;) {
    w1after = (await api('/api/waiting', { token: yi })).data.waiting.find((x) => x.id === w1.id);
    if (w1after.status === 'fulfilled' || Date.now() > wDeadline) break;
    await sleep(120);
  }
  eq('条件恢复后等待申请按原顺位兑现', w1after.status, 'fulfilled');
  st = await getState(jia);
  const wInst = st.openInstances.find((x) => x.id === w1after.instanceId);
  eq('兑现实例开放', !!wInst && wInst.status, 'open');
  await walkClear(yi, w1after.instanceId, ['1', '3', '5']);

  console.log('\n[6] 待生效：区段被进路锁闭时维持待生效，走行出清后自动转已生效');
  const iid1 = await openR1(jia);
  r = await api('/api/admin/sections/1/blockade', {
    token: admin, method: 'POST', body: { reason: '封锁首段用于验证待生效' }
  });
  eq('锁闭中区段申请返回 201', r.status, 201);
  const b2 = r.data.blockade;
  eq('b2 待生效', b2.status, 'pending');
  ok('待生效原因指出进路锁闭', b2.pendingReason.includes('锁闭'), b2.pendingReason);
  st = await getState(jia);
  eq('state 中 b2 为 pending', st.activeBlockades['1'].status, 'pending');
  // 已开放进路不被强制解除：仍开放、锁闭与信号不变（开放时为绿灯）
  const instStill = st.openInstances.find((x) => x.id === iid1);
  ok('既有进路仍开放且锁闭保留',
    !!instStill && instStill.lockedSections.length === 3 && instStill.lockedSwitches.length === 2);
  // 待生效封锁同样阻止等待兑现，并在阻断原因中显示封锁原因
  r = await api('/api/routes/R1/waiting', {
    token: yi, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  const w2 = r.data.waiting;
  eq('封锁期间新等待申请仍 waiting', w2.status, 'waiting');
  ok('等待阻断立即显示封锁原因（待生效同样阻止等待兑现）',
    w2.blockReasons.join('；').includes('临时封锁') &&
    w2.blockReasons.join('；').includes('验证待生效'),
    w2.blockReasons);
  // 走行出清：走完全程，末段清空后 b2 应转为已生效（区段1先解锁，末段5清空触发扫描）
  await walkClear(jia, iid1, ['1', '3', '5']);
  const b2row = await findBlockade(admin, b2.id);
  eq('走行出清后 b2 转已生效', b2row.status, 'effective');
  ok('生效时刻已记录', !!b2row.effectiveAt);
  // 转已生效后等待仍不能兑现（区段1被封锁），且阻断原因显示封锁原因
  const w2after = (await api('/api/waiting', { token: yi })).data.waiting.find((x) => x.id === w2.id);
  eq('封锁已生效后等待仍 waiting', w2after.status, 'waiting');
  ok('等待阻断显示封锁原因',
    w2after.blockReasons.some((x) => x.includes('封锁#') && x.includes('验证待生效')),
    w2after.blockReasons);
  // 结束封锁后等待兑现
  await api(`/api/admin/blockades/${b2.id}/end`, { token: admin, method: 'POST', body: {} });
  let w2done;
  const d2 = Date.now() + 3000;
  for (;;) {
    w2done = (await api('/api/waiting', { token: yi })).data.waiting.find((x) => x.id === w2.id);
    if (w2done.status === 'fulfilled' || Date.now() > d2) break;
    await sleep(120);
  }
  eq('结束封锁后等待兑现', w2done.status, 'fulfilled');
  await walkClear(yi, w2done.instanceId, ['1', '3', '5']);

  console.log('\n[7] 独立区段状态变化触发复核：占用/未知维持待生效，清空转已生效');
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('区段5置占用', r.status, 200);
  r = await api('/api/admin/sections/5/blockade', {
    token: admin, method: 'POST', body: { reason: '占用中申请封锁' }
  });
  const b3 = r.data.blockade;
  eq('占用时待生效', b3.status, 'pending');
  ok('待生效原因含占用', b3.pendingReason.includes('占用'), b3.pendingReason);
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('独立清空成功', r.status, 200);
  eq('清空后自动转已生效', (await findBlockade(admin, b3.id)).status, 'effective');
  // 已生效后再被独立占用，封锁不回退
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  eq('已生效封锁不影响独立置占用（仅阻止新排路）', r.status, 200);
  eq('已生效封锁不回退为待生效', (await findBlockade(admin, b3.id)).status, 'effective');
  r = await api(`/api/admin/blockades/${b3.id}/end`, { token: admin, method: 'POST', body: {} });
  eq('结束 b3', r.data.blockade.status, 'ended');
  r = await api('/api/sections/5/state', { token: jia, method: 'POST', body: { action: 'clear' } });
  eq('恢复区段5空闲', r.status, 200);

  console.log('\n[8] 延时取消到期后继续复核待生效封锁');
  await api('/api/admin/settings/cancel-protection', {
    token: admin, method: 'PUT', body: { protectionSeconds: 1 }
  });
  const iid2 = await openR1(jia);
  r = await api('/api/admin/sections/3/blockade', {
    token: admin, method: 'POST', body: { reason: '随延时取消解除复核' }
  });
  const b4 = r.data.blockade;
  eq('b4 待生效（锁闭中）', b4.status, 'pending');
  r = await api(`/api/instances/${iid2}/cancel-delayed`, { token: jia, method: 'POST' });
  eq('延时取消申请成功（既有规则不受封锁影响）', r.status === 201 || r.status === 200, true);
  // 等待到期解除（约 1 秒 + 0.5 秒扫描）
  const d4 = Date.now() + 6000;
  let b4row;
  for (;;) {
    b4row = await findBlockade(admin, b4.id);
    st = await getState(jia);
    if (!st.openInstances.some((x) => x.id === iid2) || Date.now() > d4) break;
    await sleep(150);
  }
  eq('延时取消到期进路解除', st.openInstances.some((x) => x.id === iid2), false);
  eq('进路解除后 b4 转已生效', b4row.status, 'effective');
  // 已生效封锁下进路无法重新开放
  r = await api('/api/routes/R1/open', {
    token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
  });
  eq('封锁区段3阻止重新开放', r.status, 409);
  eq('错误码 SECTION_BLOCKED', r.data.code, 'SECTION_BLOCKED');
  await api(`/api/admin/blockades/${b4.id}/end`, { token: admin, method: 'POST', body: {} });

  console.log('\n[9] 待生效封锁持久化：服务重启后继续复核');
  const iid3 = await openR1(jia);
  r = await api('/api/admin/sections/5/blockade', {
    token: admin, method: 'POST', body: { reason: '重启复核验证' }
  });
  const b5 = r.data.blockade;
  eq('b5 待生效', b5.status, 'pending');
  await stopServer();
  await startServer(true);
  let b5row = await findBlockade(admin, b5.id);
  eq('重启后锁仍在：b5 仍待生效', b5row.status, 'pending');
  ok('重启后待生效原因仍在', !!b5row.pendingReason, b5row);
  // 走行出清后（不重启）转已生效，再重启状态保持
  await walkClear(jia, iid3, ['1', '3', '5']);
  b5row = await findBlockade(admin, b5.id);
  eq('出清后 b5 已生效', b5row.status, 'effective');
  await stopServer();
  await startServer(true);
  b5row = await findBlockade(admin, b5.id);
  eq('重启后 b5 仍已生效', b5row.status, 'effective');
  eq('重启后封锁仍阻止开放',
    (await api('/api/routes/R1/open', {
      token: jia, method: 'POST', body: { switchPositions: { SW7: 'N', SW8: 'N' } }
    })).status, 409);
  await api(`/api/admin/blockades/${b5.id}/end`, { token: admin, method: 'POST', body: {} });

  console.log('\n[10] 管理员重置推演：清除封锁记录');
  r = await api('/api/admin/sections/2/blockade', {
    token: admin, method: 'POST', body: { reason: '重置前遗留封锁' }
  });
  const b6 = r.data.blockade;
  eq('b6 已生效', b6.status, 'effective');
  r = await api('/api/admin/reset/training', { token: admin, method: 'POST' });
  eq('重置成功', r.status, 200);
  eq('重置后无未结束封锁', Object.keys(r.data.state.activeBlockades).length, 0);
  eq('重置后封锁记录清空', r.data.state.blockades.length, 0);
  // 重置后区段可正常排路
  const iid4 = await openR1(jia);
  eq('重置后可正常开放进路', Number.isInteger(iid4), true);
  await walkClear(jia, iid4, ['1', '3', '5']);

  console.log('\n[11] 有未结束封锁时区段删除被拒绝；结束后可删（拓扑编辑前置：无开放进路）');
  r = await api('/api/admin/sections/5/blockade', {
    token: admin, method: 'POST', body: { reason: '阻止删段' }
  });
  const b7 = r.data.blockade.id;
  // 区段5被进路引用，先验证封锁存在时即便无开放进路也拒绝（引用检查先触发，
  // 因此新建一个不被引用的临时区段验证封锁拦截）
  const secId = 'T9';
  r = await api('/api/admin/sections', {
    token: admin, method: 'POST',
    body: { id: secId, label: '临时段', x1: 1, y1: 1, x2: 2, y2: 2 }
  });
  eq('新建临时区段', r.status, 200);
  r = await api(`/api/admin/sections/${secId}/blockade`, {
    token: admin, method: 'POST', body: { reason: '封锁中不可删除' }
  });
  const b8 = r.data.blockade.id;
  r = await api(`/api/admin/sections/${secId}`, { token: admin, method: 'DELETE' });
  eq('有封锁时删除区段 409', r.status, 409);
  await api(`/api/admin/blockades/${b8}/end`, { token: admin, method: 'POST', body: {} });
  r = await api(`/api/admin/sections/${secId}`, { token: admin, method: 'DELETE' });
  eq('结束封锁后删除区段成功', r.status, 200);
  await api(`/api/admin/blockades/${b7}/end`, { token: admin, method: 'POST', body: {} });

  console.log(`\n临时封锁全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});

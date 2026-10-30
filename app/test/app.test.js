'use strict';
// DBなしで動くテストです。DBの代わりに、メモリ上の偽物（fakeRepo）を使います。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, validatePatient, parsePatientNo, todayJst } = require('../app');

function fakeRepo() {
  const st = { up: true, patients: [], visits: [] };
  const depts = [{ code: 'IM', name: '内科' }, { code: 'SU', name: '外科' }];
  const no = (id) => 'P' + String(id).padStart(6, '0');
  const view = (p) => { const { id, ...rest } = p; return { patient_no: no(id), ...rest }; };
  const dup = (v, selfId) => st.patients.some((p) => p.id !== selfId && p.name_kana === v.name_kana && p.birth_date === v.birth_date);
  const coded = (c) => Object.assign(new Error(c), { code: c });
  const visitView = (v) => {
    const p = st.patients.find((x) => x.id === v.patient_id);
    const d = depts.find((x) => x.code === v.department_code);
    return { id: v.id, patient_no: no(p.id), patient_name: p.name, department_code: d.code, department_name: d.name, visited_on: v.visited_on, status: '受付' };
  };
  return {
    st,
    reset() { st.up = true; st.patients = []; st.visits = []; },
    async ready() { if (!st.up) throw new Error('db down'); return true; },
    async listDepartments() { return depts; },
    async createPatient(v) {
      if (dup(v)) throw coded('DUPLICATE');
      const p = { id: st.patients.length + 1, ...v, created_at: '2026-01-01T00:00:00Z' };
      st.patients.push(p);
      return view(p);
    },
    async listPatients({ q, limit }) {
      const hit = st.patients.filter((p) => !q || p.name.includes(q) || p.name_kana.includes(q));
      return { total: hit.length, patients: hit.slice().reverse().slice(0, limit).map(view) };
    },
    async getPatient(id) { const p = st.patients.find((x) => x.id === id); return p ? view(p) : null; },
    async updatePatient(id, v) {
      const p = st.patients.find((x) => x.id === id);
      if (!p) return null;
      if (dup(v, id)) throw coded('DUPLICATE');
      Object.assign(p, v);
      return view(p);
    },
    async createVisit({ patient_id, department_code, visited_on }) {
      if (!st.patients.some((p) => p.id === patient_id)) throw coded('NO_PATIENT');
      if (!depts.some((d) => d.code === department_code)) throw coded('NO_DEPARTMENT');
      const v = { id: st.visits.length + 1, patient_id, department_code, visited_on };
      st.visits.push(v);
      return visitView(v);
    },
    async listVisits({ date }) { return st.visits.filter((v) => v.visited_on === date).map(visitView); },
    async listPatientVisits(id) {
      if (!st.patients.some((p) => p.id === id)) return null;
      return st.visits.filter((v) => v.patient_id === id).map(visitView);
    },
  };
}

const TARO = { name: '山田 太郎', name_kana: 'ヤマダ タロウ', birth_date: '1980-04-01', sex: '男' };
let server, base;
const repo = fakeRepo();

before(async () => {
  server = createServer({ repo, version: 'test-1', indexHtml: '<html>top</html>', hostname: 'pod-test', log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
beforeEach(() => repo.reset());

const call = async (method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSONでない応答 */ }
  return { status: r.status, json, text };
};

// ---- 入力チェック（関数単体） ----
test('入力チェック：正しい入力はエラーなし。カナの空白は除去される', () => {
  const { value, errors } = validatePatient({ ...TARO, name_kana: ' ヤマダ　タロウ ' }, '2026-10-30');
  assert.deepEqual(errors, []);
  assert.equal(value.name_kana, 'ヤマダタロウ');
});
test('入力チェック：未来の生年月日は拒否する', () => {
  const { errors } = validatePatient({ ...TARO, birth_date: '2026-10-31' }, '2026-10-30');
  assert.ok(errors.some((e) => e.includes('未来')));
});
test('入力チェック：存在しない日付・ひらがなカナ・不正な性別を拒否する', () => {
  assert.ok(validatePatient({ ...TARO, birth_date: '2025-02-30' }, '2026-10-30').errors.length > 0);
  assert.ok(validatePatient({ ...TARO, name_kana: 'やまだ' }, '2026-10-30').errors.length > 0);
  assert.ok(validatePatient({ ...TARO, sex: '不明' }, '2026-10-30').errors.length > 0);
});
test('患者番号の解析', () => {
  assert.equal(parsePatientNo('P000012'), 12);
  assert.equal(parsePatientNo('P12'), null);
  assert.equal(parsePatientNo('P000000'), null);
  assert.equal(parsePatientNo(undefined), null);
});

// ---- 画面・監視 ----
test('画面と監視用URL', async () => {
  assert.equal((await call('GET', '/')).text, '<html>top</html>');
  assert.equal((await call('GET', '/healthz')).status, 200);
  assert.equal((await call('GET', '/readyz')).status, 200);
  assert.deepEqual((await call('GET', '/api/info')).json, { version: 'test-1', pod: 'pod-test' });
});
test('DBが落ちている間は /readyz が 503 になる（/healthz は 200 のまま）', async () => {
  repo.st.up = false;
  assert.equal((await call('GET', '/readyz')).status, 503);
  assert.equal((await call('GET', '/healthz')).status, 200);
});
test('存在しないURLは 404', async () => {
  assert.equal((await call('GET', '/nothing')).status, 404);
});

// ---- 診療科 ----
test('GET /api/departments', async () => {
  const r = await call('GET', '/api/departments');
  assert.equal(r.status, 200);
  assert.equal(r.json[0].name, '内科');
});

// ---- 患者 ----
test('POST /api/patients：登録すると 201 と患者番号が返る', async () => {
  const r = await call('POST', '/api/patients', TARO);
  assert.equal(r.status, 201);
  assert.equal(r.json.patient_no, 'P000001');
});
test('POST /api/patients：必須項目が空なら 400 と理由が返る', async () => {
  const r = await call('POST', '/api/patients', { ...TARO, name: '' });
  assert.equal(r.status, 400);
  assert.ok(r.json.details.includes('氏名は必須です'));
});
test('POST /api/patients：壊れたJSONは 400', async () => {
  assert.equal((await call('POST', '/api/patients', '{broken')).status, 400);
});
test('POST /api/patients：同じカナ氏名・生年月日は 409', async () => {
  await call('POST', '/api/patients', TARO);
  assert.equal((await call('POST', '/api/patients', TARO)).status, 409);
});
test('GET /api/patients/:no：取得・形式エラー・未登録', async () => {
  await call('POST', '/api/patients', TARO);
  assert.equal((await call('GET', '/api/patients/P000001')).json.name, '山田 太郎');
  assert.equal((await call('GET', '/api/patients/abc')).status, 400);
  assert.equal((await call('GET', '/api/patients/P000099')).status, 404);
});
test('GET /api/patients?q=：検索と件数', async () => {
  await call('POST', '/api/patients', TARO);
  await call('POST', '/api/patients', { name: '佐藤 花子', name_kana: 'サトウ ハナコ', birth_date: '1992-11-23', sex: '女' });
  const all = await call('GET', '/api/patients');
  assert.equal(all.json.total, 2);
  assert.equal(all.json.patients[0].patient_no, 'P000002'); // 新しい順
  const hit = await call('GET', '/api/patients?q=' + encodeURIComponent('サトウ'));
  assert.equal(hit.json.total, 1);
});
test('PUT /api/patients/:no：更新できる。未登録は 404', async () => {
  await call('POST', '/api/patients', TARO);
  const r = await call('PUT', '/api/patients/P000001', { ...TARO, name: '山田 太朗' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, '山田 太朗');
  assert.equal((await call('PUT', '/api/patients/P000099', TARO)).status, 404);
});

// ---- 受付 ----
test('POST /api/visits：受付できる。一覧と患者別履歴にも出る', async () => {
  await call('POST', '/api/patients', TARO);
  const r = await call('POST', '/api/visits', { patient_no: 'P000001', department_code: 'IM' });
  assert.equal(r.status, 201);
  assert.equal(r.json.department_name, '内科');
  assert.equal(r.json.visited_on, todayJst());
  assert.equal((await call('GET', '/api/visits')).json.length, 1);
  assert.equal((await call('GET', '/api/patients/P000001/visits')).json.length, 1);
});
test('POST /api/visits：未登録の患者は 404、診療科コード違いは 400', async () => {
  await call('POST', '/api/patients', TARO);
  assert.equal((await call('POST', '/api/visits', { patient_no: 'P000099', department_code: 'IM' })).status, 404);
  assert.equal((await call('POST', '/api/visits', { patient_no: 'P000001', department_code: 'XX' })).status, 400);
  assert.equal((await call('POST', '/api/visits', { patient_no: 'P000001' })).status, 400);
});
test('GET /api/visits?date=：日付の形式エラーは 400', async () => {
  assert.equal((await call('GET', '/api/visits?date=2026-13-01')).status, 400);
  assert.equal((await call('GET', '/api/patients/P000099/visits')).status, 404);
});

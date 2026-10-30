'use strict';
// HTTPサーバーと入力チェック。DBには触れず、データの出し入れは repo（db.js）に任せます。
// そのため、DBなしでテストできます（test/app.test.js）。
const http = require('node:http');
const os = require('node:os');

const MAX_BODY = 10 * 1024;
const SEX = ['男', '女', 'その他'];
const QUIET_PATHS = new Set(['/healthz', '/readyz']); // 監視用のURLはログに出さない

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const todayJst = (now = new Date()) => now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 'P000012' -> 12。形式が違えば null
function parsePatientNo(s) {
  const m = /^P(\d{6})$/.exec(s || '');
  return m ? Number(m[1]) || null : null;
}

function validatePatient(input, today = todayJst()) {
  const errors = [];
  const s = (x) => (typeof x === 'string' ? x.trim() : '');
  const value = {
    name: s(input.name),
    name_kana: s(input.name_kana).replace(/\s+/g, ''),
    birth_date: s(input.birth_date),
    sex: s(input.sex),
  };
  if (!value.name) errors.push('氏名は必須です');
  else if (value.name.length > 50) errors.push('氏名は50文字以内で入力してください');

  if (!value.name_kana) errors.push('カナ氏名は必須です');
  else if (!/^[ァ-ヶー]+$/.test(value.name_kana)) errors.push('カナ氏名は全角カタカナで入力してください');
  else if (value.name_kana.length > 50) errors.push('カナ氏名は50文字以内で入力してください');

  if (!isValidDate(value.birth_date)) errors.push('生年月日は YYYY-MM-DD 形式の正しい日付で入力してください');
  else if (value.birth_date > today) errors.push('生年月日に未来の日付は指定できません');
  else if (value.birth_date < '1900-01-01') errors.push('生年月日は1900年以降で入力してください');

  if (!SEX.includes(value.sex)) errors.push('性別は 男・女・その他 のいずれかです');
  return { value, errors };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, '送信データが大きすぎます');
    chunks.push(c);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'JSON オブジェクトを送信してください');
  }
  return data;
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function createServer({ repo, version, indexHtml, hostname = os.hostname(), log = console.log }) {
  const routes = [];
  const add = (method, re, fn) => routes.push({ method, re, fn });
  const patientId = (no) => {
    const id = parsePatientNo(no);
    if (!id) throw new HttpError(400, '患者番号は P と6桁の数字（例：P000001）で指定してください');
    return id;
  };
  const invalid = (errors) => new HttpError(400, '入力内容に誤りがあります', errors);

  // ---- 画面・監視 ----
  add('GET', /^\/$/, ({ res }) => send(res, 200, indexHtml, 'text/html; charset=utf-8'));
  add('GET', /^\/healthz$/, ({ res }) => send(res, 200, 'OK', 'text/plain'));
  add('GET', /^\/readyz$/, async ({ res }) => {
    const ok = await Promise.resolve(repo.ready()).catch(() => false);
    send(res, ok ? 200 : 503, ok ? 'READY' : 'NOT READY', 'text/plain');
  });
  add('GET', /^\/api\/info$/, ({ res }) => sendJson(res, 200, { version, pod: hostname }));

  // ---- 診療科マスタ ----
  add('GET', /^\/api\/departments$/, async ({ res }) => sendJson(res, 200, await repo.listDepartments()));

  // ---- 患者 ----
  add('POST', /^\/api\/patients$/, async ({ req, res }) => {
    const { value, errors } = validatePatient(await readJson(req));
    if (errors.length) throw invalid(errors);
    try {
      sendJson(res, 201, await repo.createPatient(value));
    } catch (e) {
      if (e.code === 'DUPLICATE') throw new HttpError(409, '同じカナ氏名・生年月日の患者がすでに登録されています');
      throw e;
    }
  });
  add('GET', /^\/api\/patients$/, async ({ res, url }) => {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 50);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 20, 1), 100);
    sendJson(res, 200, await repo.listPatients({ q, limit }));
  });
  add('GET', /^\/api\/patients\/([^/]+)$/, async ({ res, m }) => {
    const p = await repo.getPatient(patientId(m[1]));
    if (!p) throw new HttpError(404, '患者が見つかりません');
    sendJson(res, 200, p);
  });
  add('PUT', /^\/api\/patients\/([^/]+)$/, async ({ req, res, m }) => {
    const id = patientId(m[1]);
    const { value, errors } = validatePatient(await readJson(req));
    if (errors.length) throw invalid(errors);
    try {
      const p = await repo.updatePatient(id, value);
      if (!p) throw new HttpError(404, '患者が見つかりません');
      sendJson(res, 200, p);
    } catch (e) {
      if (e.code === 'DUPLICATE') throw new HttpError(409, '同じカナ氏名・生年月日の患者がすでに登録されています');
      throw e;
    }
  });
  add('GET', /^\/api\/patients\/([^/]+)\/visits$/, async ({ res, m }) => {
    const rows = await repo.listPatientVisits(patientId(m[1]));
    if (!rows) throw new HttpError(404, '患者が見つかりません');
    sendJson(res, 200, rows);
  });

  // ---- 受付（来院） ----
  add('POST', /^\/api\/visits$/, async ({ req, res }) => {
    const body = await readJson(req);
    const id = patientId(body.patient_no);
    const code = typeof body.department_code === 'string' ? body.department_code.trim() : '';
    if (!code) throw invalid(['診療科コードは必須です']);
    try {
      sendJson(res, 201, await repo.createVisit({ patient_id: id, department_code: code, visited_on: todayJst() }));
    } catch (e) {
      if (e.code === 'NO_PATIENT') throw new HttpError(404, '患者が見つかりません');
      if (e.code === 'NO_DEPARTMENT') throw new HttpError(400, '診療科コードが正しくありません');
      throw e;
    }
  });
  add('GET', /^\/api\/visits$/, async ({ res, url }) => {
    const date = url.searchParams.get('date') || todayJst();
    if (!isValidDate(date)) throw invalid(['date は YYYY-MM-DD 形式で指定してください']);
    sendJson(res, 200, await repo.listVisits({ date }));
  });

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    res.on('finish', () => {
      if (QUIET_PATHS.has(url.pathname)) return;
      log(JSON.stringify({ method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started }));
    });
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) return await r.fn({ req, res, url, m });
      }
      sendJson(res, 404, { error: '見つかりません' });
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, details: e.details });
      console.error('unexpected error:', e);
      sendJson(res, 503, { error: '一時的に処理できません。しばらくしてからやり直してください' });
    }
  });
}

module.exports = { createServer, validatePatient, parsePatientNo, isValidDate, todayJst };

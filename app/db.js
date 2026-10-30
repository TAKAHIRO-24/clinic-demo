'use strict';
// PostgreSQL とのやり取り。画面や入力チェックは app.js に任せ、ここは「データの出し入れ」だけを担当します。
const { Pool } = require('pg');

// DBの構造変更は、番号つきで「追加するだけ」にします（いちど適用した番号は変更しない）。
// アプリ起動時に、未適用の番号だけが順に実行されます。
const MIGRATIONS = [
  {
    id: 1,
    sql: `CREATE TABLE patients (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            name_kana  TEXT NOT NULL,
            birth_date DATE NOT NULL,
            sex        TEXT NOT NULL CHECK (sex IN ('男','女','その他')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (name_kana, birth_date)
          )`,
  },
  {
    id: 2,
    sql: `CREATE TABLE departments (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL
          );
          INSERT INTO departments (code, name) VALUES
            ('IM','内科'), ('SU','外科'), ('PE','小児科'), ('OR','整形外科'), ('DE','皮膚科');
          CREATE TABLE visits (
            id              SERIAL PRIMARY KEY,
            patient_id      INT  NOT NULL REFERENCES patients(id),
            department_code TEXT NOT NULL REFERENCES departments(code),
            visited_on      DATE NOT NULL,
            status          TEXT NOT NULL DEFAULT '受付',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
          );
          CREATE INDEX visits_visited_on_idx ON visits (visited_on)`,
  },
];

const PATIENT_COLUMNS = `'P' || lpad(id::text, 6, '0') AS patient_no, name, name_kana,
  to_char(birth_date, 'YYYY-MM-DD') AS birth_date, sex, created_at`;

const VISIT_SELECT = `SELECT v.id, 'P' || lpad(p.id::text, 6, '0') AS patient_no, p.name AS patient_name,
  v.department_code, d.name AS department_name, to_char(v.visited_on, 'YYYY-MM-DD') AS visited_on,
  v.status, v.created_at
  FROM visits v
  JOIN patients p ON p.id = v.patient_id
  JOIN departments d ON d.code = v.department_code`;

const coded = (code) => Object.assign(new Error(code), { code });
const UNIQUE_VIOLATION = '23505';

function createRepo(config) {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    connectionTimeoutMillis: 3000,
  });
  pool.on('error', (e) => console.error('DB接続エラー（自動で再接続します）:', e.message));
  let migrated = false;

  // 複数のPodが同時に起動しても、構造変更が二重に走らないよう、DBのロックで1台ずつ実行します。
  async function migrate() {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727274)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
      );
      const { rows } = await client.query('SELECT id FROM schema_migrations');
      const done = new Set(rows.map((r) => r.id));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
          await client.query('COMMIT');
          console.log(`マイグレーション ${m.id} を適用しました`);
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
      migrated = true;
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
      client.release();
    }
  }

  async function ready() {
    if (!migrated) return false;
    await pool.query('SELECT 1');
    return true;
  }

  async function listDepartments() {
    const { rows } = await pool.query('SELECT code, name FROM departments ORDER BY code');
    return rows;
  }

  async function createPatient(p) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO patients (name, name_kana, birth_date, sex) VALUES ($1, $2, $3, $4)
         RETURNING ${PATIENT_COLUMNS}`,
        [p.name, p.name_kana, p.birth_date, p.sex]
      );
      return rows[0];
    } catch (e) {
      if (e.code === UNIQUE_VIOLATION) throw coded('DUPLICATE');
      throw e;
    }
  }

  async function listPatients({ q, limit }) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const where = q ? 'WHERE name ILIKE $1 OR name_kana ILIKE $1' : '';
    const params = q ? [like] : [];
    const total = await pool.query(`SELECT count(*)::int AS n FROM patients ${where}`, params);
    const { rows } = await pool.query(
      `SELECT ${PATIENT_COLUMNS} FROM patients ${where} ORDER BY id DESC LIMIT ${Number(limit)}`,
      params
    );
    return { total: total.rows[0].n, patients: rows };
  }

  async function getPatient(id) {
    const { rows } = await pool.query(`SELECT ${PATIENT_COLUMNS} FROM patients WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async function updatePatient(id, p) {
    try {
      const { rows } = await pool.query(
        `UPDATE patients SET name = $2, name_kana = $3, birth_date = $4, sex = $5 WHERE id = $1
         RETURNING ${PATIENT_COLUMNS}`,
        [id, p.name, p.name_kana, p.birth_date, p.sex]
      );
      return rows[0] || null;
    } catch (e) {
      if (e.code === UNIQUE_VIOLATION) throw coded('DUPLICATE');
      throw e;
    }
  }

  async function createVisit({ patient_id, department_code, visited_on }) {
    if (!(await getPatient(patient_id))) throw coded('NO_PATIENT');
    const dep = await pool.query('SELECT 1 FROM departments WHERE code = $1', [department_code]);
    if (dep.rowCount === 0) throw coded('NO_DEPARTMENT');
    const ins = await pool.query(
      'INSERT INTO visits (patient_id, department_code, visited_on) VALUES ($1, $2, $3) RETURNING id',
      [patient_id, department_code, visited_on]
    );
    const { rows } = await pool.query(`${VISIT_SELECT} WHERE v.id = $1`, [ins.rows[0].id]);
    return rows[0];
  }

  async function listVisits({ date }) {
    const { rows } = await pool.query(`${VISIT_SELECT} WHERE v.visited_on = $1 ORDER BY v.id`, [date]);
    return rows;
  }

  async function listPatientVisits(id) {
    if (!(await getPatient(id))) return null;
    const { rows } = await pool.query(`${VISIT_SELECT} WHERE v.patient_id = $1 ORDER BY v.id DESC`, [id]);
    return rows;
  }

  const close = () => pool.end();

  return {
    migrate, ready, listDepartments, createPatient, listPatients, getPatient,
    updatePatient, createVisit, listVisits, listPatientVisits, close,
  };
}

module.exports = { createRepo, MIGRATIONS };

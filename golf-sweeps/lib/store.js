// Tiny JSON-file database. Fine for a single club; swap for SQLite/Postgres
// if you outgrow it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = { players: [], courses: [], events: [] };

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

export function sampleCourse() {
  const pars = [4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4];
  const sis = [7, 11, 17, 1, 13, 5, 15, 3, 9, 8, 18, 4, 14, 2, 12, 16, 10, 6];
  return {
    id: newId(),
    name: 'Sample Course (edit me)',
    holes: pars.map((par, i) => ({ par, si: sis[i] })),
    tees: [
      { id: newId(), name: 'Blue', rating: 72.4, slope: 131 },
      { id: newId(), name: 'White', rating: 70.6, slope: 126 },
    ],
  };
}

export function createStore(file) {
  let db;
  const load = () => {
    if (db) return db;
    try {
      db = { ...EMPTY, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      db = structuredClone(EMPTY);
      db.courses.push(sampleCourse());
      save();
    }
    return db;
  };
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    get data() { return load(); },
    save,
  };
}

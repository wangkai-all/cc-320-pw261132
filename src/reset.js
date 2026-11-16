'use strict';

const fs = require('fs');
const path = require('path');
const { seed } = require('./seed');

const file = process.env.REBATE_DB || path.join(__dirname, '..', 'data', 'rebate.db');
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const target = `${file}${suffix}`;
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
console.log(`已删除 ${file}，重新导入种子数据。`);
seed();

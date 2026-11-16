'use strict';

const { createApp } = require('./server');

const port = Number(process.env.PORT) || 3000;

async function main() {
  const { server } = createApp({ withSeed: process.env.REBATE_SEED !== '0' });
  server.listen(port, '127.0.0.1', () => {
    console.log(`返利核对演示已启动：http://127.0.0.1:${port}`);
    console.log('全部为虚构数据与金额，不构成税务、法律或会计意见。');
  });
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});

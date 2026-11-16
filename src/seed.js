'use strict';

const { openDatabase, tx } = require('./db');
const { Store } = require('./store');
const { LedgerService } = require('./ledger');
const { JobService } = require('./jobs');

/**
 * 纯虚构演示数据：公司、供应商、金额均为占位，不对应任何真实主体或合同。
 *
 * 初始场景：
 *  - 星海集团「钢材」2026-Q1 由 EAST/SOUTH 两个采购实体共同累计 62,800.00 元，
 *    跨过 50,000.00 元门槛，整段按 2.5% 得 1,570.00 元；
 *  - 星海集团「钢材」2026-Q2 累计 125,000.00 元，跨入 4% 档；
 *  - 云岭集团「电子元件」2026-Q1 由 EAST/WEST 共享 3% 档；
 *  - 北辰集团「包装材料」Q1 0.8% 档、Q2 2% 档。
 *
 * 交互演示（不预置，避免在启动时产生正式台账）：
 *  - 在 Q1 段生成试算并确认，再登记一笔退货，可看到已确认超额、旧试算过期与回补；
 *  - 在「变更追溯」把 NP-ELEC 改到星海集团，可看到原/新集团两侧段同时重算。
 */
function seed(existingDb = null) {
  const db = existingDb || openDatabase(process.env.REBATE_DB);
  const store = new Store(db);
  const ledger = new LedgerService(db, store);
  const jobs = new JobService(db, store);

  const existing = store.listGroups();
  if (existing.length > 0) {
    console.log('数据库已有数据，跳过种子导入。使用 npm run reset 可重建。');
    return { skipped: true };
  }

  if (!store.getMeta('demo_disclaimer')) {
    store.setMeta(
      'demo_disclaimer',
      '本应用全部为虚构演示数据与虚构金额，仅用于产品与技术演示，不构成税务、法律或会计意见。'
    );
  }

  const result = tx(db, () => {
    const star = store.createGroup({ name: '星海实业（虚构）', code: 'XH' }, '种子数据');
    const cloud = store.createGroup({ name: '云岭制造（虚构）', code: 'YL' }, '种子数据');
    const extra = store.createGroup({ name: '北辰贸易（虚构）', code: 'BC' }, '种子数据');

    const entA = store.createEntity({ name: '华东采购中心（虚构）', code: 'EAST' }, '种子数据');
    const entB = store.createEntity({ name: '华南采购中心（虚构）', code: 'SOUTH' }, '种子数据');
    const entC = store.createEntity({ name: '西部采购中心（虚构）', code: 'WEST' }, '种子数据');

    const supplierA = store.createSupplier(
      { name: '恒远钢材（虚构）', code: 'HY-STEEL', group_id: star.id }, '种子数据'
    );
    const supplierB = store.createSupplier(
      { name: '青禾五金（虚构）', code: 'QH-HW', group_id: star.id }, '种子数据'
    );
    const supplierC = store.createSupplier(
      { name: '南屏电子（虚构）', code: 'NP-ELEC', group_id: cloud.id }, '种子数据'
    );
    const supplierD = store.createSupplier(
      { name: '流川包装（虚构）', code: 'LC-PACK', group_id: extra.id }, '种子数据'
    );
    store.createSupplier(
      { name: '备用小额供应商（虚构）', code: 'XH-MISC', group_id: star.id }, '种子数据'
    );

    store.createContract({
      name: '星海集团·钢材年度返利（虚构）',
      group_id: star.id,
      category: '钢材',
      period_type: 'quarter',
      tiers: [
        { threshold_cents: 0, rate_bps: 100, label: '基础档 1%' },
        { threshold_cents: 5_000_000, rate_bps: 250, label: '达标档 2.5%' },
        { threshold_cents: 12_000_000, rate_bps: 400, label: '卓越档 4%' },
      ],
    }, '种子数据');

    store.createContract({
      name: '云岭集团·电子元件返利（虚构）',
      group_id: cloud.id,
      category: '电子元件',
      period_type: 'quarter',
      tiers: [
        { threshold_cents: 0, rate_bps: 150, label: '基础档 1.5%' },
        { threshold_cents: 3_000_000, rate_bps: 300, label: '达标档 3%' },
        { threshold_cents: 8_000_000, rate_bps: 500, label: '卓越档 5%' },
      ],
    }, '种子数据');

    store.createContract({
      name: '北辰集团·包装材料返利（虚构）',
      group_id: extra.id,
      category: '包装材料',
      period_type: 'quarter',
      tiers: [
        { threshold_cents: 0, rate_bps: 80, label: '基础档 0.8%' },
        { threshold_cents: 2_000_000, rate_bps: 200, label: '达标档 2%' },
      ],
    }, '种子数据');

    const events = [
      // 星海集团 2026-Q1 钢材：两实体共享 5,000,000 分（5 万元）门槛，合计跨过
      { event_type: 'purchase', supplier_id: supplierA.id, entity_id: entA.id, category: '钢材', period: '2026-Q1', amount_cents: 3_200_000, occurred_at: '2026-01-18T02:00:00.000Z', note: '虚构：1 月钢材采购' },
      { event_type: 'purchase', supplier_id: supplierA.id, entity_id: entB.id, category: '钢材', period: '2026-Q1', amount_cents: 2_100_000, occurred_at: '2026-02-09T02:00:00.000Z', note: '虚构：2 月钢材采购' },
      { event_type: 'purchase', supplier_id: supplierB.id, entity_id: entA.id, category: '钢材', period: '2026-Q1', amount_cents: 980_000, occurred_at: '2026-03-02T02:00:00.000Z', note: '虚构：五金并入钢材合同' },
      // 2026-Q2：跨入第三档
      { event_type: 'purchase', supplier_id: supplierA.id, entity_id: entA.id, category: '钢材', period: '2026-Q2', amount_cents: 6_400_000, occurred_at: '2026-04-12T02:00:00.000Z', note: '虚构：Q2 大批量采购' },
      { event_type: 'purchase', supplier_id: supplierB.id, entity_id: entB.id, category: '钢材', period: '2026-Q2', amount_cents: 6_100_000, occurred_at: '2026-05-20T02:00:00.000Z', note: '虚构：Q2 第二批' },
      // 云岭集团 2026-Q1 电子元件，三实体跨集团门槛
      { event_type: 'purchase', supplier_id: supplierC.id, entity_id: entA.id, category: '电子元件', period: '2026-Q1', amount_cents: 1_500_000, occurred_at: '2026-01-25T02:00:00.000Z', note: '虚构：元件采购' },
      { event_type: 'purchase', supplier_id: supplierC.id, entity_id: entC.id, category: '电子元件', period: '2026-Q1', amount_cents: 2_400_000, occurred_at: '2026-03-15T02:00:00.000Z', note: '虚构：元件采购' },
      // 北辰 2026-Q1 包装材料
      { event_type: 'purchase', supplier_id: supplierD.id, entity_id: entB.id, category: '包装材料', period: '2026-Q1', amount_cents: 1_200_000, occurred_at: '2026-02-02T02:00:00.000Z', note: '虚构：包装采购' },
      { event_type: 'purchase', supplier_id: supplierD.id, entity_id: entC.id, category: '包装材料', period: '2026-Q2', amount_cents: 2_600_000, occurred_at: '2026-05-06T02:00:00.000Z', note: '虚构：包装采购' },
    ];
    const inserted = events.map((e) => store.insertEvent({
      ...e,
      actor: '种子数据',
      note: e.note || '',
      client_request_id: null,
      reverses_event_id: null,
    }));
    return { supplierA, supplierB, supplierC, supplierD, entA, entB, entC, inserted };
  });
  console.log(`种子数据完成：${store.listSegments().length} 个期间段，${store.listEvents({ limit: 1000 }).length} 笔事件。`);
  return result;
}

if (require.main === module) seed();
module.exports = { seed };

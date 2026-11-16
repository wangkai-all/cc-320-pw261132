'use strict';

/* 返利核对台前端：无构建、无第三方依赖。仅访问同源 API，所有金额来自服务端整数分。 */

const state = {
  meta: null,
  groups: [],
  suppliers: [],
  entities: [],
  contracts: [],
  segments: [],
  strategy: 'incremental',
  filters: { group_id: '', category: '', period: '' },
  busy: false,
};

const main = document.getElementById('main');
const toasts = document.getElementById('toasts');
const dialog = document.getElementById('dialog');
const dialogTitle = document.getElementById('dialog-title');
const dialogBody = document.getElementById('dialog-body');

// ---------- 工具 ----------

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return '—';
  const n = Math.trunc(Number(cents));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const yuan = Math.floor(abs / 100).toLocaleString('zh-CN');
  return `${sign}¥${yuan}.${String(abs % 100).padStart(2, '0')}`;
}

function signedMoney(cents) {
  if (!cents) return money(0);
  return `${cents > 0 ? '+' : ''}${money(cents)}`;
}

function pct(bps) {
  if (bps == null) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function yuanToCents(value) {
  const text = String(value == null ? '' : value).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [i, d = ''] = text.split('.');
  return Number(i) * 100 + Number(d.padEnd(2, '0'));
}

function uid(prefix = 'req') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function toast(message, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.textContent = message;
  toasts.append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; }, ms - 220);
  setTimeout(() => el.remove(), ms);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const err = new Error((payload && payload.error && payload.error.message) || `请求失败（${res.status}）`);
    err.code = payload && payload.error ? payload.error.code : 'http_error';
    err.details = payload && payload.error ? payload.error.details : null;
    err.status = res.status;
    throw err;
  }
  return payload;
}

function setBusy(fn) {
  return async (...args) => {
    if (state.busy) return;
    state.busy = true;
    main.classList.add('loading');
    try { await fn(...args); }
    catch (err) { toast(err.message || '操作失败', 'err', 6000); console.error(err); }
    finally { state.busy = false; main.classList.remove('loading'); }
  };
}

function openDialog(title, html) {
  dialogTitle.textContent = title;
  dialogBody.innerHTML = html;
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}
function closeDialog() {
  if (typeof dialog.close === 'function') closeDialog();
  else dialog.removeAttribute('open');
}
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) closeDialog();
});

function emptyRow(cols, text = '暂无数据') {
  return `<tr><td colspan="${cols}"><div class="empty">${esc(text)}</div></td></tr>`;
}

function badgeForSegment(seg) {
  if (seg.dirty) return '<span class="chip dirty">待重算</span>';
  if (!seg.confirmed_cents) return '<span class="chip trial">未确认</span>';
  if (seg.confirmed_cents < seg.rebate_cents) return '<span class="chip partial">部分确认</span>';
  if (seg.confirmed_cents === seg.rebate_cents) return '<span class="chip confirmed">已确认</span>';
  return '<span class="chip stale">确认超额</span>';
}

function groupName(id) {
  const g = state.groups.find((x) => x.id === id);
  return g ? g.name : id;
}

function categoryOptions(selected) {
  const cats = [...new Set(state.segments.map((s) => s.category))].sort();
  return ['<option value="">全部品类</option>']
    .concat(cats.map((c) => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}</option>`))
    .join('');
}

function groupOptions(selected) {
  return ['<option value="">全部集团</option>']
    .concat(state.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`))
    .join('');
}

function periodOptions(selected) {
  return ['<option value="">全部季度</option>']
    .concat((state.meta.periods || []).map((p) => `<option value="${esc(p)}" ${p === selected ? 'selected' : ''}>${esc(p)}</option>`))
    .join('');
}

function contractOptions(selected) {
  return ['<option value="">选择合同</option>']
    .concat(state.contracts.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`))
    .join('');
}

function supplierOptions(selected) {
  return ['<option value="">选择供应商</option>']
    .concat(state.suppliers.map((s) => `<option value="${esc(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}（${esc(s.group_code)}）</option>`))
    .join('');
}

function entityOptions(selected) {
  return ['<option value="">选择采购实体</option>']
    .concat(state.entities.filter((e) => e.active).map((e) => `<option value="${esc(e.id)}" ${e.id === selected ? 'selected' : ''}>${esc(e.name)}（${esc(e.code)}）</option>`))
    .join('');
}

// ---------- 数据加载 ----------

async function loadBootstrap() {
  const [meta, groups, suppliers, entities, contracts] = await Promise.all([
    api('/api/meta'), api('/api/groups'), api('/api/suppliers'), api('/api/entities'), api('/api/contracts'),
  ]);
  state.meta = meta;
  state.strategy = meta.strategy;
  state.groups = groups.groups;
  state.suppliers = suppliers.suppliers;
  state.entities = entities.entities;
  state.contracts = contracts.contracts;
  document.querySelectorAll('[data-strategy]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.strategy === state.strategy));
  });
  const disclaimer = document.getElementById('disclaimer');
  if (meta.disclaimer) disclaimer.textContent = meta.disclaimer;
}

async function loadSegments() {
  const q = new URLSearchParams();
  if (state.filters.group_id) q.set('group_id', state.filters.group_id);
  if (state.filters.category) q.set('category', state.filters.category);
  if (state.filters.period) q.set('period', state.filters.period);
  const data = await api(`/api/segments?${q.toString()}`);
  state.segments = data.segments;
  return data.segments;
}

// ---------- 路由 ----------

const routes = {
  overview: renderOverview,
  segments: renderSegments,
  segment: renderSegmentDetail,
  events: renderEvents,
  rules: renderRules,
  changes: renderChanges,
  jobs: renderJobs,
  settings: renderSettings,
};

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = hash.split('/');
  return { name: name || 'overview', param: rest.join('/') };
}

async function render() {
  const { name, param } = currentRoute();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === name || (name === 'segment' && a.dataset.nav === 'segments');
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  try {
    await loadSegments();
    if (name === 'segment') await routes.segment(param);
    else await (routes[name] || renderOverview)();
  } catch (err) {
    main.innerHTML = `<div class="banner bad"><div><strong>加载失败</strong><br>${esc(err.message)}</div></div>`;
    console.error(err);
  }
}

window.addEventListener('hashchange', () => { render(); main.focus({ preventScroll: true }); });

// ---------- 总览 ----------

async function renderOverview() {
  const segments = state.segments;
  const totalBase = segments.reduce((s, x) => s + x.eligible_base_cents, 0);
  const totalTrial = segments.reduce((s, x) => s + x.rebate_cents, 0);
  const totalConfirmed = segments.reduce((s, x) => s + (x.confirmed_cents || 0), 0);
  const exposure = segments.reduce((s, x) => s + Math.max(0, (x.confirmed_cents || 0) - x.rebate_cents), 0);
  const outstanding = segments.reduce((s, x) => s + Math.max(0, x.rebate_cents - (x.confirmed_cents || 0)), 0);
  const dirty = segments.filter((x) => x.dirty);
  const changes = await api('/api/changes?limit=6');
  const jobs = await api('/api/jobs?limit=4');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>总览</h2>
        <p>返利按「供应商集团 + 品类 + 季度」整段累计后套用单档费率。任一实体、任一供应商的采购都推动同一门槛。</p>
      </div>
      <div class="toolbar">
        <a class="btn" href="#/events">录入事件</a>
        <a class="btn primary" href="#/segments">查看期间段</a>
      </div>
    </div>

    <div class="grid cols-4" style="margin-bottom:14px">
      <div class="card stat"><span class="label">合格采购累计（整段）</span><span class="value">${money(totalBase)}</span><span class="hint">${segments.length} 个集团·品类·季度段</span></div>
      <div class="card stat accent"><span class="label">当前应得返利（试算口径）</span><span class="value">${money(totalTrial)}</span><span class="hint">不等于已确认金额</span></div>
      <div class="card stat"><span class="label">已确认台账</span><span class="value">${money(totalConfirmed)}</span><span class="hint">正式分录，只追加不可改</span></div>
      <div class="card stat"><span class="label">确认超额（需回补）</span><span class="value ${exposure ? 'neg' : ''}">${money(exposure)}</span><span class="hint">退货或归属更正后可能出现</span></div>
    </div>

    ${dirty.length ? `<div class="banner warn"><div><strong>${dirty.length} 个期间段标记为待重算。</strong>规则变更后聚合尚未刷新，旧试算会因此被拒绝确认。<br>
      <span class="small">${dirty.slice(0, 4).map((d) => esc(`${d.group_name} · ${d.category} · ${d.period}`)).join('；')}${dirty.length > 4 ? ' 等' : ''}</span>
      <div style="margin-top:8px"><a class="btn" href="#/jobs">前往任务中心</a></div></div></div>` : ''}

    <div class="two-col">
      <section class="card card-pad">
        <h3 class="section">期间段一览</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>集团 / 品类 / 季度</th><th class="num">合格金额</th><th class="num">返利（试算）</th><th class="num">已确认</th><th>档位</th><th>状态</th></tr></thead>
            <tbody>
              ${segments.length ? segments.map((s) => `
                <tr>
                  <td><a href="#/segment/${encodeURIComponent(s.id)}">${esc(s.group_name)} · ${esc(s.category)} · ${esc(s.period)}</a></td>
                  <td class="num">${money(s.eligible_base_cents)}</td>
                  <td class="num">${money(s.rebate_cents)}</td>
                  <td class="num">${money(s.confirmed_cents || 0)}</td>
                  <td>${esc(s.tier_label || '—')} <span class="muted">${pct(s.rate_bps)}</span></td>
                  <td>${badgeForSegment(s)}</td>
                </tr>`).join('') : emptyRow(6, '尚无期间段，请先录入采购事件')}
            </tbody>
          </table>
        </div>
        <p class="help" style="margin:10px 0 0">未确认部分共 ${money(outstanding)}。确认动作只能由试算快照发起，且快照必须仍与当前输入一致。</p>
      </section>

      <aside class="grid" style="align-content:start">
        <section class="card card-pad">
          <h3 class="section">最近变更</h3>
          <ul class="timeline">
            ${changes.changes.length ? changes.changes.slice(0, 5).map((c) => `
              <li>
                <div class="t"><a href="#/changes">${esc(c.title)}</a></div>
                <div class="d">${esc(c.summary)}</div>
                <div class="when">${when(c.created_at)} · ${c.impacts.length} 段受影响</div>
              </li>`).join('') : '<li class="muted">暂无变更</li>'}
          </ul>
        </section>
        <section class="card card-pad">
          <h3 class="section">重算任务</h3>
          ${jobs.jobs.length ? jobs.jobs.map((j) => `
            <div class="finding">
              <div class="t">${esc(j.kind === 'rule_change' ? '规则变更重算' : '全量对照重算')} · ${esc(j.status)}</div>
              <div class="d">${j.done_items}/${j.total_items} 段 · 策略 ${esc(j.strategy)} · ${j.events_scanned} 事件读取</div>
              <div class="bar ${j.status === 'completed' ? '' : 'amber'}" style="margin-top:6px"><span style="width:${j.total_items ? Math.round((j.done_items / j.total_items) * 100) : 0}%"></span></div>
            </div>`).join('') : '<p class="muted small">暂无任务。调整规则时会自动创建可恢复任务。</p>'}
        </section>
        <section class="card card-pad">
          <h3 class="section">口径说明</h3>
          <p class="help" style="margin:0 0 8px">整段套档：达到更高档后，<strong>整段合格金额</strong>按新费率计算，而不是只对超出部分计算。</p>
          <p class="help" style="margin:0">逐单套档后相加会在跨门槛时高估，因此只作为钻取中的对照，不参与台账。</p>
        </section>
      </aside>
    </div>
  `;
}

// ---------- 期间段列表 ----------

async function renderSegments() {
  main.innerHTML = `
    <div class="page-head">
      <div><h2>期间段</h2><p>每个「集团 + 品类 + 季度」是一个整段。点击进入可查看阶梯、实体分摊、试算与确认历史。</p></div>
    </div>
    <div class="card card-pad" style="margin-bottom:14px">
      <div class="toolbar">
        <label class="field">集团<select id="f-group">${groupOptions(state.filters.group_id)}</select></label>
        <label class="field">品类<select id="f-category">${categoryOptions(state.filters.category)}</select></label>
        <label class="field">季度<select id="f-period">${periodOptions(state.filters.period)}</select></label>
        <button type="button" id="f-apply">筛选</button>
        <button type="button" class="ghost" id="f-clear">清除</button>
        <span class="muted small">共 ${state.segments.length} 段</span>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap" style="max-height:none">
        <table>
          <thead><tr><th>集团 / 品类 / 季度</th><th class="num">采购总额</th><th class="num">退货</th><th class="num">合格金额</th><th class="num">费率</th><th class="num">返利</th><th class="num">已确认</th><th>状态</th><th></th></tr></thead>
          <tbody>
            ${state.segments.length ? state.segments.map((s) => `
              <tr>
                <td><a href="#/segment/${encodeURIComponent(s.id)}">${esc(s.group_name)} · ${esc(s.category)}</a><div class="muted small">${esc(s.period)}</div></td>
                <td class="num">${money(s.gross_cents)}</td>
                <td class="num ${s.returns_cents ? 'neg' : ''}">${s.returns_cents ? `-${money(s.returns_cents)}` : money(0)}</td>
                <td class="num">${money(s.eligible_base_cents)}</td>
                <td class="num">${pct(s.rate_bps)}</td>
                <td class="num">${money(s.rebate_cents)}</td>
                <td class="num">${money(s.confirmed_cents || 0)}</td>
                <td>${badgeForSegment(s)}</td>
                <td><a class="btn small" href="#/segment/${encodeURIComponent(s.id)}">钻取</a></td>
              </tr>`).join('') : emptyRow(9, '没有符合条件的期间段')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById('f-apply').addEventListener('click', setBusy(async () => {
    state.filters = {
      group_id: document.getElementById('f-group').value,
      category: document.getElementById('f-category').value,
      period: document.getElementById('f-period').value,
    };
    await renderSegments();
  }));
  document.getElementById('f-clear').addEventListener('click', () => {
    state.filters = { group_id: '', category: '', period: '' };
    render();
  });
}

// ---------- 期间段详情 ----------

async function renderSegmentDetail(segmentId) {
  const data = await api(`/api/segments/${encodeURIComponent(segmentId)}`);
  const s = data.segment;
  const d = data.drill;
  const rule = data.rule;
  const conf = data.confirmed;
  const maxTier = Math.max(...rule.tiers.map((t) => t.threshold_cents), s.eligible_base_cents, 1);
  const markers = rule.tiers.map((t) => {
    const left = Math.min(100, (t.threshold_cents / maxTier) * 100);
    return `<div class="tier-marker" style="left:${left}%" data-label="${esc(t.threshold_display)} · ${esc(t.rate_display)}"></div>`;
  }).join('');
  const nowPos = Math.min(100, (s.eligible_base_cents / maxTier) * 100);

  const nextTier = d.display.nextTier;
  const staleSnapshots = data.snapshots.filter((x) => x.stale).length;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <div class="muted small"><a href="#/segments">期间段</a> / ${esc(s.group_name)}</div>
        <h2>${esc(s.group_name)} · ${esc(s.category)} · ${esc(s.period)}</h2>
        <p>合同：${esc(rule.contract_name || '未配置')} · 规则版本 v${esc(rule.version)} · 聚合版本 v${esc(s.version)} · ${s.event_count} 笔有效事件</p>
      </div>
      <div class="toolbar">
        <button type="button" class="primary" id="btn-trial" ${s.dirty ? 'disabled title="该段待重算，需先推进任务"' : ''}>生成试算快照</button>
        <button type="button" id="btn-whatif">假设门槛对比</button>
      </div>
    </div>

    ${s.dirty ? `<div class="banner warn"><div><strong>该段待重算：</strong>${esc(s.dirty_reason || '规则已变更')}。此状态下所有旧试算均不可确认。</div></div>` : ''}
    ${conf.exposureCents > 0 ? `<div class="banner bad"><div><strong>确认超额 ${money(conf.exposureCents)}。</strong>通常由退货追溯或供应商归属更正造成；需对相关实体执行回补，确认接口不会静默扣减。</div></div>` : ''}
    ${staleSnapshots ? `<div class="banner info"><div>${staleSnapshots} 个旧试算已过期，确认时会被拒绝；请重新生成试算。</div></div>` : ''}

    <div class="grid cols-4" style="margin-bottom:14px">
      <div class="card stat"><span class="label">合格金额（整段）</span><span class="value">${money(s.eligible_base_cents)}</span><span class="hint">采购 ${money(s.gross_cents)} − 退货 ${money(s.returns_cents)}</span></div>
      <div class="card stat accent"><span class="label">整段返利</span><span class="value">${money(s.rebate_cents)}</span><span class="hint">${esc(s.tier_label || '')} · ${pct(s.rate_bps)}</span></div>
      <div class="card stat"><span class="label">已确认</span><span class="value">${money(conf.totalCents)}</span><span class="hint">${conf.entryCount} 条台账分录</span></div>
      <div class="card stat"><span class="label">未确认 / 超额</span><span class="value ${conf.exposureCents ? 'neg' : ''}">${money(conf.exposureCents || conf.outstandingCents)}</span><span class="hint">${conf.exposureCents ? '需回补' : '可继续确认'}</span></div>
    </div>

    <div class="two-col">
      <div class="grid" style="align-content:start">
        <section class="card card-pad">
          <h3 class="section">阶梯位置与差额钻取</h3>
          <div class="tier-scale">
            <div class="tier-track"></div>
            ${markers}
            <div class="tier-now" style="left:${nowPos}%" title="当前整段累计"></div>
          </div>
          <div class="tiles" style="margin-top:16px">
            <div class="mini"><div class="k">当前档位</div><div class="v">${esc(s.tier_label || '—')}</div></div>
            <div class="mini"><div class="k">适用费率</div><div class="v">${pct(s.rate_bps)}</div></div>
            <div class="mini"><div class="k">距下一档</div><div class="v">${nextTier ? nextTier.gap : '已达最高档'}</div></div>
            <div class="mini"><div class="k">跨档后整段增量</div><div class="v">${nextTier ? nextTier.incremental : '—'}</div></div>
          </div>
          ${nextTier ? `<p class="help" style="margin:12px 0 0">再采购 <strong>${nextTier.gap}</strong> 可达到「${esc(nextTier.label)}」${esc((nextTier.rateBps / 100).toFixed(2))}%；届时整段返利为 ${nextTier.projected}，较当前增加 ${nextTier.incremental}。</p>` : ''}
        </section>

        <section class="card card-pad">
          <h3 class="section">整段法 vs 逐单相加（解释用，不写台账）</h3>
          <table>
            <tbody>
              <tr><td>整段套档（本应用唯一口径）</td><td class="num">${d.display.applied}</td></tr>
              <tr><td>逐单独立套档后相加（错误对照）</td><td class="num">${d.display.perOrder}</td></tr>
              <tr><td><strong>逐单法高估</strong></td><td class="num ${d.overstatementCents > 0 ? 'neg' : ''}">${signedMoney(d.overstatementCents)}</td></tr>
            </tbody>
          </table>
          <p class="help" style="margin:10px 0 0">差额来自跨门槛：逐单法让每笔采购都按其自身金额落入较低档，却把所有单的返利相加，忽略整段跨档后应整体提高费率；反之也可能低估。该值只用于说明，不参与确认。</p>
        </section>

        <section class="card card-pad">
          <h3 class="section">按采购实体分摊</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>实体</th><th class="num">采购</th><th class="num">退货</th><th class="num">净额</th><th class="num">分摊返利</th></tr></thead>
              <tbody>
                ${data.entities.length ? data.entities.map((e) => `
                  <tr>
                    <td>${esc(e.entity_name)} <span class="muted">${esc(e.entity_code)}</span></td>
                    <td class="num">${money(e.gross_cents)}</td>
                    <td class="num ${e.returns_cents ? 'neg' : ''}">${e.returns_cents ? `-${money(e.returns_cents)}` : money(0)}</td>
                    <td class="num">${money(e.base_cents)}</td>
                    <td class="num">${money(e.share_cents)}</td>
                  </tr>`).join('') : emptyRow(5, '暂无实体分摊')}
              </tbody>
              <tfoot><tr><td><strong>合计</strong></td><td class="num">${money(s.gross_cents)}</td><td class="num">${money(s.returns_cents)}</td><td class="num">${money(s.eligible_base_cents)}</td><td class="num"><strong>${money(data.entities.reduce((a, e) => a + e.share_cents, 0))}</strong></td></tr></tfoot>
            </table>
          </div>
          <p class="help" style="margin:10px 0 0">多实体共享同一门槛；分摊按各实体净额权重，余数用最大余数法确定性分配，合计严格等于整段返利。</p>
        </section>

        <section class="card card-pad">
          <h3 class="section">有效事件 <span class="muted small">（退货金额为负参与净额）</span></h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>日期</th><th>类型</th><th>供应商</th><th>实体</th><th class="num">金额</th><th>备注</th><th></th></tr></thead>
              <tbody>
                ${data.events.length ? data.events.map((e) => `
                  <tr>
                    <td class="small">${esc((e.occurred_at || '').slice(0, 10))}</td>
                    <td><span class="chip ${e.event_type === 'return' ? 'return' : 'purchase'}">${e.event_type === 'return' ? '退货' : '采购'}</span></td>
                    <td>${esc(e.supplier_name)}</td>
                    <td>${esc(e.entity_name)}</td>
                    <td class="num ${e.event_type === 'return' ? 'neg' : ''}">${e.event_type === 'return' ? '-' : ''}${money(e.amount_cents)}</td>
                    <td class="small muted">${esc(e.note || '')}</td>
                    <td>${e.event_type === 'purchase' ? `<button type="button" class="small ghost btn-return" data-event="${esc(e.id)}" data-amount="${e.amount_cents}" data-label="${esc(e.supplier_name)} / ${esc(e.entity_name)}">退货</button>` : ''}</td>
                  </tr>`).join('') : emptyRow(7, '暂无有效事件')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="card card-pad">
          <h3 class="section">该段变更轨迹 <span class="muted small">（影响可解释到段）</span></h3>
          <ul class="timeline">
            ${data.impacts.length ? data.impacts.map((i) => {
              const before = i.before && i.before.segment ? i.before.segment : null;
              const after = i.after && i.after.segment ? i.after.segment : null;
              return `<li>
                <div class="t">${esc(i.change_title)} <span class="chip ${i.change_kind === 'return' ? 'return' : 'trial'}">${esc(i.change_kind)}</span></div>
                <div class="d">
                  合格金额 ${before ? money(before.eligible_base_cents) : money(0)} → ${after ? money(after.eligible_base_cents) : money(0)}
                  （${signedMoney(i.delta_base_cents)}）；返利 ${before ? money(before.rebate_cents) : money(0)} → ${after ? money(after.rebate_cents) : money(0)}
                  （<span class="${i.delta_rebate_cents < 0 ? 'neg' : 'pos'}">${signedMoney(i.delta_rebate_cents)}</span>）
                </div>
                <div class="when">${when(i.change_created_at)} · 使 ${i.invalidated_snapshot_ids.length} 个旧试算过期</div>
              </li>`;
            }).join('') : '<li class="muted small">暂无变更记录</li>'}
          </ul>
        </section>
      </div>

      <aside class="grid" style="align-content:start">
        <section class="card card-pad">
          <h3 class="section">试算快照 <span class="chip trial">仅试算</span></h3>
          <p class="help" style="margin:0 0 10px">试算不会写入正式台账。确认前会校验段版本、输入摘要和规则版本，旧试算一律拒绝。</p>
          <div class="grid" style="gap:10px">
            ${data.snapshots.length ? data.snapshots.map((snap) => `
              <div class="finding" style="border-left-color:${snap.stale ? '#c46b6b' : snap.is_what_if ? '#8d74c9' : '#2a4f8a'}">
                <div class="t" style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                  <span>${money(snap.rebate_cents)} <span class="muted small">${esc(snap.display.rate)}</span></span>
                  ${snap.is_what_if ? '<span class="chip whatif">假设</span>' : snap.stale ? '<span class="chip stale">已过期</span>' : '<span class="chip trial">可确认</span>'}
                </div>
                <div class="d">基线 v${snap.segment_version} · ${when(snap.created_at)} · ${esc(snap.actor)}${snap.confirmation ? ` · 台账累计 ${money(snap.confirmation.ledger_total_cents)}` : ''}</div>
                ${snap.stale ? `<div class="d neg">${esc(snap.stale.message)}</div>` : ''}
                ${snap.is_what_if ? '<div class="d">假设规则快照，不能确认。</div>' : snap.stale ? '' : `
                  <div class="event-actions" style="margin-top:8px">
                    <button type="button" class="primary small btn-confirm" data-snapshot="${esc(snap.id)}" data-mode="exact">按快照确认</button>
                    <button type="button" class="small btn-confirm" data-snapshot="${esc(snap.id)}" data-mode="topup">补记至当前应得</button>
                  </div>
                  <div class="d small" style="margin-top:6px">确认只补“目标 − 已确认”的差额；重复点击或并发请求不会重复分配。</div>`}
              </div>`).join('') : '<p class="muted small">尚未生成试算。点击右上角「生成试算快照」。</p>'}
          </div>
        </section>

        <section class="card card-pad">
          <h3 class="section">正式台账 <span class="chip confirmed">已确认</span></h3>
          <div class="table-wrap" style="max-height:280px">
            <table>
              <thead><tr><th>时间</th><th>实体</th><th>类型</th><th class="num">金额</th></tr></thead>
              <tbody>
                ${data.ledger.length ? data.ledger.map((e) => `
                  <tr>
                    <td class="small">${when(e.created_at)}</td>
                    <td class="small">${esc(e.entity_code)}</td>
                    <td><span class="chip ${e.kind === 'clawback' ? 'stale' : e.kind === 'topup' ? 'partial' : 'confirmed'}">${e.kind === 'clawback' ? '回补' : e.kind === 'topup' ? '补记' : '确认'}</span></td>
                    <td class="num ${e.amount_cents < 0 ? 'neg' : ''}">${money(e.amount_cents)}</td>
                  </tr>`).join('') : emptyRow(4, '尚无正式分录')}
              </tbody>
            </table>
          </div>
          <p class="help" style="margin:10px 0 0">台账分录只追加；数据库触发器禁止 UPDATE / DELETE。行内金额为累计净额之和，用于核对是否与整段应得一致。</p>
        </section>

        ${conf.exposureCents > 0 ? `
        <section class="card card-pad">
          <h3 class="section">回补（显式冲销）</h3>
          <p class="help" style="margin:0 0 8px">当前段已确认比应得多 ${money(conf.exposureCents)}。选择实体并填写回补金额（元）。</p>
          <form id="form-clawback" class="panel">
            <label class="field">实体<select name="entity_id" required>${data.confirmed.entities.map((e) => {
              const ent = data.entities.find((x) => x.entity_id === e.entityId);
              return `<option value="${esc(e.entityId)}">${esc(ent ? `${ent.entity_name}（${ent.entity_code}）` : e.entityId)} · 已确认 ${money(e.total)}</option>`;
            }).join('')}</select></label>
            <label class="field">回补金额（元）<input name="amount" inputmode="decimal" placeholder="例如 75.00" required></label>
            <label class="field">备注<input name="note" maxlength="200" placeholder="虚构：退货追溯回补"></label>
            <button type="submit" class="danger">执行回补</button>
          </form>
        </section>` : ''}
      </aside>
    </div>

    <details class="raw">
      <summary>查看服务端原始数据</summary>
      <pre>${esc(JSON.stringify(data, null, 2))}</pre>
    </details>
  `;

  document.getElementById('btn-trial').addEventListener('click', setBusy(async () => {
    const snap = await api(`/api/segments/${encodeURIComponent(segmentId)}/snapshots`, {
      method: 'POST', body: { note: '界面生成试算', actor: '演示用户' },
    });
    toast(`已生成试算：${money(snap.rebate_cents)}（未写入台账）`, 'ok');
    await renderSegmentDetail(segmentId);
  }));

  document.getElementById('btn-whatif').addEventListener('click', () => openWhatIf(data));
  document.querySelectorAll('.btn-confirm').forEach((btn) => {
    btn.addEventListener('click', setBusy(async () => {
      btn.disabled = true;
      try {
        const result = await api(`/api/snapshots/${encodeURIComponent(btn.dataset.snapshot)}/confirm`, {
          method: 'POST',
          body: {
            mode: btn.dataset.mode,
            idempotency_key: `ui_${btn.dataset.snapshot}_${btn.dataset.mode}`,
            actor: '演示用户',
            note: btn.dataset.mode === 'topup' ? '界面补记' : '界面确认',
          },
        });
        toast(
          result.totalAddedCents
            ? `确认完成：新增 ${money(result.totalAddedCents)}，累计 ${money(result.confirmedTotalCents)}`
            : (result.message || '无需新增分配'),
          'ok'
        );
        await renderSegmentDetail(segmentId);
      } finally { btn.disabled = false; }
    }));
  });
  document.querySelectorAll('.btn-return').forEach((btn) => {
    btn.addEventListener('click', () => openReturn(btn.dataset, data, segmentId));
  });
  const cbForm = document.getElementById('form-clawback');
  if (cbForm) {
    cbForm.addEventListener('submit', setBusy(async (ev) => {
      ev.preventDefault();
      const fd = new FormData(cbForm);
      const amount = yuanToCents(fd.get('amount'));
      if (!amount || amount <= 0) throw new Error('回补金额格式不正确');
      const res = await api(`/api/segments/${encodeURIComponent(segmentId)}/clawback`, {
        method: 'POST',
        body: {
          entity_id: fd.get('entity_id'),
          amount_cents: amount,
          note: fd.get('note') || '虚构退货回补',
          idempotency_key: uid('cb'),
          actor: '演示用户',
        },
      });
      toast(`已回补 ${money(res.clawbackCents)}`, 'ok');
      await renderSegmentDetail(segmentId);
    }));
  }
}

function openWhatIf(data) {
  const tiers = data.rule.tiers;
  const rows = tiers.map((t, i) => `
    <div class="form-grid" data-tier-row="${i}" style="margin-bottom:8px">
      <label class="field">门槛（元）<input name="threshold" inputmode="decimal" value="${(t.threshold_cents / 100).toFixed(2)}"></label>
      <label class="field">费率（%）<input name="rate" inputmode="decimal" value="${(t.rate_bps / 100).toFixed(2)}"></label>
      <label class="field">标签<input name="label" value="${esc(t.label)}"></label>
    </div>`).join('');
  openDialog('假设门槛对比（不写回）', `
    <p class="help">用当前段的合格金额试算另一套门槛。结果只是假设，不会生成可确认快照，也不影响正式平均费率。</p>
    <div id="whatif-rows">${rows}</div>
    <button type="button" class="small" id="whatif-add">增加一档</button>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" class="primary" id="whatif-run">计算对比</button>
      <button type="button" id="whatif-save">保存为假设快照（不可确认）</button>
    </div>
    <div id="whatif-result" style="margin-top:12px"></div>
  `);
  const collect = () => [...document.querySelectorAll('#whatif-rows [data-tier-row]')].map((row) => {
    const threshold = yuanToCents(row.querySelector('[name=threshold]').value);
    const rate = Number(row.querySelector('[name=rate]').value);
    return {
      threshold_cents: threshold,
      rate_bps: Math.round(rate * 100),
      label: row.querySelector('[name=label]').value || `${rate}%`,
    };
  });
  document.getElementById('whatif-add').addEventListener('click', () => {
    const el = document.createElement('div');
    el.className = 'form-grid';
    el.dataset.tierRow = String(Date.now());
    el.style.marginBottom = '8px';
    el.innerHTML = '<label class="field">门槛（元）<input name="threshold" inputmode="decimal" value="0.00"></label>'
      + '<label class="field">费率（%）<input name="rate" inputmode="decimal" value="0.00"></label>'
      + '<label class="field">标签<input name="label" value=""></label>';
    document.getElementById('whatif-rows').append(el);
  });
  document.getElementById('whatif-run').addEventListener('click', setBusy(async () => {
    const tiersInput = collect();
    if (tiersInput.some((t) => t.threshold_cents == null)) throw new Error('门槛金额格式不正确');
    const res = await api(`/api/segments/${encodeURIComponent(data.segment.id)}/drill`, {
      method: 'POST', body: { tiers: tiersInput },
    });
    const delta = res.deltaRebateCents;
    document.getElementById('whatif-result').innerHTML = `
      <div class="banner ${delta >= 0 ? 'good' : 'bad'}"><div>
        假设规则下整段返利 <strong>${money(res.applied.rebateCents)}</strong>（${pct(res.applied.rateBps)}，${esc(res.applied.tierLabel)}）<br>
        相对现行 ${money(res.comparedTo.rebateCents)}，变化 <strong>${signedMoney(delta)}</strong>。
      </div></div>`;
  }));
  document.getElementById('whatif-save').addEventListener('click', setBusy(async () => {
    const tiersInput = collect();
    const snap = await api(`/api/segments/${encodeURIComponent(data.segment.id)}/snapshots`, {
      method: 'POST', body: { what_if_tiers: tiersInput, note: '假设门槛对比', actor: '演示用户' },
    });
    closeDialog();
    toast(`已保存假设快照 ${money(snap.rebate_cents)}；标记为不可确认`, 'info');
    await renderSegmentDetail(data.segment.id);
  }));
}

function openReturn(dataset, data, segmentId) {
  openDialog('登记退货（虚构）', `
    <div class="banner warn"><div>退货会追溯原采购所属期间 <strong>${esc(data.segment.period)}</strong>，
      重新计算整段累计，可能降低历史返利并使已确认金额出现超额。</div></div>
    <form id="form-return" class="panel">
      <label class="field">原采购<select name="reverses_event_id" required>
        ${data.events.filter((e) => e.event_type === 'purchase').map((e) => `<option value="${esc(e.id)}">${esc(e.supplier_name)} · ${esc(e.entity_name)} · ${money(e.amount_cents)} · ${esc((e.occurred_at || '').slice(0, 10))}</option>`).join('')}
      </select></label>
      <label class="field">退货金额（元）<input name="amount" inputmode="decimal" placeholder="例如 3000.00" required></label>
      <label class="field">退货日期<input name="occurred_at" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
      <label class="field">备注<input name="note" maxlength="200" placeholder="虚构：质量退货"></label>
      <div class="toolbar">
        <button type="submit" class="danger">提交退货并追溯重算</button>
        <span class="muted small">退货不得超出该采购的可退余额</span>
      </div>
    </form>
  `);
  document.getElementById('form-return').addEventListener('submit', setBusy(async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const amount = yuanToCents(fd.get('amount'));
    if (!amount || amount <= 0) throw new Error('退货金额格式不正确');
    const res = await api('/api/events', {
      method: 'POST',
      body: {
        event_type: 'return',
        reverses_event_id: fd.get('reverses_event_id'),
        amount_cents: amount,
        occurred_at: `${fd.get('occurred_at')}T00:00:00.000Z`,
        note: fd.get('note') || '',
        actor: '演示用户',
        client_request_id: uid('ret'),
      },
    });
    closeDialog();
    toast(`退货已登记；受影响的期间段：${esc((res.event && res.event.period) || '')}`, 'ok', 6000);
    await renderSegmentDetail(segmentId);
  }));
}

// ---------- 采购事件 ----------

async function renderEvents() {
  const [eventsRes] = await Promise.all([api('/api/events?limit=120')]);
  const events = eventsRes.events;
  main.innerHTML = `
    <div class="page-head">
      <div><h2>采购事件</h2><p>采购与退货都以事件形式进入账本；退货必须关联原采购，并自动归入原期间。</p></div>
      <button type="button" class="primary" id="btn-add-event">录入采购</button>
    </div>
    <div class="card">
      <div class="table-wrap" style="max-height:none">
        <table>
          <thead><tr><th>季度</th><th>日期</th><th>类型</th><th>集团</th><th>供应商</th><th>实体</th><th>品类</th><th class="num">金额</th><th>备注</th></tr></thead>
          <tbody>
            ${events.length ? events.map((e) => `
              <tr>
                <td><span class="mono">${esc(e.period)}</span></td>
                <td class="small">${esc((e.occurred_at || '').slice(0, 10))}</td>
                <td><span class="chip ${e.event_type === 'return' ? 'return' : 'purchase'}">${e.event_type === 'return' ? '退货' : '采购'}</span></td>
                <td class="small">${esc(e.group_name)}</td>
                <td>${esc(e.supplier_name)}</td>
                <td class="small">${esc(e.entity_name)}</td>
                <td>${esc(e.category)}</td>
                <td class="num ${e.event_type === 'return' ? 'neg' : ''}">${e.event_type === 'return' ? '-' : ''}${money(e.amount_cents)}</td>
                <td class="small muted">${esc(e.note || '')}${e.reversed_by_id ? ' · 已退货' : ''}</td>
              </tr>`).join('') : emptyRow(9, '尚未录入事件')}
          </tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById('btn-add-event').addEventListener('click', () => openPurchaseDialog());
}

function openPurchaseDialog() {
  openDialog('录入采购（虚构）', `
    <div class="banner info"><div>金额会累加到「供应商所属集团 + 品类 + 季度」这一段，并可能让整段跨档，从而改变<strong>该段全部实体</strong>的返利。</div></div>
    <form id="form-purchase" class="panel">
      <div class="form-grid">
        <label class="field">供应商<select name="supplier_id" required>${supplierOptions()}</select></label>
        <label class="field">采购实体<select name="entity_id" required>${entityOptions()}</select></label>
        <label class="field">品类<input name="category" list="category-list" required placeholder="例如 钢材"></label>
        <label class="field">季度<input name="period" required placeholder="2026-Q3" pattern="\\d{4}-Q[1-4]"></label>
        <label class="field">金额（元）<input name="amount" inputmode="decimal" required placeholder="例如 128000.00"></label>
        <label class="field">日期<input name="occurred_at" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
      </div>
      <label class="field">备注<input name="note" maxlength="200" placeholder="虚构：采购批次"></label>
      <datalist id="category-list">${[...new Set(state.segments.map((s) => s.category))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="toolbar"><button type="submit" class="primary">提交采购</button><span class="muted small">按当前策略 ${esc(state.strategy === 'incremental' ? '增量维护' : '受影响段重算')} 更新聚合</span></div>
    </form>
  `);
  document.getElementById('form-purchase').addEventListener('submit', setBusy(async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const amount = yuanToCents(fd.get('amount'));
    if (!amount || amount <= 0) throw new Error('金额格式不正确');
    const period = String(fd.get('period') || '').toUpperCase();
    if (!/^\d{4}-Q[1-4]$/.test(period)) throw new Error('季度格式应为 2026-Q3');
    const res = await api('/api/events', {
      method: 'POST',
      body: {
        event_type: 'purchase',
        supplier_id: fd.get('supplier_id'),
        entity_id: fd.get('entity_id'),
        category: String(fd.get('category')).trim(),
        period,
        amount_cents: amount,
        occurred_at: `${fd.get('occurred_at')}T00:00:00.000Z`,
        note: fd.get('note') || '',
        actor: '演示用户',
        client_request_id: uid('pur'),
      },
    });
    closeDialog();
    toast(`采购已录入，当前段返利 ${money(res.computation ? res.computation.rebateCents : 0)}（试算口径）`, 'ok');
    await render();
  }));
}

// ---------- 规则 ----------

async function renderRules() {
  main.innerHTML = `
    <div class="page-head">
      <div><h2>合同与规则</h2><p>规则版本化：调整费率会生成新版本，历史期间段按新版本整段重算，旧试算随即失效。</p></div>
      <button type="button" class="primary" id="btn-new-contract">新建合同</button>
    </div>
    <div class="grid cols-2">
      ${state.contracts.map((c) => `
        <section class="card card-pad">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
            <div>
              <h3 class="section" style="margin-bottom:2px">${esc(c.name)}</h3>
              <div class="muted small">${esc(c.group_name)} · ${esc(c.category)} · 当前 v${esc(c.current_version)} · ${esc(c.currency)}</div>
            </div>
            <button type="button" class="small btn-edit-rule" data-contract="${esc(c.id)}">调整规则</button>
          </div>
          <table style="margin-top:10px">
            <thead><tr><th>累计门槛（≥）</th><th class="num">整段费率</th><th>档位</th></tr></thead>
            <tbody>
              ${c.tiers.map((t) => `<tr><td class="num">${money(t.threshold_cents)}</td><td class="num">${pct(t.rate_bps)}</td><td>${esc(t.label)}</td></tr>`).join('')}
            </tbody>
          </table>
          <p class="help" style="margin:10px 0 0">当前规则说明：${esc(c.rule_note || '—')}</p>
        </section>`).join('') || '<div class="card card-pad"><div class="empty">尚未创建合同</div></div>'}
    </div>
  `;
  document.querySelectorAll('.btn-edit-rule').forEach((btn) => {
    btn.addEventListener('click', () => {
      const contract = state.contracts.find((c) => c.id === btn.dataset.contract);
      openRuleDialog(contract);
    });
  });
  document.getElementById('btn-new-contract').addEventListener('click', openContractDialog);
}

function tierEditorRows(tiers) {
  return tiers.map((t, i) => `
    <div class="form-grid" data-tier-row="${i}" style="margin-bottom:8px">
      <label class="field">门槛（元，≥）<input name="threshold" inputmode="decimal" value="${(t.threshold_cents / 100).toFixed(2)}" required></label>
      <label class="field">费率（%）<input name="rate" inputmode="decimal" value="${(t.rate_bps / 100).toFixed(2)}" required></label>
      <label class="field">标签<input name="label" value="${esc(t.label || '')}"></label>
    </div>`).join('');
}

function collectTiers(container) {
  return [...container.querySelectorAll('[data-tier-row]')].map((row) => {
    const threshold = yuanToCents(row.querySelector('[name=threshold]').value);
    const rate = Number(row.querySelector('[name=rate]').value);
    if (threshold == null) throw new Error('门槛金额格式不正确');
    if (!Number.isFinite(rate)) throw new Error('费率格式不正确');
    return {
      threshold_cents: threshold,
      rate_bps: Math.round(rate * 100),
      label: row.querySelector('[name=label]').value.trim(),
    };
  }).sort((a, b) => a.threshold_cents - b.threshold_cents);
}

function openRuleDialog(contract) {
  openDialog(`调整规则 · ${contract.name}`, `
    <div class="banner warn"><div>保存即创建新规则版本并标记该集团+品类下 <strong>所有历史期间段</strong>待重算。
      重算完成前，旧试算确认会被拒绝。整段金额不变，但费率变化会改变全部历史返利。</div></div>
    <label class="field" style="margin-bottom:10px">变更说明<input id="rule-note" value="虚构演示：费率调整" maxlength="200"></label>
    <div id="rule-rows">${tierEditorRows(contract.tiers)}</div>
    <div class="toolbar" style="margin-top:8px">
      <button type="button" class="small" id="rule-add-tier">增加一档</button>
      <button type="button" class="primary" id="rule-save">保存新规则版本</button>
    </div>
  `);
  document.getElementById('rule-add-tier').addEventListener('click', () => {
    const el = document.createElement('div');
    el.className = 'form-grid';
    el.dataset.tierRow = String(Date.now());
    el.style.marginBottom = '8px';
    el.innerHTML = '<label class="field">门槛（元，≥）<input name="threshold" value="0.00"></label>'
      + '<label class="field">费率（%）<input name="rate" value="0.00"></label>'
      + '<label class="field">标签<input name="label" value=""></label>';
    document.getElementById('rule-rows').append(el);
  });
  document.getElementById('rule-save').addEventListener('click', setBusy(async () => {
    const tiers = collectTiers(document.getElementById('rule-rows'));
    const res = await api(`/api/contracts/${encodeURIComponent(contract.id)}/versions`, {
      method: 'POST',
      body: { tiers, note: document.getElementById('rule-note').value, actor: '演示用户' },
    });
    closeDialog();
    toast(`已创建规则 v${res.version}；${res.affectedSegments} 段已标记待重算，任务已排队`, 'ok', 6000);
    await loadBootstrap();
    await render();
  }));
}

function openContractDialog() {
  openDialog('新建合同（虚构）', `
    <form id="form-contract" class="panel">
      <div class="form-grid">
        <label class="field">合同名称<input name="name" required placeholder="例如 星海集团·铝材返利（虚构）"></label>
        <label class="field">供应商集团<select name="group_id" required>${['<option value="">选择集团</option>'].concat(state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`)).join('')}</select></label>
        <label class="field">品类<input name="category" required placeholder="例如 铝材"></label>
      </div>
      <p class="help" style="margin:0">初始阶梯（至少含门槛 0 的一档；费率须随门槛单调不降）：</p>
      <div id="new-contract-rows">
        <div class="form-grid" data-tier-row="0" style="margin-bottom:8px">
          <label class="field">门槛（元，≥）<input name="threshold" value="0.00"></label>
          <label class="field">费率（%）<input name="rate" value="1.00"></label>
          <label class="field">标签<input name="label" value="基础档 1%"></label>
        </div>
      </div>
      <div class="toolbar">
        <button type="button" class="small" id="new-contract-add">增加一档</button>
        <button type="submit" class="primary">创建合同</button>
      </div>
    </form>
  `);
  document.getElementById('new-contract-add').addEventListener('click', () => {
    const el = document.createElement('div');
    el.className = 'form-grid';
    el.dataset.tierRow = String(Date.now());
    el.style.marginBottom = '8px';
    el.innerHTML = '<label class="field">门槛（元，≥）<input name="threshold" value="0.00"></label>'
      + '<label class="field">费率（%）<input name="rate" value="0.00"></label>'
      + '<label class="field">标签<input name="label" value=""></label>';
    document.getElementById('new-contract-rows').append(el);
  });
  document.getElementById('form-contract').addEventListener('submit', setBusy(async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const tiers = collectTiers(document.getElementById('new-contract-rows'));
    const res = await api('/api/contracts', {
      method: 'POST',
      body: {
        name: fd.get('name'), group_id: fd.get('group_id'), category: fd.get('category'),
        period_type: 'quarter', tiers, actor: '演示用户',
      },
    });
    closeDialog();
    toast(`合同已创建；${res.affectedSegments} 个历史段待重算`, 'ok');
    await loadBootstrap();
    await render();
  }));
}

// ---------- 变更追溯 ----------

async function renderChanges() {
  const res = await api('/api/changes?limit=60');
  main.innerHTML = `
    <div class="page-head">
      <div><h2>变更追溯</h2><p>每笔退货、采购或供应商归属更正都会记录“哪些期间段、金额与返利各变了多少、哪些旧试算因此过期”。</p></div>
      <button type="button" id="btn-move-supplier">供应商归属更正</button>
    </div>
    <div class="grid" style="gap:12px">
      ${res.changes.length ? res.changes.map((c) => `
        <section class="card card-pad">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
            <div>
              <h3 class="section" style="margin-bottom:2px">${esc(c.title)}</h3>
              <div class="muted small">${esc(c.summary)}</div>
            </div>
            <div class="muted small">${when(c.created_at)} · ${esc(c.actor)} · ${c.impacts.length} 段受影响</div>
          </div>
          ${c.impacts.length ? `<div class="table-wrap" style="margin-top:10px">
            <table>
              <thead><tr><th>期间段</th><th class="num">合格金额 Δ</th><th class="num">返利 Δ</th><th>变化前 → 后</th><th class="num">过期试算</th></tr></thead>
              <tbody>
                ${c.impacts.map((i) => {
                  const b = i.before && i.before.segment ? i.before.segment : null;
                  const a = i.after && i.after.segment ? i.after.segment : null;
                  return `<tr>
                    <td>${esc(i.segment_label)}</td>
                    <td class="num">${signedMoney(i.delta_base_cents)}</td>
                    <td class="num ${i.delta_rebate_cents < 0 ? 'neg' : 'pos'}">${signedMoney(i.delta_rebate_cents)}</td>
                    <td class="small">${b ? money(b.rebate_cents) : money(0)} → ${a ? money(a.rebate_cents) : money(0)}</td>
                    <td class="num">${i.invalidated_snapshot_ids.length}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>` : '<p class="muted small" style="margin:8px 0 0">该变更未改变任何期间段金额。</p>'}
          <details class="raw"><summary>展开完整前后对照</summary><pre>${esc(JSON.stringify(c.impacts, null, 2))}</pre></details>
        </section>`).join('') : '<div class="card card-pad"><div class="empty">暂无变更</div></div>'}
    </div>
  `;
  document.getElementById('btn-move-supplier').addEventListener('click', openMoveDialog);
}

function openMoveDialog() {
  openDialog('供应商归属更正（虚构）', `
    <div class="banner warn"><div>更正会改变该供应商<strong>全部历史采购</strong>的集团归属，从而同时影响原集团与目标集团的累计门槛。
      已确认台账不会自动修改；若出现超额，需要显式回补。</div></div>
    <form id="form-move" class="panel">
      <label class="field">供应商<select name="supplier_id" required>${supplierOptions()}</select></label>
      <label class="field">目标集团<select name="group_id" required>${groupOptions()}</select></label>
      <label class="field">更正原因<input name="reason" required maxlength="200" placeholder="虚构：合同主体调整"></label>
      <button type="submit" class="primary">提交更正并重算受影响段</button>
    </form>
  `);
  document.getElementById('form-move').addEventListener('submit', setBusy(async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const res = await api(`/api/suppliers/${encodeURIComponent(fd.get('supplier_id'))}/move`, {
      method: 'POST',
      body: { group_id: fd.get('group_id'), reason: fd.get('reason'), idempotency_key: uid('mv'), actor: '演示用户' },
    });
    closeDialog();
    const exposure = res.change.exposure || [];
    toast(
      `归属已更正，${res.change.impacts.length} 段受影响` +
      (exposure.length ? `；${exposure.length} 段确认超额 ${exposure.map((x) => money(x.exposure_cents)).join('、')}` : ''),
      exposure.length ? 'err' : 'ok',
      8000
    );
    await loadBootstrap();
    await renderChanges();
  }));
}

// ---------- 任务 ----------

async function renderJobs() {
  const res = await api('/api/jobs?limit=30');
  main.innerHTML = `
    <div class="page-head">
      <div><h2>重算任务</h2><p>规则变更会创建可恢复任务。任务按批提交，处理完的段立即持久化；中断后从 pending 继续。</p></div>
      <button type="button" id="btn-full">全量对照重算</button>
    </div>
    <div class="grid" style="gap:12px">
      ${res.jobs.length ? res.jobs.map((j) => `
        <section class="card card-pad">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
            <div>
              <h3 class="section" style="margin-bottom:2px">${esc(j.kind === 'rule_change' ? '规则变更重算' : '全量对照重算')} · ${esc(j.status)}</h3>
              <div class="muted small">策略 ${esc(j.strategy)} · 批次大小 ${j.batch_size} · ${j.done_items}/${j.total_items} 段 · 读取事件 ${j.events_scanned} · 用时 ${j.elapsed_ms}ms</div>
            </div>
            <div class="toolbar">
              ${j.status !== 'completed' ? `<button type="button" class="small btn-run" data-job="${esc(j.id)}">推进</button>` : ''}
              ${j.status === 'running' || j.status === 'pending' ? `<button type="button" class="small ghost btn-pause" data-job="${esc(j.id)}">暂停</button>` : ''}
              ${j.status === 'paused' ? `<button type="button" class="small btn-resume" data-job="${esc(j.id)}">恢复</button>` : ''}
            </div>
          </div>
          <div class="bar ${j.status === 'completed' ? '' : 'amber'}" style="margin-top:10px"><span style="width:${j.total_items ? Math.round((j.done_items / j.total_items) * 100) : 0}%"></span></div>
          ${j.note ? `<p class="help" style="margin:8px 0 0">${esc(j.note)}</p>` : ''}
          <details class="raw">
            <summary>查看逐段结果</summary>
            <div class="table-wrap"><table>
              <thead><tr><th>段</th><th>状态</th><th class="num">返利 Δ</th><th class="num">读取事件</th></tr></thead>
              <tbody>${(j.items || []).map((it) => `
                <tr><td>${esc(it.group_name)} · ${esc(it.category)} · ${esc(it.period)}</td><td>${esc(it.status)}</td>
                <td class="num ${it.delta_rebate_cents < 0 ? 'neg' : ''}">${it.status === 'done' ? signedMoney(it.delta_rebate_cents) : '—'}</td>
                <td class="num">${it.events_scanned}</td></tr>`).join('')}
              </tbody>
            </table></div>
          </details>
        </section>`).join('') : '<div class="card card-pad"><div class="empty">暂无任务。调整规则或执行全量对照重算会生成任务。</div></div>'}
    </div>
  `;
  document.getElementById('btn-full').addEventListener('click', setBusy(async () => {
    const res = await api('/api/jobs/full-recompute', { method: 'POST', body: { batches: 200, actor: '演示用户' } });
    toast(res.job ? `全量重算完成：${res.job.done_items} 段` : '没有可重算的期间段', 'ok');
    await renderJobs();
  }));
  document.querySelectorAll('.btn-run').forEach((b) => b.addEventListener('click', setBusy(async () => {
    const r = await api(`/api/jobs/${encodeURIComponent(b.dataset.job)}/run`, { method: 'POST', body: { batches: 1, actor: '演示用户' } });
    toast(r.job ? `已推进 ${r.job.done_items}/${r.job.total_items} 段（本次 ${r.batches.reduce((s, x) => s + x.processed, 0)} 段）` : '下一步完成', 'ok');
    await renderJobs();
  })));
  document.querySelectorAll('.btn-pause').forEach((b) => b.addEventListener('click', setBusy(async () => {
    await api(`/api/jobs/${encodeURIComponent(b.dataset.job)}/pause`, { method: 'POST', body: { actor: '演示用户' } });
    toast('已暂停；已完成的段保持结果', 'info');
    await renderJobs();
  })));
  document.querySelectorAll('.btn-resume').forEach((b) => b.addEventListener('click', setBusy(async () => {
    await api(`/api/jobs/${encodeURIComponent(b.dataset.job)}/resume`, { method: 'POST', body: { actor: '演示用户' } });
    toast('已恢复，将从下一批 pending 段继续', 'ok');
    await renderJobs();
  })));
}

// ---------- 设置 ----------

async function renderSettings() {
  const [settings, consistency, audit] = await Promise.all([
    api('/api/settings'), api('/api/consistency'), api('/api/audit?limit=40'),
  ]);
  main.innerHTML = `
    <div class="page-head">
      <div><h2>设置与审计</h2><p>切换聚合维护策略、核对增量与全量的差异、查看不可篡改审计日志。</p></div>
      <a class="btn" href="/api/export" download="rebate-demo-export.json">导出全部数据（JSON）</a>
    </div>
    <div class="two-col">
      <div class="grid" style="align-content:start">
        <section class="card card-pad">
          <h3 class="section">聚合维护策略</h3>
          <div class="grid cols-2">
            <label class="mini" style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
              <input type="radio" name="strategy" value="incremental" ${settings.strategy === 'incremental' ? 'checked' : ''}>
              <span><strong>增量维护</strong><br><span class="help">事件写入 O(1) 累加 + 重套整段阶梯；规则变更只重算受影响段，复用缓存金额。默认。</span></span>
            </label>
            <label class="mini" style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">
              <input type="radio" name="strategy" value="recompute" ${settings.strategy === 'recompute' ? 'checked' : ''}>
              <span><strong>受影响范围重算</strong><br><span class="help">每次写入重扫该段全部事件；规则变更逐段重扫。更慢，但可独立自证不漂移。</span></span>
            </label>
          </div>
          <p class="help" style="margin:10px 0 0">两种策略共用同一套整段套档函数；一致性与全量重算可用于交叉验证。切换只影响后续写入与任务，不追溯修改已产生的聚合。</p>
        </section>

        <section class="card card-pad">
          <h3 class="section">一致性与口径自检</h3>
          <div class="banner ${consistency.ok ? 'good' : 'bad'}"><div>
            ${consistency.ok ? `已核对 ${consistency.segment_count} 个期间段：存储聚合与“重扫事件从头计算”逐分一致。` : `发现 ${consistency.mismatches.length} 处偏差，需重算修复。`}
          </div></div>
          ${consistency.mismatches.length ? `<div class="table-wrap"><table>
            <thead><tr><th>段</th><th>字段</th><th>存储值</th><th>重算值</th></tr></thead>
            <tbody>${consistency.mismatches.map((m) => `<tr>
              <td>${esc(m.label)}</td><td>${esc(m.fields.join(', '))}</td>
              <td class="num small">${esc(JSON.stringify(m.stored))}</td><td class="num small">${esc(JSON.stringify(m.fresh))}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : ''}
          <div class="toolbar" style="margin-top:10px">
            <button type="button" id="btn-check">重新核对</button>
            <button type="button" class="small" id="btn-full-here">执行全量对照重算</button>
            <span class="muted small">核对时间：${when(consistency.checked_at)}</span>
          </div>
        </section>

        <section class="card card-pad">
          <h3 class="section">策略说明（性能与正确性）</h3>
          <table>
            <thead><tr><th>操作</th><th>增量维护</th><th>受影响范围重算</th></tr></thead>
            <tbody>
              <tr><td>新增一笔采购</td><td>读 1 段聚合 + 重套档，O(实体数)</td><td>重扫该段全部事件</td></tr>
              <tr><td>一笔退货</td><td>更新原期间聚合，O(实体数)</td><td>重扫原期间全部事件</td></tr>
              <tr><td>规则变更</td><td>每段只换费率重算，O(受影响段 × 实体数)</td><td>O(受影响段事件总数)</td></tr>
              <tr><td>供应商归属更正</td><td>重建原/新集团的相关段</td><td>同上，但从事件重扫</td></tr>
            </tbody>
          </table>
          <p class="help" style="margin:10px 0 0">增量路径避免全历史扫描，但必须维护可交换摘要（事件异或）来检测漂移；全量重算作为修复与验证路径。两者不允许产生不同结果。</p>
        </section>
      </div>

      <aside class="card card-pad">
        <h3 class="section">审计日志</h3>
        <ul class="timeline">
          ${audit.audit.map((a) => `
            <li>
              <div class="t">${esc(a.action)} <span class="muted small">${esc(a.entity_type)}</span></div>
              <div class="d small">${esc(a.actor)} · ${esc(String(a.details_json).slice(0, 160))}</div>
              <div class="when">${when(a.created_at)}</div>
            </li>`).join('') || '<li class="muted">暂无审计记录</li>'}
        </ul>
      </aside>
    </div>
  `;
  document.querySelectorAll('input[name=strategy]').forEach((r) => {
    r.addEventListener('change', setBusy(async () => {
      await api('/api/settings/strategy', { method: 'POST', body: { strategy: r.value, actor: '演示用户' } });
      state.strategy = r.value;
      document.querySelectorAll('[data-strategy]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.strategy === r.value)));
      toast(`策略已切换为 ${r.value === 'incremental' ? '增量维护' : '受影响范围重算'}`, 'ok');
      await renderSettings();
    }));
  });
  document.getElementById('btn-check').addEventListener('click', setBusy(async () => {
    await renderSettings();
    toast('已重新核对', 'info');
  }));
  document.getElementById('btn-full-here').addEventListener('click', setBusy(async () => {
    const res = await api('/api/jobs/full-recompute', { method: 'POST', body: { batches: 200, actor: '演示用户' } });
    toast(res.job ? `全量重算完成：${res.job.done_items} 段` : '暂无期间段', 'ok');
    await renderSettings();
  }));
}

// ---------- 顶栏动作 ----------

document.querySelectorAll('[data-strategy]').forEach((b) => {
  b.addEventListener('click', setBusy(async () => {
    await api('/api/settings/strategy', { method: 'POST', body: { strategy: b.dataset.strategy, actor: '演示用户' } });
    state.strategy = b.dataset.strategy;
    document.querySelectorAll('[data-strategy]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.strategy === state.strategy)));
    toast(`策略：${state.strategy === 'incremental' ? '增量维护' : '受影响范围重算'}`, 'ok');
    await render();
  }));
});

document.getElementById('btn-consistency').addEventListener('click', setBusy(async () => {
  const res = await api('/api/consistency');
  if (res.ok) toast(`一致性通过：${res.segment_count} 段与全量重算逐分一致`, 'ok');
  else toast(`发现 ${res.mismatches.length} 处偏差，请到设置页查看`, 'err', 7000);
  if (currentRoute().name === 'settings') await renderSettings();
}));

// ---------- 启动 ----------

(async function boot() {
  try {
    await loadBootstrap();
    if (!location.hash) location.hash = '#/overview';
    await render();
  } catch (err) {
    main.innerHTML = `<div class="banner bad"><div><strong>无法连接服务</strong><br>${esc(err.message)}</div></div>`;
  }
})();

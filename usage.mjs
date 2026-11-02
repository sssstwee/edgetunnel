const API = 'https://api.cloudflare.com/client/v4';
const ACTIVE_STATES = new Set(['Paid', 'Provisioned', 'Trial', 'AwaitingPayment']);

export function subscriptionPlan(subscriptions, now = new Date()) {
  const workers = subscriptions.filter((subscription) => {
    const rate = subscription.rate_plan || {};
    return /workers/i.test([rate.id, rate.public_name, rate.scope, ...(rate.sets || [])].join(' '));
  });
  const active = workers.find((subscription) => ACTIVE_STATES.has(subscription.state));
  if (!active && workers.some((subscription) => subscription.state === 'Cancelled' && new Date(subscription.current_period_end) > now)) {
    throw new Error('套餐取消状态尚待确认');
  }
  if (!active || /\bfree\b/i.test(active.rate_plan?.public_name || active.rate_plan?.id || '')) {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return { plan: 'free', planName: 'Workers Free', period: 'day', max: 100000, periodStart: start.toISOString(), periodEnd: new Date(+start + 86400000).toISOString() };
  }
  const name = active.rate_plan?.public_name || '';
  if (active.rate_plan?.is_contract || /enterprise|bundled|unbound|platforms/i.test(name + ' ' + active.rate_plan?.id)
    || !(/workers[_ ](paid|standard)/i.test(name + ' ' + active.rate_plan?.id))) {
    throw new Error('该套餐需要按合同确认额度');
  }
  const start = new Date(active.current_period_start);
  const end = new Date(active.current_period_end);
  if (!(start <= now && now < end)) throw new Error('套餐账期无效');
  return { plan: 'paid', planName: 'Workers Paid', period: 'billing', max: 10000000, periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

async function apiJSON(url, headers, options = {}) {
  const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Object.assign(new Error(`Cloudflare HTTP ${response.status}`), { status: response.status });
  const body = await response.json();
  if (body.success === false || body.errors?.length) throw new Error('Cloudflare 查询失败');
  return body;
}

export async function readUsage(credentials, dailyUsage = {}) {
  const { AccountID, APIToken, Email, GlobalAPIKey } = credentials;
  const fallback = {
    ...dailyUsage,
    plan: 'unknown', planName: '套餐未识别', period: 'day', max: null,
    planError: '无法读取套餐，请为统计令牌添加当前账户的 Billing Read 权限。',
  };
  if (!AccountID || !(APIToken || (Email && GlobalAPIKey))) return fallback;
  const headers = APIToken
    ? { Authorization: `Bearer ${APIToken}`, 'Content-Type': 'application/json' }
    : { 'X-Auth-Email': Email, 'X-Auth-Key': GlobalAPIKey, 'Content-Type': 'application/json' };
  const now = new Date();
  let plan;
  try {
    const subscriptions = [];
    for (let page = 1; page <= 20; page += 1) {
      const result = await apiJSON(`${API}/accounts/${AccountID}/subscriptions?per_page=50&page=${page}`, headers);
      if (!Array.isArray(result.result)) throw new Error('套餐响应无效');
      subscriptions.push(...result.result);
      if (page >= (result.result_info?.total_pages || 1)) break;
      if (page === 20) throw new Error('套餐列表未完整读取');
    }
    plan = subscriptionPlan(subscriptions, now);
  } catch (error) {
    return { ...fallback, planError: error.status === 401 || error.status === 403
      ? fallback.planError : '套餐或账期读取失败，请稍后重试。' };
  }
  try {
    const result = await apiJSON(`${API}/graphql`, headers, {
      method: 'POST',
      body: JSON.stringify({
        query: `query getPlanUsage($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
          viewer { accounts(filter: {accountTag: $AccountID}) {
            pagesFunctionsInvocationsAdaptiveGroups(limit: 1, filter: $filter) { sum { requests } }
            workersInvocationsAdaptive(limit: 1, filter: $filter) { sum { requests } }
          } }
        }`,
        variables: { AccountID, filter: { datetime_geq: plan.periodStart, datetime_leq: now.toISOString() } },
      }),
    });
    const account = result.data?.viewer?.accounts?.[0];
    if (!account) throw new Error('统计响应无效');
    const sum = (groups) => groups?.reduce((total, group) => total + (group.sum?.requests || 0), 0) || 0;
    const workers = sum(account.workersInvocationsAdaptive);
    const pages = sum(account.pagesFunctionsInvocationsAdaptiveGroups);
    return { success: true, ...plan, workers, pages, total: workers + pages, updatedAt: now.toISOString() };
  } catch {
    return { success: false, ...plan, workers: null, pages: null, total: null, planError: '本账期用量读取失败，请稍后重试。' };
  }
}

// Serialized into the existing admin page; it only refreshes this usage module.
export function installUsagePanel() {
  const module = document.getElementById('cfUsageModule');
  if (!module) return;
  const text = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  const number = (value) => Number.isFinite(value) ? value.toLocaleString() : '—';
  function render(usage) {
    module.style.display = 'block';
    module.classList.remove('cf-usage-module');
    const paid = usage.plan === 'paid';
    const known = usage.plan === 'free' || paid;
    const complete = known && usage.success && Number.isFinite(usage.total);
    const title = module.querySelector('.module-title');
    const titleText = title && Array.from(title.childNodes).find((node) => node.nodeType === 3);
    if (titleText) titleText.textContent = ` ${usage.planName || '套餐未识别'} · ${paid ? '本账期' : '今日'}请求用量（估算） `;
    text('cfWorkerCount', number(usage.workers));
    text('cfPagesCount', number(usage.pages));
    text('cfDailyQuota', number(usage.max));
    const quotaLabel = document.getElementById('cfDailyQuota')?.parentElement.querySelector('.cf-stat-label');
    if (quotaLabel) quotaLabel.textContent = paid ? '本账期包含请求' : known ? '每日免费限额' : '套餐额度未知';
    const workerRatio = complete ? Math.min(100, usage.workers / usage.max * 100) : 0;
    const pagesRatio = complete ? Math.min(100 - workerRatio, usage.pages / usage.max * 100) : 0;
    const workerBar = document.getElementById('cfWorkerBar');
    const pagesBar = document.getElementById('cfPagesBar');
    if (workerBar) workerBar.style.width = `${workerRatio}%`;
    if (pagesBar) { pagesBar.style.width = `${pagesRatio}%`; pagesBar.style.left = `${workerRatio}%`; }
    text('cfPercentageCenter', complete
      ? `${paid ? '包含额度剩余' : '预计剩余'}：${number(Math.max(0, usage.max - usage.total))} 次（已用 ${(usage.total / usage.max * 100).toFixed(2)}%）`
      : usage.planError || '用量读取失败，请稍后重试');
    const info = module.querySelector('.cf-info-text');
    if (info) {
      info.style.whiteSpace = 'normal';
      info.style.minWidth = '0';
      const date = (value) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      const period = known ? `${paid ? '账期' : '统计日'}：${date(usage.periodStart)} 至 ${date(usage.periodEnd)}（北京时间）。` : '';
      const billing = paid ? '每账期包含 1,000 万次请求，超出按量计费，没有每日 10 万次上限。' : '';
      info.textContent = `${period}${billing}${usage.planError || ''} ${paid ? '本账期' : '今日'}合计：${number(usage.total)}。账户共享额度；统计可能延迟；每 60 秒自动更新。${usage.updatedAt ? ` 最近更新：${date(usage.updatedAt)}。` : ''}`;
    }
  }
  window.updateCFUsageDisplay = render;
  render({ plan: 'unknown', planName: '正在读取当前套餐', planError: '正在读取套餐与用量…' });
  let pending = false;
  async function refresh() {
    if (document.hidden || pending) return;
    pending = true;
    try {
      const response = await fetch('/admin/usage.json', { cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
      render(await response.json());
    } catch {
      render({ plan: 'unknown', planName: '套餐与用量暂不可用', planError: '更新失败，请检查登录状态或稍后重试。' });
    } finally { pending = false; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh, { once: true });
  else void refresh();
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
}

export function createUsageWorker(original) {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const usageOnly = url.pathname === '/admin/usage.json';
      const config = url.pathname === '/admin/config.json';
      const admin = url.pathname === '/admin' || url.pathname === '/admin/';
      if (request.method !== 'GET' || !(usageOnly || config || admin)) return original.fetch(request, env, ctx);
      // Delegate authentication and all proxy/subscription behavior to the installed Worker.
      if (usageOnly) url.pathname = '/admin/config.json';
      const response = await original.fetch(usageOnly ? new Request(url, request) : request, env, ctx);
      if (response.status !== 200) return response;
      const type = response.headers.get('content-type') || '';
      if ((config || usageOnly) && type.includes('application/json')) {
        const body = await response.json();
        if (!body.CF) return Response.json(body, { status: response.status, headers: response.headers });
        let credentials = {};
        try { credentials = JSON.parse(await env.KV.get('cf.json') || '{}'); } catch { /* Surface an unknown plan. */ }
        const usage = await readUsage(credentials, body.CF.Usage);
        body.CF.Usage = usage;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.delete('etag');
        headers.set('cache-control', 'no-store');
        return Response.json(usageOnly ? usage : body, { headers });
      }
      if (admin && type.includes('text/html')) {
        const script = `<script>(${installUsagePanel.toString()})();</script>`;
        const transformed = new HTMLRewriter().on('body', { element(element) { element.append(script, { html: true }); } }).transform(response);
        transformed.headers.set('cache-control', 'no-store');
        transformed.headers.delete('etag');
        return transformed;
      }
      return response;
    },
  };
}

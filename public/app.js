'use strict';

const $ = (id) => document.getElementById(id);
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
const TOKEN_KEY = 'direp_token';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/login')) {
    setToken('');
    showScreen('login');
  }
  if (!res.ok) throw new Error(data.error || 'خطا در ارتباط با سرور');
  return data;
}

/** Wrap a form/button handler: disable while busy, show errors as a toast. */
function action(fn) {
  return async (event) => {
    event?.preventDefault?.();
    const button = event?.submitter || event?.currentTarget;
    if (button && 'disabled' in button) button.disabled = true;
    try { await fn(event); } catch (err) { toast(err.message, true); }
    finally { if (button && 'disabled' in button) button.disabled = false; }
  };
}

/** Build DOM nodes without innerHTML so customer text can never inject markup. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function showScreen(name) {
  for (const s of ['setup', 'login', 'app']) $(`screen-${s}`).hidden = s !== name;
}

// ---------- auth ----------
$('form-setup').addEventListener('submit', action(async () => {
  const { token } = await api('/setup', {
    method: 'POST',
    body: { name: $('setup-name').value, phone: $('setup-phone').value, password: $('setup-password').value },
  });
  setToken(token);
  await openApp();
}));

$('form-login').addEventListener('submit', action(async () => {
  const { token } = await api('/login', {
    method: 'POST',
    body: { phone: $('login-phone').value, password: $('login-password').value },
  });
  setToken(token);
  await openApp();
}));

$('btn-logout').addEventListener('click', action(async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  setToken('');
  showScreen('login');
}));

// ---------- tabs ----------
const loaders = {};
$('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('button')?.dataset.tab;
  if (!tab) return;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  loaders[tab]?.().catch((err) => toast(err.message, true));
});

// ---------- settings & connect ----------
let settings = null;
const INTENT_LABELS = {
  PRICE_INQUIRY: 'سؤال قیمت (این پیام پیگیری سبد خرید را هم شروع می‌کند)',
  SIZE_INQUIRY: 'سؤال سایز و رنگ',
  ORDER_TRACKING: 'پیگیری سفارش',
  PAYMENT_RECEIPT: 'ارسال رسید پرداخت',
  COMPLAINT: 'شکایت (به شما هم هشدار داده می‌شود)',
  GENERAL: 'پیام‌های دیگر (پیش‌فرض: بدون پاسخ)',
};

async function loadSettings() {
  settings = await api('/settings');
  $('page-name').textContent = settings.pageUsername ? `@${settings.pageUsername}` : '';
  $('key-hint').textContent = settings.boxApiKeyHint || 'ثبت نشده';
  $('webhook-url').value = settings.webhookUrl;
  $('secret-state').textContent = settings.hasWebhookSecret ? 'فعال ✅' : 'غیرفعال (فقط کلید داخل آدرس)';
  $('step-key').classList.toggle('done', Boolean(settings.boxApiKeyHint));
  $('step-page').classList.toggle('done', Boolean(settings.accountId));
  $('step-hook').classList.toggle('done', Boolean(settings.accountId));
  $('owner-line').textContent = settings.owner ? `${settings.owner.name} · ${settings.owner.phone}` : '';
  $('follow-event').textContent = settings.lastFollowEvent || 'هنوز دریافت نشده';

  $('auto-reply-enabled').checked = settings.autoReplyEnabled;
  renderReplies();

  $('recovery-enabled').checked = settings.recoveryEnabled;
  $('discount-code').value = settings.discountCode;
  $('payment-link').value = settings.paymentLink;
  $('step1-text').value = settings.recoveryStep1Text;
  $('step2-text').value = settings.recoveryStep2Text;

  $('alert-channel').value = settings.alertChannel;
  $('alert-chat').value = settings.alertChatId;
  $('token-state').textContent = settings.hasAlertToken ? '(ذخیره شده؛ برای تغییر دوباره وارد کنید)' : '';
}

async function loadStats() {
  const s = await api('/stats');
  $('st-rules').textContent = fa(s.activeRules);
  $('st-contacts').textContent = fa(s.contacts);
  $('st-pending').textContent = fa(s.inquiriesPending);
  $('st-paid').textContent = fa(s.inquiriesPaid);
  $('step-rule').classList.toggle('done', s.activeRules > 0);
}

$('form-key').addEventListener('submit', action(async () => {
  const key = $('boxapi-key').value.trim();
  if (!key) throw new Error('کلید را وارد کنید');
  await api('/settings', { method: 'PUT', body: { boxApiKey: key } });
  $('boxapi-key').value = '';
  await loadSettings();
  await checkBoxApi();
}));

async function checkBoxApi() {
  const data = await api('/boxapi/check', { method: 'POST' });
  $('boxapi-result').hidden = false;
  const plan = data.plan;
  $('plan-line').textContent = plan?.name
    ? `پلن BoxAPI: ${plan.name}${plan.account_limit ? ` · ظرفیت ${fa(plan.account_limit)} پیج` : ''}`
    : 'اتصال به BoxAPI برقرار است.';
  const link = $('connect-link');
  link.hidden = !data.connectUrl;
  if (data.connectUrl) link.href = data.connectUrl;

  const box = $('accounts');
  box.replaceChildren();
  if (!data.accounts.length) {
    box.append(el('p', { class: 'muted' }, 'هنوز پیجی در BoxAPI وصل نشده. با دکمه پایین، پیج را با ورود رسمی اینستاگرام وصل کنید و دوباره «بررسی» را بزنید.'));
    return;
  }
  for (const a of data.accounts) {
    const selected = settings?.accountId === a.id;
    box.append(el('div', { class: 'rule' },
      el('div', {},
        el('b', { class: 'ltr' }, `@${a.username}`), ' ',
        el('span', { class: `badge ${a.isActive ? 'ok' : 'bad'}` }, a.isActive ? 'فعال' : 'غیرفعال'),
        a.expiresAt ? el('div', { class: 'muted' }, `اعتبار تا ${new Date(a.expiresAt).toLocaleDateString('fa-IR')}`) : null),
      selected
        ? el('span', { class: 'badge ok' }, 'انتخاب شده')
        : el('button', { class: 'btn small', type: 'button', onclick: action(async () => {
            await api('/page', { method: 'POST', body: { accountId: a.id } });
            toast(`پیج @${a.username} انتخاب شد`);
            await loadSettings();
            await checkBoxApi();
          }) }, 'انتخاب این پیج')));
  }
}
$('btn-check').addEventListener('click', action(checkBoxApi));

$('btn-copy-hook').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('webhook-url').value); toast('کپی شد'); }
  catch { $('webhook-url').select(); }
});

$('form-secret').addEventListener('submit', action(async () => {
  await api('/settings', { method: 'PUT', body: { webhookSecret: $('webhook-secret').value.trim() } });
  $('webhook-secret').value = '';
  toast('ذخیره شد');
  await loadSettings();
}));
$('btn-clear-secret').addEventListener('click', action(async () => {
  await api('/settings', { method: 'PUT', body: { webhookSecret: '' } });
  toast('Secret حذف شد');
  await loadSettings();
}));

// ---------- rules ----------
const PRESETS = {
  clothing: { keyword: 'قیمت، خرید، سایز', dm: 'سلام! قیمت و سایزبندی این مدل رو از لینک زیر ببینید. ارسال به سراسر ایران داریم 🚚', btn: 'مشاهده و خرید' },
  cafe: { keyword: 'منو، قیمت، سفارش', dm: 'سلام! منوی کامل و قیمت‌ها رو از لینک زیر ببینید. برای سفارش هم همین‌جا پیام بدید ☕', btn: 'منو' },
  course: { keyword: 'ثبت نام، قیمت، دوره', dm: 'سلام! سرفصل‌ها، قیمت و ظرفیت دوره رو از لینک زیر ببینید 🎓', btn: 'ثبت‌نام' },
};

document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const p = PRESETS[b.dataset.preset];
  $('rule-keyword').value = p.keyword;
  $('rule-dm').value = p.dm;
  $('rule-btn-title').value = p.btn;
}));

$('rule-follow').addEventListener('change', () => ($('rule-unfollowed-wrap').hidden = !$('rule-follow').checked));

function resetRuleForm() {
  $('form-rule').reset();
  $('rule-id').value = '';
  $('rule-form-title').textContent = 'قانون جدید';
  $('rule-unfollowed-wrap').hidden = true;
}
$('btn-rule-reset').addEventListener('click', resetRuleForm);

function editRule(r) {
  $('rule-id').value = r.id;
  $('rule-keyword').value = r.keyword;
  $('rule-match').value = r.matchType;
  $('rule-replies').value = r.commentReplies.join('\n');
  $('rule-dm').value = r.dmText;
  $('rule-btn-title').value = r.buttonTitle || '';
  $('rule-btn-url').value = r.buttonUrl || '';
  $('rule-follow').checked = r.requireFollow;
  $('rule-unfollowed').value = r.unfollowedDm || '';
  $('rule-unfollowed-wrap').hidden = !r.requireFollow;
  $('rule-form-title').textContent = 'ویرایش قانون';
  $('form-rule').scrollIntoView({ behavior: 'smooth' });
}

async function loadRules() {
  const rules = await api('/rules');
  const list = $('rules-list');
  list.replaceChildren();
  if (!rules.length) list.append(el('p', { class: 'muted' }, 'هنوز قانونی ندارید.'));
  for (const r of rules) {
    list.append(el('div', { class: 'rule' },
      el('div', {},
        el('b', {}, r.matchType === 'ANY' ? 'همه کامنت‌ها' : `«${r.keyword}»`), ' ',
        r.requireFollow ? el('span', { class: 'badge' }, 'Follow-Gate') : null, ' ',
        el('span', { class: `badge ${r.isActive ? 'ok' : 'gray'}` }, r.isActive ? 'فعال' : 'خاموش'),
        el('div', { class: 'dm' }, r.dmText)),
      el('div', { class: 'row', style: 'margin-top:0;flex-wrap:nowrap' },
        el('button', { class: 'btn ghost small', type: 'button', onclick: () => editRule(r) }, 'ویرایش'),
        el('button', { class: 'btn ghost small', type: 'button', onclick: action(async () => {
          await api(`/rules/${r.id}/toggle`, { method: 'POST' }); await loadRules(); await loadStats();
        }) }, r.isActive ? 'خاموش' : 'روشن'),
        el('button', { class: 'btn danger small', type: 'button', onclick: action(async () => {
          if (!confirm('این قانون حذف شود؟')) return;
          await api(`/rules/${r.id}`, { method: 'DELETE' }); await loadRules(); await loadStats();
        }) }, 'حذف'))));
  }
}
loaders.rules = loadRules;

$('form-rule').addEventListener('submit', action(async () => {
  const id = $('rule-id').value;
  const body = {
    keyword: $('rule-keyword').value,
    matchType: $('rule-match').value,
    commentReplies: $('rule-replies').value.split('\n'),
    dmText: $('rule-dm').value,
    buttonTitle: $('rule-btn-title').value,
    buttonUrl: $('rule-btn-url').value,
    requireFollow: $('rule-follow').checked,
    unfollowedDm: $('rule-unfollowed').value,
  };
  await api(id ? `/rules/${id}` : '/rules', { method: id ? 'PUT' : 'POST', body });
  toast('قانون ذخیره شد');
  resetRuleForm();
  await loadRules();
  await loadStats();
}));

// ---------- auto replies ----------
function renderReplies() {
  const box = $('replies-list');
  box.replaceChildren();
  for (const [intent, label] of Object.entries(INTENT_LABELS)) {
    const r = settings.replies[intent];
    box.append(el('div', { style: 'margin-top:14px' },
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', 'data-intent-on': intent, checked: r.enabled ? 'checked' : null }), label),
      el('textarea', { 'data-intent-text': intent }, r.text)));
  }
}

$('form-replies').addEventListener('submit', action(async () => {
  const replies = {};
  for (const intent of Object.keys(INTENT_LABELS)) {
    const on = document.querySelector(`[data-intent-on="${intent}"]`).checked;
    const text = document.querySelector(`[data-intent-text="${intent}"]`).value.trim();
    replies[intent] = on && text ? { text } : { enabled: false };
  }
  await api('/settings', { method: 'PUT', body: { autoReplyEnabled: $('auto-reply-enabled').checked, replies } });
  toast('ذخیره شد');
  await loadSettings();
}));

// ---------- recovery ----------
const STATUS = {
  PENDING: ['در جریان', 'warn'], DONE: ['ارسال کامل', 'gray'], PAID: ['پرداخت شد', 'ok'],
  CANCELLED: ['لغو', 'gray'], EXPIRED: ['خارج از ۲۴ ساعت', 'gray'],
};

async function loadInquiries() {
  const rows = await api('/inquiries');
  const body = $('inquiries-body');
  body.replaceChildren();
  if (!rows.length) body.append(el('tr', {}, el('td', { colspan: 5, class: 'muted' }, 'هنوز موردی نیست.')));
  for (const i of rows) {
    const [label, tone] = STATUS[i.status] || [i.status, 'gray'];
    body.append(el('tr', {},
      el('td', { class: 'ltr' }, i.recipientId),
      el('td', {}, el('span', { class: `badge ${tone}` }, label)),
      el('td', {}, i.status === 'PENDING' && i.nextDueAt
        ? `مرحله ${fa(i.nextStep)} · ${new Date(i.nextDueAt).toLocaleString('fa-IR', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`
        : '-'),
      el('td', {}, new Date(i.createdAt).toLocaleString('fa-IR', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })),
      el('td', {}, i.status === 'PENDING' ? el('div', { class: 'row', style: 'margin-top:0' },
        el('button', { class: 'btn small', type: 'button', onclick: action(async () => {
          await api(`/inquiries/${encodeURIComponent(i.recipientId)}/close`, { method: 'POST', body: { status: 'PAID' } });
          await loadInquiries(); await loadStats();
        }) }, 'خرید کرد'),
        el('button', { class: 'btn ghost small', type: 'button', onclick: action(async () => {
          await api(`/inquiries/${encodeURIComponent(i.recipientId)}/close`, { method: 'POST', body: { status: 'CANCELLED' } });
          await loadInquiries(); await loadStats();
        }) }, 'توقف')) : null)));
  }
}
loaders.recovery = loadInquiries;

$('form-recovery').addEventListener('submit', action(async () => {
  await api('/settings', {
    method: 'PUT',
    body: {
      recoveryEnabled: $('recovery-enabled').checked,
      discountCode: $('discount-code').value.trim(),
      paymentLink: $('payment-link').value.trim(),
      recoveryStep1Text: $('step1-text').value,
      recoveryStep2Text: $('step2-text').value,
    },
  });
  toast('ذخیره شد');
}));

// ---------- contacts ----------
const STAGES = { NEW: ['جدید', 'gray'], INQUIRY: ['پرسیده قیمت', 'warn'], PAID: ['خریدار', 'ok'], COMPLAINT: ['شکایت', 'bad'] };

async function loadContacts() {
  const rows = await api('/contacts');
  const body = $('contacts-body');
  body.replaceChildren();
  if (!rows.length) body.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'هنوز مشتری‌ای ثبت نشده.')));
  for (const c of rows) {
    const [label, tone] = STAGES[c.stage] || [c.stage, 'gray'];
    body.append(el('tr', {},
      el('td', { class: 'ltr' }, c.username ? `@${c.username}` : c.igUserId),
      el('td', { class: 'ltr' }, c.phone || '-'),
      el('td', {}, el('span', { class: `badge ${tone}` }, label)),
      el('td', {}, fa(c.totalOrders)),
      el('td', {}, c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString('fa-IR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'),
      el('td', {}, el('button', { class: 'btn ghost small', type: 'button', onclick: action(async () => {
        const message = prompt('متن دایرکت (فقط تا ۲۴ ساعت بعد از آخرین پیام مشتری ارسال می‌شود):');
        if (!message) return;
        await api(`/contacts/${encodeURIComponent(c.igUserId)}/dm`, { method: 'POST', body: { message } });
        toast('ارسال شد');
      }) }, 'دایرکت'))));
  }
}
loaders.contacts = loadContacts;

// ---------- posts ----------
async function loadPosts() {
  const posts = await api('/posts');
  const box = $('posts');
  box.replaceChildren();
  if (!posts.length) box.append(el('p', { class: 'muted' }, 'هنوز پستی دریافت نشده.'));
  for (const p of posts) {
    const safeUrl = /^https:\/\//.test(p.media_url || '') ? p.media_url : null;
    const link = /^https:\/\//.test(p.permalink || '') ? p.permalink : null;
    box.append(el(link ? 'a' : 'div', { class: 'post', href: link, target: '_blank', rel: 'noopener' },
      safeUrl ? el('img', { src: safeUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('img', { alt: '' }),
      el('div', {}, p.caption || '')));
  }
}
loaders.posts = loadPosts;
$('btn-sync').addEventListener('click', action(async () => {
  await api('/posts/sync', { method: 'POST' });
  toast('درخواست ارسال شد؛ چند ثانیه بعد تازه کنید');
  setTimeout(() => loadPosts().catch(() => {}), 5000);
}));

// ---------- alerts ----------
$('form-alerts').addEventListener('submit', action(async () => {
  const body = { alertChannel: $('alert-channel').value, alertChatId: $('alert-chat').value.trim() };
  if ($('alert-token').value.trim()) body.alertBotToken = $('alert-token').value.trim();
  await api('/settings', { method: 'PUT', body });
  $('alert-token').value = '';
  toast('ذخیره شد');
  await loadSettings();
}));
$('btn-alert-test').addEventListener('click', action(async () => {
  await api('/alerts/test', {
    method: 'POST',
    body: { channel: $('alert-channel').value, botToken: $('alert-token').value.trim(), chatId: $('alert-chat').value.trim() },
  });
  toast('پیام تست ارسال شد ✅');
}));

// ---------- account ----------
$('form-password').addEventListener('submit', action(async () => {
  const { token } = await api('/password', { method: 'POST', body: { current: $('pw-current').value, next: $('pw-next').value } });
  setToken(token);
  $('form-password').reset();
  toast('رمز عبور تغییر کرد');
}));

// ---------- boot ----------
async function openApp() {
  showScreen('app');
  await Promise.all([loadSettings(), loadStats()]);
  if (settings.boxApiKeyHint) checkBoxApi().catch(() => {});
}

(async function boot() {
  try {
    const status = await fetch('/api/status').then((r) => r.json());
    $('dry-run').hidden = !status.dryRun;
    if (!status.setupDone) return showScreen('setup');
    if (!getToken()) return showScreen('login');
    await openApp();
  } catch (err) {
    toast(err.message, true);
    showScreen('login');
  }
})();

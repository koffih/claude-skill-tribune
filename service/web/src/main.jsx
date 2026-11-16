import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dict } from './i18n.js';
import './styles.css';

// ---------- context: site, base path, embed mode, session ----------

const BASE = window.TRIBUNE_BASE || '';
const parts = location.pathname.slice(BASE.length).split('/').filter(Boolean); // s, site, ...
const SITE = parts[1];
const params = new URLSearchParams(location.search);
const EMBED = params.get('embed') === '1';
const API = `${BASE}/api/v1/sites/${SITE}`;
const KEY = `tribune:${SITE}`;

const store = {
  get() { try { return (EMBED ? sessionStorage : localStorage).getItem(KEY); } catch { return mem; } },
  set(v) { mem = v; try { const s = EMBED ? sessionStorage : localStorage; v ? s.setItem(KEY, v) : s.removeItem(KEY); } catch { /* private mode */ } },
};
let mem = null;

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  const t = store.get();
  if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (j === null) { const e = new Error(`HTTP ${r.status}`); e.code = r.ok ? 'bad_response' : 'server_error'; e.status = r.status; throw e; }
  if (r.status === 401 && t && !path.startsWith('/auth')) store.set(null);
  if (!r.ok) { const e = new Error(j.message || j.error || r.statusText); e.code = j.error; e.status = r.status; e.extra = j; throw e; }
  return j;
}

const link = (p) => `${BASE}/s/${SITE}/${p}${EMBED ? (p.includes('?') ? '&' : '?') + 'embed=1' : ''}`;
function go(p, replace) { history[replace ? 'replaceState' : 'pushState'](null, '', link(p)); dispatchEvent(new Event('tribune:nav')); }
function useRoute() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    addEventListener('popstate', f); addEventListener('tribune:nav', f);
    return () => { removeEventListener('popstate', f); removeEventListener('tribune:nav', f); };
  }, []);
  return location.pathname.slice(BASE.length).split('/').filter(Boolean).slice(2);
}
function A({ to, children, ...rest }) {
  return <a href={link(to)} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(to); scrollTo(0, 0); }} {...rest}>{children}</a>;
}

// Every screen load goes through this: a failure shows a message and a retry
// button instead of a skeleton that never ends.
function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ data: s.data, error: null }));
    fn().then((data) => live && setState({ data, error: null })).catch((error) => live && setState({ data: null, error }));
    return () => { live = false; };
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}
function Failed({ ctx, error, retry }) {
  const t = ctx.t;
  return <div class="card" role="alert"><p class="error">{error.status === 404 ? t.not_found : t[error.code] || t.error}</p>
    <button class="btn ghost sm" onClick={retry}>{t.retry}</button></div>;
}
addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast({ en: 'Something went wrong.', es: 'Se produjo un error.' }[document.documentElement.lang] || 'Une erreur est survenue.'); });
function toast(m) {
  const el = document.createElement('div');
  el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = m;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3500);
}

const fmtDate = (d, loc) => new Date(d).toLocaleDateString({ fr: 'fr-CA', en: 'en-CA', es: 'es' }[loc] || 'fr-CA', { year: 'numeric', month: 'short', day: 'numeric' });
// Labels set per site may lack a language: Spanish falls back to English, the others to French.
const L = (obj, loc) => (obj && (obj[loc] || (loc === 'es' ? obj.en || obj.fr : obj.fr || obj.en))) || '';

// ---------- app ----------

function App() {
  const route = useRoute();
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((x) => x + 1);

  // Embed mode: the host page hands over its signed token through postMessage.
  useEffect(() => {
    if (!EMBED) return;
    const onMsg = async (e) => {
      if (e.source !== parent || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'tribune:identify' && e.data.token) {
        try { const r = await api('POST', '/auth/identify', { token: e.data.token }); store.set(r.token); reload(); }
        catch (x) { console.warn('[tribune] identify failed', x.code); toast(x.code === 'token_expired' ? 'Session expirée, rechargez la page. / Session expired, reload the page.' : 'Connexion impossible. / Could not sign you in.'); }
      }
      if (e.data.type === 'tribune:logout') { store.set(null); reload(); }
      if (e.data.type === 'tribune:open' && e.data.view) go(e.data.view);
    };
    addEventListener('message', onMsg);
    parent.postMessage({ type: 'tribune:ready' }, '*');
    return () => removeEventListener('message', onMsg);
  }, []);

  // Portal opened from the host site with ?sso=<jwt>: one hop, then the token is gone from the URL.
  useEffect(() => {
    const sso = params.get('sso');
    if (!sso) return;
    params.delete('sso');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
    api('POST', '/auth/identify', { token: sso }).then((r) => { store.set(r.token); reload(); })
      .catch(() => toast('Lien de connexion expiré ou invalide. / Sign-in link expired or invalid.'));
  }, []);

  useEffect(() => {
    api('GET', '/config').then((c) => { setCfg(c); setErr(null); }).catch((e) => setErr(e));
  }, [tick]);

  if (err) return <div class="page"><p class="error">{err.code === 'site_not_found' ? 'Site introuvable / Site not found' : String(err.message)}</p></div>;
  if (!cfg) return <div class="page"><div class="skeleton" /></div>;

  const asked = params.get('lang');
  const loc = ['fr', 'en', 'es'].includes(asked) ? asked : cfg.me?.locale || cfg.site.default_locale || 'fr';
  const t = dict[loc];
  document.documentElement.lang = loc;
  document.title = `${t.ideas} · ${cfg.site.name}`;
  if (cfg.site.primary_color) document.documentElement.style.setProperty('--accent', cfg.site.primary_color);
  const ctx = { cfg, t, loc, reload, me: cfg.me, team: cfg.me && cfg.me.role !== 'user' };

  const [head, a1, a2] = route;
  let view;
  if (head === 'p' && a1) view = <PostView ctx={ctx} number={Number(a1)} />;
  else if (head === 'roadmap') view = <RoadmapView ctx={ctx} />;
  else if (head === 'changelog') view = <ChangelogView ctx={ctx} />;
  else if (head === 'auth') view = <AuthView ctx={ctx} />;
  else if (head === 'admin') view = ctx.team ? <AdminView ctx={ctx} tab={a1 || 'backlog'} /> : <SignIn ctx={ctx} note={t.team_only} />;
  else view = <BoardView ctx={ctx} slug={head === 'b' ? a1 : cfg.boards[0]?.slug} key={a1 || 'home'} />;
  void a2;

  return (
    <div class={EMBED ? 'embed' : ''}>
      <Header ctx={ctx} route={route} />
      <main class="page">{view}</main>
      {!EMBED && <footer class="foot">{t.powered} · {cfg.site.name}{cfg.site.home_url && <> · <a href={cfg.site.home_url}>{new URL(cfg.site.home_url).host}</a></>}</footer>}
    </div>
  );
}

function Header({ ctx, route }) {
  const { cfg, t, team, me } = ctx;
  const [open, setOpen] = useState(false);
  const cur = route[0] || 'b';
  return (
    <header class="top">
      <div class="top-in">
        <div class="brand">
          {cfg.site.logo_url && <img src={cfg.site.logo_url} alt="" />}
          <span>{cfg.site.name}</span>
        </div>
        <nav aria-label="Navigation">
          <A to="" class={cur === 'b' || cur === 'p' ? 'on' : ''}>{t.ideas}</A>
          <A to="roadmap" class={cur === 'roadmap' ? 'on' : ''}>{t.roadmap}</A>
          <A to="changelog" class={cur === 'changelog' ? 'on' : ''}>{t.changelog}</A>
          {team && <A to="admin" class={cur === 'admin' ? 'on' : ''}>{t.admin}</A>}
        </nav>
        <div class="who">
          {me && <button class="icon-btn" aria-label={t.notifications} onClick={() => setOpen(!open)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
            {cfg.unread > 0 && <span class="dot">{cfg.unread}</span>}
          </button>}
          {me ? <span class="me" title={me.email || ''}>{me.name}</span> : !EMBED && <A to="auth" class="btn ghost sm">{t.sign_in}</A>}
          {EMBED && <button class="icon-btn" aria-label={t.close} onClick={() => parent.postMessage({ type: 'tribune:close' }, '*')}>✕</button>}
        </div>
      </div>
      {open && <Notifications ctx={ctx} onClose={() => setOpen(false)} />}
    </header>
  );
}

function Notifications({ ctx, onClose }) {
  const { t } = ctx;
  const { data, error, reload } = useLoad(() => api('GET', '/me/notifications'), []);
  const list = data?.notifications;
  const readAll = async () => { try { await api('POST', '/me/notifications/read'); ctx.reload(); onClose(); } catch (x) { alertMsg(ctx, x); } };
  return (
    <div class="notif" role="dialog" aria-label={t.notifications}>
      <div class="row between"><strong>{t.notifications}</strong><button class="link" onClick={readAll}>{t.mark_read}</button></div>
      {error ? <Failed ctx={ctx} error={error} retry={reload} /> : !list ? <div class="skeleton" /> : !list.length ? <p class="muted">{t.no_notif}</p> :
        <ul>{list.map((n) => <li class={n.read_at ? '' : 'unread'}>
          <A to={`p/${n.payload.number}`} onClick={onClose}>{(t[`n_${n.type}`] || ((p) => p.title))(n.payload)}</A>
          {n.payload.message && <div class="msg">{n.payload.message}</div>}
        </li>)}</ul>}
    </div>
  );
}

// ---------- board ----------

function BoardView({ ctx, slug }) {
  const { cfg, t, loc, me } = ctx;
  const board = cfg.boards.find((b) => b.slug === slug) || cfg.boards[0];
  const [sort, setSort] = useState('trending');
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [retryN, setRetryN] = useState(0);
  const [writing, setWriting] = useState(false);
  const qd = useDebounced(q, 250);

  useEffect(() => { setPage(1); }, [sort, status, mine, qd, slug]);
  useEffect(() => {
    if (!board) return;
    const p = new URLSearchParams({ sort, page: String(page) });
    if (status) p.set('status', status); if (mine) p.set('mine', mine); if (qd.trim()) p.set('q', qd.trim());
    setLoadErr(null);
    api('GET', `/boards/${board.slug}/posts?${p}`).then((r) => setData((d) => (page > 1 && d ? { ...r, posts: [...d.posts, ...r.posts] } : r)))
      .catch(setLoadErr);
  }, [board?.slug, sort, status, mine, qd, page, retryN]);

  if (!board) return <p class="muted">{t.not_found}</p>;
  return (
    <>
      {cfg.boards.length > 1 && <div class="tabs" role="tablist">
        {cfg.boards.map((b) => <A to={`b/${b.slug}`} role="tab" aria-selected={b.slug === board.slug} class={b.slug === board.slug ? 'tab on' : 'tab'}>
          {L(b.name, loc)} <span class="count">{b.post_count}</span></A>)}
      </div>}
      {L(board.description, loc) && <p class="lead">{L(board.description, loc)}</p>}

      {writing ? <NewPost ctx={ctx} board={board} onDone={(n) => { setWriting(false); if (n) go(`p/${n}`); }} />
        : <div class="cta">{me ? <button class="btn" onClick={() => setWriting(true)}>{t.new_idea}</button> : <SignIn ctx={ctx} compact />}</div>}

      <div class="filters">
        <div class="seg" role="group" aria-label="Tri">
          {['trending', 'top', 'new'].map((s) => <button class={sort === s ? 'on' : ''} aria-pressed={sort === s} onClick={() => setSort(s)}>{t[s]}</button>)}
        </div>
        <select aria-label={t.status} value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">{t.all_status}</option>
          {cfg.statuses.map((s) => <option value={s.key}>{L(s.label, loc)}</option>)}
        </select>
        {me && <select aria-label={t.my_votes} value={mine} onChange={(e) => setMine(e.currentTarget.value)}>
          <option value="">{t.all_ideas}</option><option value="votes">{t.my_votes}</option><option value="posts">{t.my_posts}</option>
        </select>}
        <input type="search" class="grow" placeholder={t.search} aria-label={t.search} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {sort === 'trending' && <p class="hint">{t.half_life}</p>}

      {loadErr ? <Failed ctx={ctx} error={loadErr} retry={() => setRetryN(retryN + 1)} /> : !data ? <div class="skeleton" /> : !data.posts.length ? <p class="empty">{qd || status || mine ? t.no_result : t.empty}</p> :
        <ul class="posts">{data.posts.map((p) => <PostRow ctx={ctx} p={p} />)}</ul>}
      {data?.has_more && <button class="btn ghost more" onClick={() => setPage(page + 1)}>{t.more}</button>}
    </>
  );
}

function useDebounced(v, ms) {
  const [d, setD] = useState(v);
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h); }, [v]);
  return d;
}

function StatusPill({ ctx, k }) {
  const s = ctx.cfg.statuses.find((x) => x.key === k);
  if (!s) return null;
  return <span class="pill" style={{ '--c': s.color }}>{L(s.label, ctx.loc)}</span>;
}

function VoteButton({ ctx, number, voted, count, closed, onChange }) {
  const { t, me } = ctx;
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState({ voted, count });
  useEffect(() => setState({ voted, count }), [voted, count]);
  const click = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!me) { go('auth'); return; }
    if (busy || closed) return;
    setBusy(true);
    const next = !state.voted;
    setState({ voted: next, count: state.count + (next ? 1 : -1) });
    try {
      const r = await api(next ? 'POST' : 'DELETE', `/posts/${number}/vote`);
      setState({ voted: r.voted, count: r.vote_count }); onChange?.(r);
    } catch (x) {
      setState({ voted, count });
      if (x.extra?.merged_into) go(`p/${x.extra.merged_into}`); else alertMsg(ctx, x);
    } finally { setBusy(false); }
  };
  return (
    <button class={`vote ${state.voted ? 'on' : ''}`} aria-pressed={state.voted} disabled={closed && !state.voted}
      aria-label={`${state.voted ? t.voted : t.vote} (${t.votes(state.count)})`} onClick={click}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4l8 10h-5v6H9v-6H4z" /></svg>
      <span>{state.count}</span>
    </button>
  );
}

function alertMsg(ctx, x) { toast(ctx.t[x.code] || x.message || ctx.t.error); }

function PostRow({ ctx, p }) {
  const { t } = ctx;
  return (
    <li class="post">
      <VoteButton ctx={ctx} number={p.number} voted={p.voted} count={p.vote_count}
        closed={ctx.cfg.statuses.find((s) => s.key === p.status)?.closes_votes} />
      <A to={`p/${p.number}`} class="post-main">
        <span class="post-title">{p.title}</span>
        {p.excerpt && <span class="excerpt">{p.excerpt}</span>}
        <span class="meta">
          <StatusPill ctx={ctx} k={p.status} />
          {!p.approved && <span class="pill warn">{t.awaiting}</span>}
          {p.comment_count > 0 && <span>{t.comments(p.comment_count)}</span>}
        </span>
      </A>
    </li>
  );
}

function NewPost({ ctx, board, onDone }) {
  const { cfg, t, loc } = ctx;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [cat, setCat] = useState('');
  const [similar, setSimilar] = useState([]);
  const [busy, setBusy] = useState(false);
  const td = useDebounced(title, 300);
  const cats = cfg.categories.filter((c) => c.board_id === board.id);
  useEffect(() => {
    if (td.trim().length < 3) { setSimilar([]); return; }
    api('GET', `/posts/similar?q=${encodeURIComponent(td.trim())}`).then((r) => setSimilar(r.posts)).catch(() => {});
  }, [td]);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { const r = await api('POST', `/boards/${board.slug}/posts`, { title, body, category_id: cat || null }); ctx.reload(); onDone(r.post.number); }
    catch (x) { alertMsg(ctx, x); } finally { setBusy(false); }
  };
  return (
    <form class="card form" onSubmit={submit}>
      <label>{t.title}<input required minLength={3} maxLength={120} value={title} placeholder={t.title_ph} onInput={(e) => setTitle(e.currentTarget.value)} autoFocus /></label>
      {similar.length > 0 && <div class="similar" aria-live="polite">
        <p>{t.similar}</p>
        <ul>{similar.map((s) => <li><VoteButton ctx={ctx} number={s.number} voted={false} count={s.vote_count} /><A to={`p/${s.number}`}>{s.title}</A> <StatusPill ctx={ctx} k={s.status} /></li>)}</ul>
      </div>}
      <label>{t.details}<textarea rows={4} maxLength={10000} value={body} placeholder={t.details_ph} onInput={(e) => setBody(e.currentTarget.value)} /></label>
      {cats.length > 0 && <label>{t.category}<select value={cat} onChange={(e) => setCat(e.currentTarget.value)}>
        <option value="">{t.none}</option>{cats.map((c) => <option value={c.id}>{L(c.name, loc)}</option>)}</select></label>}
      <div class="row end"><button type="button" class="btn ghost" onClick={() => onDone(null)}>{t.cancel}</button>
        <button class="btn" disabled={busy || title.trim().length < 3}>{t.submit}</button></div>
    </form>
  );
}

// ---------- post ----------

function PostView({ ctx, number }) {
  const { t, loc, team, me } = ctx;
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [n, setN] = useState(0);
  const refresh = () => setN((x) => x + 1);
  useEffect(() => { api('GET', `/posts/${number}`).then(setD).catch(setErr); }, [number, n, me?.id]);
  if (err) return <p class="error">{err.status === 404 ? t.not_found : t.error}</p>;
  if (!d) return <div class="skeleton" />;
  const p = d.post;
  const timeline = [
    ...d.comments.map((c) => ({ kind: 'c', at: c.created_at, c })),
    ...d.events.map((e) => ({ kind: 'e', at: e.created_at, e })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  const follow = async () => { try { await api(d.me.subscribed ? 'DELETE' : 'POST', `/posts/${number}/subscribe`); refresh(); } catch (x) { alertMsg(ctx, x); } };

  return (
    <article class="detail">
      <A to={`b/${p.board}`} class="back">← {t.back}</A>
      {p.merged_into_number && <div class="banner">{t.merged_into} <A to={`p/${p.merged_into_number}`}>« {p.merged_into_title} »</A></div>}
      {!p.approved && <div class="banner warn">{t.awaiting}</div>}
      <div class="detail-head">
        <VoteButton ctx={ctx} number={p.number} voted={d.me.voted} count={p.vote_count} closed={p.closes_votes || !!p.merged_into_number} onChange={refresh} />
        <div>
          <h1>{p.title}</h1>
          <div class="meta">
            <StatusPill ctx={ctx} k={p.status} />
            {p.category_name && <span class="pill" style={{ '--c': p.category_color }}>{L(p.category_name, loc)}</span>}
            <span>{p.author_name || '—'} · {fmtDate(p.created_at, loc)}</span>
            {p.eta && <span>ETA {p.eta}</span>}
            {me && <button class="link" onClick={follow}>{d.me.subscribed ? t.following : t.follow}</button>}
          </div>
        </div>
      </div>
      {p.body && <p class="body">{p.body}</p>}

      {d.voters.length > 0 && <details class="voters">
        <summary>{t.voters} ({p.vote_count})</summary>
        <ul>{d.voters.map((v) => <li>{v.name || '—'}{team && v.company && <span class="muted"> · {v.company}{v.mrr ? ` (${Number(v.mrr)} $)` : ''}</span>}
          {team && v.note && <q class="quote">{v.note}</q>}{team && v.source_url && <> <a href={v.source_url} target="_blank" rel="noopener">ticket</a></>}</li>)}
          {!team && p.vote_count > d.voters.length && <li class="muted">{t.and_more(p.vote_count - d.voters.length)}</li>}</ul>
      </details>}

      {team && <TeamPanel ctx={ctx} p={p} onChange={refresh} />}

      <section class="timeline" aria-label="Activité">
        {timeline.map((x) => x.kind === 'e' ? <EventLine ctx={ctx} e={x.e} /> : (
          <div class={`comment ${x.c.official ? 'official' : ''} ${x.c.internal ? 'internal' : ''}`}>
            <div class="who-line"><strong>{x.c.author_name || '—'}</strong>{x.c.author_is_team && <span class="pill team">{t.team}</span>}
              {x.c.internal && <span class="pill warn">{t.internal}</span>}<span class="muted">{fmtDate(x.c.created_at, loc)}</span></div>
            <p>{x.c.body}</p>
          </div>))}
      </section>
      {!p.merged_into_number && (me ? <CommentForm ctx={ctx} number={p.number} onDone={refresh} /> : <SignIn ctx={ctx} compact />)}
    </article>
  );
}

function EventLine({ ctx, e }) {
  const { t, loc } = ctx;
  if (e.type === 'status_changed') return (
    <div class="event"><span>{t.status_changed}</span> <StatusPill ctx={ctx} k={e.payload.to} /> <span class="muted">{e.actor_name} · {fmtDate(e.created_at, loc)}</span>
      {e.payload.message && <p class="event-msg">{e.payload.message}</p>}</div>);
  if (e.type === 'merged_in') return <div class="event">{t.merged_in} <A to={`p/${e.payload.number}`}>« {e.payload.title} »</A> <span class="muted">{fmtDate(e.created_at, loc)}</span></div>;
  if (e.type === 'merged_into') return <div class="event">{t.merged_into} <A to={`p/${e.payload.number}`}>« {e.payload.title} »</A></div>;
  return null;
}

function CommentForm({ ctx, number, onDone }) {
  const { t, team } = ctx;
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await api('POST', `/posts/${number}/comments`, { body, internal }); setBody(''); onDone(); } catch (x) { alertMsg(ctx, x); } finally { setBusy(false); }
  };
  return (
    <form class="comment-form" onSubmit={send}>
      <textarea rows={3} required maxLength={5000} value={body} aria-label={t.comment_ph} placeholder={t.comment_ph} onInput={(e) => setBody(e.currentTarget.value)} />
      <div class="row between">
        {team ? <label class="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.currentTarget.checked)} /> {t.comment_internal}</label> : <span />}
        <button class="btn" disabled={busy || !body.trim()}>{t.send}</button>
      </div>
    </form>
  );
}

function TeamPanel({ ctx, p, onChange }) {
  const { cfg, t, loc } = ctx;
  const [status, setStatus] = useState(p.status);
  const [msg, setMsg] = useState('');
  const [into, setInto] = useState('');
  const [score, setScore] = useState({ impact: p.impact ?? '', confidence: p.confidence ?? '', effort: p.effort ?? '' });
  const [cust, setCust] = useState({ email: '', note: '', source_url: '' });
  // Resolves true only on success, so a form is cleared only when its action worked.
  const run = async (fn) => { try { await fn(); alertMsg(ctx, { message: t.saved }); onChange(); return true; } catch (x) { alertMsg(ctx, x); return false; } };
  const numOrNull = (v) => (v === '' || v === null ? null : Number(v));
  return (
    <section class="card team-panel" aria-label={t.team_panel}>
      <h2>{t.team_panel}</h2>
      <div class="grid2">
        <form onSubmit={(e) => { e.preventDefault(); run(() => api('PATCH', `/posts/${p.number}`, { status, message: msg || undefined })).then((ok) => ok && setMsg('')); }}>
          <label>{t.change_status}<select value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
            {cfg.statuses.map((s) => <option value={s.key}>{L(s.label, loc)}</option>)}</select></label>
          <label>{t.status_message}<textarea rows={2} value={msg} onInput={(e) => setMsg(e.currentTarget.value)} /></label>
          <button class="btn sm" disabled={status === p.status}>{t.apply}</button>
        </form>
        <form onSubmit={(e) => { e.preventDefault(); run(() => api('PATCH', `/posts/${p.number}`, { impact: numOrNull(score.impact), confidence: numOrNull(score.confidence), effort: numOrNull(score.effort) })); }}>
          <div class="row">
            <label>{t.impact}<select value={score.impact} onChange={(e) => setScore({ ...score, impact: e.currentTarget.value })}>
              <option value="">—</option><option value="1">1</option><option value="2">2</option><option value="3">3</option></select></label>
            <label>{t.confidence}<select value={score.confidence} onChange={(e) => setScore({ ...score, confidence: e.currentTarget.value })}>
              <option value="">—</option><option value="0.5">50 %</option><option value="0.8">80 %</option><option value="1">100 %</option></select></label>
            <label>{t.effort}<input type="number" min="0.5" step="0.5" value={score.effort} onInput={(e) => setScore({ ...score, effort: e.currentTarget.value })} /></label>
          </div>
          <p class="hint">{t.priority_help}</p>
          <button class="btn sm">{t.apply}</button>
        </form>
      </div>
      <div class="grid2">
        <form onSubmit={(e) => { e.preventDefault(); run(() => api('POST', `/posts/${p.number}/votes`, { email: cust.email, note: cust.note || undefined, source_url: cust.source_url || undefined })).then((ok) => ok && setCust({ email: '', note: '', source_url: '' })); }}>
          <label>{t.vote_for}<input type="email" required placeholder={t.customer_email} value={cust.email} onInput={(e) => setCust({ ...cust, email: e.currentTarget.value })} /></label>
          <input placeholder={t.customer_note} value={cust.note} onInput={(e) => setCust({ ...cust, note: e.currentTarget.value })} aria-label={t.customer_note} />
          <input type="url" placeholder={t.ticket_url} value={cust.source_url} onInput={(e) => setCust({ ...cust, source_url: e.currentTarget.value })} aria-label={t.ticket_url} />
          <button class="btn sm">{t.add_vote}</button>
        </form>
        <div>
          {p.merged_into_number ? <button class="btn sm ghost" onClick={() => run(() => api('POST', `/posts/${p.number}/unmerge`))}>{t.unmerge}</button> :
            <form onSubmit={(e) => { e.preventDefault(); run(() => api('POST', `/posts/${p.number}/merge`, { into: Number(into) })); }}>
              <label>{t.merge_into}<input type="number" min="1" required value={into} onInput={(e) => setInto(e.currentTarget.value)} /></label>
              <button class="btn sm ghost">{t.merge}</button>
            </form>}
          <div class="row" style={{ marginTop: '12px' }}>
            {!p.approved && <button class="btn sm" onClick={() => run(() => api('PATCH', `/posts/${p.number}`, { approved: true }))}>{t.approve}</button>}
            <button class="btn sm ghost danger" onClick={() => run(() => api('PATCH', `/posts/${p.number}`, { hidden: !p.hidden }))}>{t.hide}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- roadmap and changelog ----------

function RoadmapView({ ctx }) {
  const { t, loc } = ctx;
  const { data: d, error, reload } = useLoad(() => api('GET', '/roadmap'), []);
  if (error) return <Failed ctx={ctx} error={error} retry={reload} />;
  if (!d) return <div class="skeleton" />;
  return (
    <>
      <p class="lead">{t.roadmap_hint}</p>
      <div class="kanban">
        {d.columns.map((c) => <section class="col" aria-label={L(c.label, loc)}>
          <h2><span class="dotc" style={{ background: c.color }} />{L(c.label, loc)} <span class="count">{c.posts.length}</span></h2>
          <ul>{c.posts.map((p) => <li class="kcard"><A to={`p/${p.number}`}>{p.title}</A>
            <div class="meta"><span>{t.votes(p.vote_count)}</span>{ctx.cfg.boards.length > 1 && <span class="muted">{L(p.board_name, loc)}</span>}{p.eta && <span>{p.eta}</span>}</div></li>)}</ul>
        </section>)}
      </div>
    </>
  );
}

function ChangelogView({ ctx }) {
  const { t, loc } = ctx;
  const { data: d, error, reload } = useLoad(() => api('GET', '/changelog'), []);
  if (error) return <Failed ctx={ctx} error={error} retry={reload} />;
  if (!d) return <div class="skeleton" />;
  if (!d.entries.length) return <p class="empty">{t.changelog_empty}</p>;
  return <div class="changelog">{d.entries.map((e) => <article class="card">
    <div class="muted">{e.published_at ? fmtDate(e.published_at, loc) : t.draft}</div>
    <h2>{e.title}</h2>{e.body && <p class="body">{e.body}</p>}
    {e.posts.length > 0 && <p class="muted">{t.shipped_for} : {e.posts.map((p, i) => <>{i > 0 && ', '}<A to={`p/${p.number}`}>{p.title}</A></>)}</p>}
  </article>)}</div>;
}

// ---------- sign-in ----------

function SignIn({ ctx, compact, note }) {
  const { t, cfg } = ctx;
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [sent, setSent] = useState(false);
  if (EMBED) return <p class="muted">{note || t.sign_in_to_vote}</p>;
  if (!cfg.site.magic_link) return <p class="muted">{note || t.sign_in_to_vote}</p>;
  if (sent) return <p class="ok" role="status">{t.link_sent}</p>;
  const send = async (e) => {
    e.preventDefault();
    try { await api('POST', '/auth/magic', { email, name: name || undefined, locale: ctx.loc, return_to: location.pathname.slice(BASE.length) }); setSent(true); } catch (x) { alertMsg(ctx, x); }
  };
  return (
    <form class={`card form ${compact ? 'compact' : ''}`} onSubmit={send}>
      <p>{note || t.sign_in_to_vote}</p>
      <div class="row wrap">
        <input type="email" required placeholder={t.email} aria-label={t.email} value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
        {!compact && <input placeholder={t.your_name} aria-label={t.your_name} value={name} onInput={(e) => setName(e.currentTarget.value)} />}
        <button class="btn">{t.send_link}</button>
      </div>
    </form>
  );
}

function AuthView({ ctx }) {
  const { t } = ctx;
  const tok = params.get('token');
  const [state, setState] = useState(tok ? 'busy' : 'form');
  const done = useRef(false);
  useEffect(() => {
    if (!tok || done.current) return;
    done.current = true;
    // The link is consumed by this POST, never by opening the page, so mail scanners cannot burn it.
    api('POST', '/auth/verify', { token: tok }).then((r) => {
      store.set(r.token); setState('ok');
      const to = r.return_to && r.return_to.startsWith(`/s/${SITE}/`) && !r.return_to.includes('/auth') ? r.return_to.split('/').slice(3).join('/') : '';
      go(to, true); ctx.reload();
    }).catch((x) => setState(x.code === 'link_invalid_or_used' ? 'bad' : 'neterr'));
  }, []);
  if (state === 'busy') return <p>{t.signing_in}</p>;
  if (state === 'bad') return <><p class="error">{t.link_invalid}</p><SignIn ctx={ctx} /></>;
  if (state === 'neterr') return <><p class="error">{t.error}</p><button class="btn ghost" onClick={() => location.reload()}>{t.retry}</button></>;
  if (ctx.me) return <><p class="ok">{t.signed_in}</p><button class="btn ghost" onClick={async () => { try { await api('POST', '/auth/logout'); } catch { /* the local session goes anyway */ } store.set(null); ctx.reload(); }}>{t.sign_out}</button></>;
  return <SignIn ctx={ctx} />;
}

// ---------- admin ----------

function AdminView({ ctx, tab }) {
  const { t } = ctx;
  const tabs = [['backlog', t.backlog], ['moderation', t.moderation], ['changelog', t.changelog], ['users', t.users], ...(ctx.me.role === 'admin' ? [['settings', t.settings]] : [])];
  return (
    <>
      <div class="tabs" role="tablist">{tabs.map(([k, l]) => <A to={`admin/${k}`} role="tab" aria-selected={tab === k} class={tab === k ? 'tab on' : 'tab'}>{l}</A>)}</div>
      {tab === 'backlog' && <Backlog ctx={ctx} />}
      {tab === 'moderation' && <Moderation ctx={ctx} />}
      {tab === 'changelog' && <ChangelogEditor ctx={ctx} />}
      {tab === 'users' && <Users ctx={ctx} />}
      {tab === 'settings' && <Settings ctx={ctx} />}
    </>
  );
}

function Backlog({ ctx }) {
  const { t } = ctx;
  const [all, setAll] = useState(false);
  const { data: d, error, reload } = useLoad(() => api('GET', `/backlog${all ? '?all=1' : ''}`), [all]);
  const money = useMemo(() => new Intl.NumberFormat({ fr: 'fr-CA', en: 'en-CA', es: 'es' }[ctx.loc] || 'fr-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }), [ctx.loc]);
  if (error) return <Failed ctx={ctx} error={error} retry={reload} />;
  if (!d) return <div class="skeleton" />;
  return (
    <>
      <div class="row between"><p class="hint">{t.priority_help}</p>
        <label class="check"><input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} /> {t.all_status}</label></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>{t.title}</th><th>{t.status}</th><th class="num">{t.priority}</th><th class="num">{t.weighted}</th>
          <th class="num">{t.people}</th><th class="num">{t.companies}</th><th class="num">{t.mrr}</th><th class="num">I · C · E</th></tr></thead>
        <tbody>{d.posts.map((p, i) => <tr>
          <td class="muted">{i + 1}</td><td><A to={`p/${p.number}`}>{p.title}</A></td><td><StatusPill ctx={ctx} k={p.status} /></td>
          <td class="num strong">{p.priority ?? '—'}</td><td class="num">{p.weighted_votes}</td><td class="num">{p.people}</td>
          <td class="num">{p.companies}</td><td class="num">{p.mrr ? money.format(p.mrr) : '—'}</td>
          <td class="num muted">{p.impact ?? '·'} · {p.confidence ?? '·'} · {p.effort ?? '·'}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}

function Moderation({ ctx }) {
  const { t, loc } = ctx;
  const { data: d, error, reload } = useLoad(() => api('GET', '/moderation'), []);
  if (error) return <Failed ctx={ctx} error={error} retry={reload} />;
  if (!d) return <div class="skeleton" />;
  if (!d.posts.length) return <p class="empty">{t.nothing_to_moderate}</p>;
  const act = async (n, body) => { try { await api('PATCH', `/posts/${n}`, body); reload(); ctx.reload(); } catch (x) { alertMsg(ctx, x); } };
  return <ul class="posts">{d.posts.map((p) => <li class="post"><div class="post-main">
    <A to={`p/${p.number}`} class="post-title">{p.title}</A><span class="excerpt">{p.body}</span>
    <span class="meta"><span>{p.author_name} {p.author_email && `· ${p.author_email}`}</span><span>{fmtDate(p.created_at, loc)}</span></span>
    <div class="row"><button class="btn sm" onClick={() => act(p.number, { approved: true })}>{t.approve}</button>
      <button class="btn sm ghost danger" onClick={() => act(p.number, { hidden: true })}>{t.reject}</button></div></div></li>)}</ul>;
}

function ChangelogEditor({ ctx }) {
  const { t } = ctx;
  const [f, setF] = useState({ title: '', body: '', posts: '' });
  const [k, setK] = useState(0);
  const save = async (publish) => {
    try {
      await api('POST', '/changelog', { title: f.title, body: f.body, publish, posts: f.posts.split(/[\s,;]+/).filter(Boolean).map(Number).filter((n) => n > 0) });
      setF({ title: '', body: '', posts: '' }); setK(k + 1); alertMsg(ctx, { message: t.saved });
    } catch (x) { alertMsg(ctx, x); }
  };
  return (
    <>
      <form class="card form" onSubmit={(e) => { e.preventDefault(); save(true); }}>
        <label>{t.entry_title}<input required minLength={3} value={f.title} onInput={(e) => setF({ ...f, title: e.currentTarget.value })} /></label>
        <label>{t.entry_body}<textarea rows={4} value={f.body} onInput={(e) => setF({ ...f, body: e.currentTarget.value })} /></label>
        <label>{t.entry_posts}<input inputMode="numeric" value={f.posts} placeholder="12, 18" onInput={(e) => setF({ ...f, posts: e.currentTarget.value })} /></label>
        <div class="row end"><button type="button" class="btn ghost" onClick={() => save(false)}>{t.save_draft}</button><button class="btn">{t.publish}</button></div>
      </form>
      <ChangelogView ctx={ctx} key={k} />
    </>
  );
}

function Users({ ctx }) {
  const { t } = ctx;
  const [q, setQ] = useState('');
  const qd = useDebounced(q, 250);
  const { data: d, error, reload: load } = useLoad(() => api('GET', `/users?q=${encodeURIComponent(qd)}`), [qd]);
  const admin = ctx.me.role === 'admin';
  const patch = async (id, body) => { try { await api('PATCH', `/users/${id}`, body); load(); } catch (x) { alertMsg(ctx, x); } };
  return (
    <>
      <input type="search" placeholder={t.search} aria-label={t.search} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      {error ? <Failed ctx={ctx} error={error} retry={load} /> : !d ? <div class="skeleton" /> : <div class="table-wrap"><table class="table">
        <thead><tr><th>{t.your_name}</th><th>{t.email}</th><th>{t.companies}</th><th class="num">{t.votes(2).replace(/\d+\s*/, '')}</th><th>{t.role}</th><th /></tr></thead>
        <tbody>{d.users.map((u) => <tr class={u.banned ? 'muted' : ''}>
          <td>{u.name}</td><td>{u.email || '—'}</td><td>{u.company || '—'}{u.segment && <span class="muted"> · {u.segment}</span>}</td><td class="num">{u.votes}</td>
          <td>{admin ? <select value={u.role} aria-label={t.role} onChange={(e) => patch(u.id, { role: e.currentTarget.value })}>
            <option value="user">user</option><option value="moderator">moderator</option><option value="admin">admin</option></select> : u.role}</td>
          <td>{admin && <button class="link" onClick={() => patch(u.id, { banned: !u.banned })}>{u.banned ? t.unban : t.ban}</button>}</td></tr>)}</tbody>
      </table></div>}
    </>
  );
}

function Settings({ ctx }) {
  const { t } = ctx;
  const { data: d, error, reload } = useLoad(() => api('GET', '/settings'), []);
  if (error) return <Failed ctx={ctx} error={error} retry={reload} />;
  if (!d) return <div class="skeleton" />;
  return (
    <div class="stack">
      <section class="card"><h2>{t.embed}</h2><p class="hint">{t.embed_hint}</p><pre class="code">{d.embed.script}</pre>
        <p>{t.portal_link} : <a href={d.embed.portal}>{d.embed.portal}</a></p></section>
      <section class="card"><h2>Webhooks</h2>{d.webhooks.length ? <ul>{d.webhooks.map((w) => <li><code>{w.url}</code> <span class="muted">{w.events.join(', ')}{w.failed ? ` · ${w.failed} échecs` : ''}</span></li>)}</ul> : <p class="muted">—</p>}</section>
      <section class="card"><h2>Configuration</h2><pre class="code">{JSON.stringify({ name: d.site.name, domains: d.site.domains, default_locale: d.site.default_locale, ...d.site.config }, null, 2)}</pre></section>
    </div>
  );
}

render(<App />, document.getElementById('app'));

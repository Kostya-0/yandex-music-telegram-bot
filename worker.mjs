const DEFAULT_PLAYLIST = '7f245f47-ab83-0ca6-96b1-e2f6f2027bd3';
const YM = 'https://api.music.yandex.net';
const HOSTS = new Set(['music.yandex.ru', 'music.yandex.com', 'music.yandex.kz', 'music.yandex.by', 'music.yandex.uz']);
class UserError extends Error {}
class ApiError extends Error {
  constructor(service, status, code = '') { super(`${service}:${status}`); this.service = service; this.status = status; this.code = code; }
}
const ids = value => String(value || '').split(/[\s,]+/).filter(Boolean);
const playlistURL = env => `https://music.yandex.ru/playlists/${env.PLAYLIST_UUID || DEFAULT_PLAYLIST}`;
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});

export function parseTrack(text) {
  const candidates = String(text || '').match(/https:\/\/[^\s<>]+/g) || [];
  if (candidates.length !== 1) throw new UserError('Пришли одну прямую ссылку на трек Яндекс Музыки: /add https://music.yandex.ru/album/123/track/456');
  let url;
  try { url = new URL(candidates[0].replace(/[)\]},.!;]+$/, '')); } catch { throw new UserError('Не удалось разобрать ссылку.'); }
  if (!HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new UserError('Нужна прямая ссылка на music.yandex.ru. Короткие ссылки пока не поддерживаются.');
  const match = url.pathname.match(/^\/(?:album\/(\d+)\/)?track\/(\d+)\/?$/);
  if (!match) throw new UserError('Эта ссылка не на отдельный трек. Открой трек → Поделиться → Скопировать ссылку.');
  return {albumId: match[1] || null, trackId: match[2]};
}

async function ym(env, path, data, fetcher) {
  if (!env.YANDEX_TOKEN) throw new ApiError('yandex', 401);
  const token=env.YANDEX_TOKEN.trim();
  if (/\s|^https?:|[А-Яа-я]/.test(token)) throw new UserError('YANDEX_TOKEN: нужно только значение токена, без URL, пробелов и префикса OAuth.');
  let response;
  try { response = await fetcher(`${YM}${path}`, {
    method: data ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: {Authorization: `OAuth ${token}`, ...(data ? {'content-type': 'application/x-www-form-urlencoded'} : {})},
    ...(data ? {body: new URLSearchParams(data).toString()} : {})
  }); } catch { throw new ApiError('yandex',502,'transport'); }
  let body;
  try { body = await response.json(); } catch { throw new ApiError('yandex', response.status || 502); }
  if (!response.ok || body.error) throw new ApiError('yandex', response.status, String(body.error?.name || ''));
  if (body.result === undefined) throw new ApiError('yandex', 502);
  return body.result;
}

async function tg(env, method, body, fetcher) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new ApiError('telegram', 401);
  const token=env.TELEGRAM_BOT_TOKEN.trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new UserError('TELEGRAM_BOT_TOKEN: неверный формат. Нужна только строка вида 123456:ABC..., без текста BotFather и URL.');
  let response;
  try { response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
  }); } catch { throw new ApiError('telegram',502,'transport'); }
  let result;
  try { result = await response.json(); } catch { throw new ApiError('telegram', response.status || 502); }
  if (!response.ok || !result.ok) throw new ApiError('telegram', result.error_code || response.status);
  return result.result;
}

async function ownedPlaylist(env, fetcher) {
  const account = await ym(env, '/account/status', null, fetcher);
  const uuid = env.PLAYLIST_UUID || DEFAULT_PLAYLIST;
  if (!/^[\da-f-]{36}$/i.test(uuid)) throw new UserError('Администратору: неверный PLAYLIST_UUID.');
  const summary = await ym(env, `/playlist/${uuid}`, null, fetcher);
  const uid = String(account.account?.uid || '');
  if (!uid || uid !== String(summary.owner?.uid)) throw new UserError('Токен Яндекса должен принадлежать владельцу плейлиста.');
  if (!/^\d+$/.test(String(summary.kind))) throw new ApiError('yandex', 502);
  const path = `/users/${uid}/playlists/${summary.kind}`;
  const playlist = await ym(env, path, null, fetcher);
  // Never treat an omitted/truncated list as an empty playlist: that could create duplicates.
  if (!Array.isArray(playlist.tracks) || playlist.tracks.length !== Number(playlist.trackCount)) throw new UserError('Не удалось получить полный список треков. Добавление остановлено, чтобы не создать дубль.');
  return {path, playlist, uid};
}

export async function addTrack(env, parsed, fetcher = fetch) {
  const result = await ym(env, '/tracks', {'track-ids': parsed.albumId ? `${parsed.trackId}:${parsed.albumId}` : parsed.trackId}, fetcher);
  const track = Array.isArray(result) ? result.find(t => String(t.id) === parsed.trackId) : null;
  if (!track || track.error || track.available === false || track.type && track.type !== 'music') throw new UserError('Трек не найден или недоступен.');
  const album = parsed.albumId ? track.albums?.find(a => String(a.id) === parsed.albumId) : track.albums?.[0];
  if (!album) throw new UserError('Не удалось подтвердить альбом трека. Пришли ссылку из меню «Поделиться».');
  const title = `${(track.artists || []).map(a => a.name).join(', ')} — ${track.title}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const {path, playlist} = await ownedPlaylist(env, fetcher);
    if (playlist.tracks.some(t => String(t.id ?? t.track?.id) === String(track.id))) return {duplicate: true, title};
    if (!Number.isInteger(playlist.revision)) throw new ApiError('yandex', 502);
    try {
      await ym(env, `${path}/change`, {
        kind: String(playlist.kind), revision: String(playlist.revision),
        diff: JSON.stringify([{op: 'insert', at: playlist.tracks.length, tracks: [{id: String(track.id), albumId: String(album.id)}]}])
      }, fetcher);
    } catch (error) {
      // On conflict or an ambiguous timeout, re-read before deciding whether to retry.
      if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
      if (attempt === 2) throw error;
      continue;
    }
    const verified = await ym(env, path, null, fetcher);
    if (!verified.tracks?.some(t => String(t.id ?? t.track?.id) === String(track.id))) throw new ApiError('yandex', 502);
    return {duplicate: false, title};
  }
  throw new ApiError('yandex', 503);
}

export async function handleUpdate(update, env, fetcher = fetch) {
  const msg = update.message;
  if (!msg || msg.from?.is_bot || msg.sender_chat || typeof msg.text !== 'string') return;
  const command = msg.text.match(/^\/(add|playlist|help|start|id)(?:@([\w]+))?(?:\s|$)/i);
  if (!command) return;
  if (command[2] && (!env.BOT_USERNAME || command[2].toLowerCase() !== env.BOT_USERNAME.replace(/^@/, '').toLowerCase())) return;
  const reply = text => tg(env, 'sendMessage', {chat_id: msg.chat.id, text, reply_parameters: {message_id: msg.message_id, allow_sending_without_reply: true}, link_preview_options: {is_disabled: true}}, fetcher);
  const action = command[1].toLowerCase();
  // This command reflects only the sender's own IDs and does not access Yandex.
  if (action === 'id') return reply(`ID чата: ${msg.chat.id}\nТвой ID: ${msg.from?.id}`);
  const chats = ids(env.ALLOWED_CHAT_IDS);
  const users = ids(env.ALLOWED_USER_IDS);
  if (!chats.includes(String(msg.chat.id)) || users.length && !users.includes(String(msg.from?.id))) return;
  if (action === 'playlist') return reply(`Тыквенная полночь 🎃\n${playlistURL(env)}`);
  if (action !== 'add') return reply('Добавить трек: /add ссылка\nМожно ответить командой /add на сообщение со ссылкой.\n/playlist — открыть плейлист\n/id — узнать ID чата\nБот проверяет дубли. Происхождение записи (AI или человек) автоматически достоверно не определяется; присылайте только проверенные исполнения.');
  try {
    const args = msg.text.slice(command[0].length).trim();
    const result = await addTrack(env, parseTrack(args || msg.reply_to_message?.text || msg.reply_to_message?.caption), fetcher);
    await reply(`${result.duplicate ? 'Уже есть в плейлисте' : 'Добавлено 🎃'}: ${result.title}\n${playlistURL(env)}`);
  } catch (error) {
    if (error instanceof UserError) return reply(error.message);
    if (error instanceof ApiError && [401, 403].includes(error.status)) return reply('Не удалось получить доступ к музыкальному сервису. Владельцу нужно проверить токен и доступность API в панели настройки бота.');
    // Return 503 at the webhook so Telegram retries. Playlist ID deduplication makes retries safe.
    throw error;
  }
}

const SETUP_PAGE = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Тыквенная полночь — настройка бота</title><style>body{background:#14121b;color:#f7f1e8;font:17px system-ui;max-width:760px;margin:60px auto;padding:24px}input,button{font:inherit;border-radius:10px;padding:12px;margin:6px 0}input{display:block;width:90%;background:#272232;color:white;border:1px solid #675874}button{background:#ffb04b;color:#211520;border:0;cursor:pointer}pre{white-space:pre-wrap;background:#272232;padding:20px;border-radius:12px}a{color:#ffc576}small{color:#c1b3cb}</style><h1>Тыквенная полночь 🎃</h1><p>Добавление треков из Telegram в общий плейлист Яндекс Музыки.</p><p>В Cloudflare → Settings → Variables and Secrets добавьте секреты <b>TELEGRAM_BOT_TOKEN</b>, <b>YANDEX_TOKEN</b>, <b>SETUP_SECRET</b> (случайная строка минимум 32 символа). Затем укажите обычные переменные <b>BOT_USERNAME</b> и <b>ALLOWED_CHAT_IDS</b>.</p><p><small>Не вводите токены Telegram и Яндекса на этой странице. Секрет настройки передаётся только этому Worker по HTTPS и не сохраняется в браузере.</small></p><form id="setup"><label>SETUP_SECRET<input id="key" type="password" autocomplete="off" required minlength="32"></label><button name="action" value="check">1. Проверить подключения</button> <button name="action" value="webhook">2. Подключить Telegram</button></form><pre id="result">Ожидаю проверки.</pre><p>После подключения напишите боту <b>/id</b> в вашей группе и внесите ID чата в <b>ALLOWED_CHAT_IDS</b>. Пока список пуст, бот ничего не добавляет.</p><script>document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const r=document.querySelector('#result');r.textContent='Проверяю…';try{const res=await fetch('/admin/'+e.submitter.value,{method:'POST',headers:{Authorization:'Bearer '+document.querySelector('#key').value}});r.textContent=JSON.stringify(await res.json(),null,2)}catch{r.textContent='Не удалось связаться с Worker.'}});</script></html>`;

export function makeWorker(fetcher = fetch) {
  return {async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return new Response(SETUP_PAGE, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'"}});
    if (request.method !== 'POST') return new Response('Not found', {status: 404});
    if (url.pathname.startsWith('/admin/')) {
      if (!env.SETUP_SECRET || env.SETUP_SECRET.length < 32 || request.headers.get('Authorization') !== `Bearer ${env.SETUP_SECRET}`) return json({error: 'Нет доступа. Проверьте SETUP_SECRET.'}, 401);
      try {
        if (!['/admin/check', '/admin/webhook'].includes(url.pathname)) return json({error: 'Не найдено'}, 404);
        if (url.pathname === '/admin/check') {
          const checks={};
          try {const bot=await tg(env,'getMe',{},fetcher);checks.telegram={ok:true,bot:'@'+bot.username};}
          catch(error){checks.telegram={ok:false,error:error instanceof UserError?error.message:'Ошибка подключения Telegram',status:error.status||502,code:error.code||''};}
          try {const {playlist}=await ownedPlaylist(env,fetcher);checks.yandex={ok:true,playlist:playlist.title,tracks:playlist.trackCount};}
          catch(error){checks.yandex={ok:false,error:error instanceof UserError?error.message:'Ошибка подключения Яндекс Музыки',status:error.status||502,code:error.code||''};}
          return json({ok:checks.telegram.ok&&checks.yandex.ok,...checks,allowedChats:ids(env.ALLOWED_CHAT_IDS)});
        }
        const bot = await tg(env, 'getMe', {}, fetcher);
        const {playlist} = await ownedPlaylist(env, fetcher);
        if (env.BOT_USERNAME && env.BOT_USERNAME.replace(/^@/, '').toLowerCase() !== bot.username?.toLowerCase()) throw new UserError('BOT_USERNAME не совпадает с именем бота Telegram.');
        if (url.pathname === '/admin/webhook') {
          if (!env.BOT_USERNAME) throw new UserError('Сначала укажите BOT_USERNAME в Cloudflare.');
          if (!/^[\w-]{32,256}$/.test(env.SETUP_SECRET)) throw new UserError('SETUP_SECRET: 32–256 латинских букв, цифр, дефисов или подчёркиваний.');
          await tg(env, 'setWebhook', {url: `${url.origin}/telegram`, secret_token: env.SETUP_SECRET, allowed_updates: ['message'], max_connections: 1, drop_pending_updates: false}, fetcher);
          await tg(env, 'setMyCommands', {commands: [{command:'add',description:'Добавить трек по ссылке'},{command:'playlist',description:'Открыть плейлист'},{command:'id',description:'Показать ID чата'},{command:'help',description:'Как пользоваться'}]}, fetcher);
        }
        return json({ok:true,bot:`@${bot.username}`,playlist:playlist.title,tracks:playlist.trackCount,allowedChats:ids(env.ALLOWED_CHAT_IDS),telegramConnected:url.pathname==='/admin/webhook',next:ids(env.ALLOWED_CHAT_IDS).length?'Отправьте /add со ссылкой в разрешённом чате.':'После подключения отправьте /id в группе и добавьте ID в ALLOWED_CHAT_IDS.'});
      } catch (error) { return json({ok:false,error:error instanceof UserError ? error.message : 'Не удалось подключиться к '+(error.service || 'сервису')+'. Проверьте секреты и доступность API.',status:error.status || 502}, 502); }
    }
    if (url.pathname !== '/telegram') return new Response('Not found', {status:404});
    if (!env.SETUP_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SETUP_SECRET) return new Response('Forbidden',{status:403});
    if (Number(request.headers.get('content-length')) > 65536) return new Response('Too large',{status:413});
    let update;
    try { const body=await request.text(); if(body.length>65536)return new Response('Too large',{status:413}); update=JSON.parse(body); } catch {return new Response('Bad request',{status:400});}
    try { await handleUpdate(update,env,fetcher); return new Response('OK'); }
    catch { return new Response('Retry later',{status:503}); }
  }};
}
export default makeWorker();

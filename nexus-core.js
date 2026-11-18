/* NEXUS v1.02 — utilidades puras. Sin Firebase ni efectos secundarios. */
(function (root) {
  'use strict';
  const ROOM_TTL_MS = 48 * 60 * 60 * 1000;
  const REMATCH_MS = 10 * 60 * 1000;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const allCardIds = Object.freeze(['01','02','11','12','13','14','15','16','17','18','21','22','23','31','32','33','41','42','43','51','52','61','62','71','72','81','91']);
  const twoPlayerExcluded = Object.freeze(['01','02','12','13','18','22','33','42','61','71','91']);
  const excludes = new Set(twoPlayerExcluded);
  function integerBelow(limit) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 0x100000000) throw new RangeError('Rango de aleatoriedad no válido');
    const cryptoAPI = root.crypto;
    if (!cryptoAPI || typeof cryptoAPI.getRandomValues !== 'function') throw new Error('NEXUS necesita un contexto seguro (HTTPS) para el reparto aleatorio.');
    const modulus = 0x100000000;
    const threshold = Math.floor(modulus / limit) * limit;
    const buf = new Uint32Array(1);
    let num;
    do { cryptoAPI.getRandomValues(buf); num = buf[0]; } while (num >= threshold);
    return num % limit;
  }
  function shuffle(input) {
    const copy = Array.from(input);
    for (let i = copy.length - 1; i > 0; i--) {
      const j = integerBelow(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  function code() { return Array.from({length:6}, () => alphabet[integerBelow(alphabet.length)]).join(''); }
  function cardsForPlayers(count) { return count === 2 ? allCardIds.filter(id => !excludes.has(id)) : [...allCardIds]; }
  function expired(created, now = Date.now()) { return Number(created) > 0 && now >= Number(created) + ROOM_TTL_MS; }
  function rematchDeadline(data) {
    if (!data || data.juego?.estado !== 'finalizada') return null;
    const completed = Number(data.juego.finalizadaEn || 0);
    if (!completed) return null;
    const firstRequest = Number(data.primeraSolicitudRevanchaEn || 0);
    const deadline = (firstRequest >= completed ? firstRequest : completed) + REMATCH_MS;
    const created = Number(data.creadaEn || 0);
    return created ? Math.min(deadline, created + ROOM_TTL_MS) : deadline;
  }
  function shouldDelete(data, now = Date.now()) {
    if (!data) return false;
    return expired(data.creadaEn, now) || (rematchDeadline(data) !== null && now >= rematchDeadline(data));
  }
  function rematchOpen(data, now=Date.now()) {
    const deadline = rematchDeadline(data);
    return deadline !== null && !expired(data.creadaEn,now) && now < deadline;
  }
  function safeName(input) {
    const name = String(input || '').trim().replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g,'');
    if (!name || name.length > 20 || /[<>]/.test(name)) throw new Error('El nombre debe tener entre 1 y 20 caracteres y no incluir < ni >.');
    return name;
  }
  root.NexusCore = Object.freeze({ROOM_TTL_MS,REMATCH_MS,allCardIds,twoPlayerExcluded,integerBelow,shuffle,code,cardsForPlayers,expired,rematchDeadline,shouldDelete,rematchOpen,safeName});
})(typeof window !== 'undefined' ? window : globalThis);

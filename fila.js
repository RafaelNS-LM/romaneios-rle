/* Romaneios RLE – fila de envio
 * Usada pela tela E pelo service worker (2º plano). Tudo fica salvo no celular (IndexedDB):
 * se o app for interrompido (ligação, tela apagada, app fechado), nada se perde e o envio continua depois.
 */
(function (G) {
  'use strict';
  // ===== ENDEREÇO DO APPS SCRIPT (link /exec da implantação) =====
  var API_URL = 'https://script.google.com/macros/s/AKfycbzHcj3rySMnKuD1IvmM6ctr0X-Wo9KqnUhu5YveWdKchJkjIVxFye_jpVlgWcaM9_oo/exec';

  var DB_NOME = 'romaneios-rle', DB_VER = 1;
  var SIMULTANEOS = 3;                         // fotos enviadas ao mesmo tempo
  var ESPERAS = [3000, 8000, 20000, 45000];    // retentativas automáticas após erro
  var TIMEOUT = 150000;                        // desiste de uma resposta após 2,5 min (e tenta de novo)
  var PRESO = 4 * 60 * 1000;                   // "enviando" parado há mais que isso = foi interrompido

  // ---------------- banco local ----------------
  var dbP = null;
  function abrirDB() {
    if (dbP) return dbP;
    dbP = new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NOME, DB_VER);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains('itens')) db.createObjectStore('itens', { keyPath: 'id' });   // status e miniatura
        if (!db.objectStoreNames.contains('dados')) db.createObjectStore('dados', { keyPath: 'id' });   // foto/PDF (pesado)
      };
      r.onsuccess = function () {
        var db = r.result;
        db.onclose = db.onversionchange = function () { try { db.close(); } catch (e) {} dbP = null; };
        res(db);
      };
      r.onerror = function () { dbP = null; rej(r.error); };
    });
    return dbP;
  }
  function pedido(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function fim(t) { return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = t.onabort = function () { rej(t.error); }; }); }
  async function listar() {
    var db = await abrirDB();
    return pedido(db.transaction('itens', 'readonly').objectStore('itens').getAll());
  }
  async function pegar(store, id) {
    var db = await abrirDB();
    return pedido(db.transaction(store, 'readonly').objectStore(store).get(id));
  }
  async function gravar(item, dados) {
    var db = await abrirDB();
    var t = db.transaction(['itens', 'dados'], 'readwrite');
    if (item) t.objectStore('itens').put(item);
    if (dados) t.objectStore('dados').put(dados);
    return fim(t);
  }
  async function apagar(id, soDados) {
    var db = await abrirDB();
    var t = db.transaction(['itens', 'dados'], 'readwrite');
    if (!soDados) t.objectStore('itens').delete(id);
    t.objectStore('dados').delete(id);
    return fim(t);
  }

  // ---------------- servidor ----------------
  async function chamar(acao, args) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tm = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT) : null;
    var resp;
    try {
      resp = await fetch(API_URL, {
        method: 'POST', redirect: 'follow', signal: ctrl ? ctrl.signal : undefined,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ acao: acao, args: args || [] })
      });
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'Sem resposta do servidor (tentando de novo).' : 'Falha de conexão (tentando de novo).');
    } finally { if (tm) clearTimeout(tm); }
    var txt = await resp.text(), json;
    try { json = JSON.parse(txt); } catch (e) { throw new Error('Resposta inesperada do servidor.'); }
    if (!json.ok) throw new Error(json.erro || 'Erro no servidor.');
    return json.resultado;
  }

  // ---------------- avisos para a tela ----------------
  var ouvintes = [];
  function aoMudar(fn) { ouvintes.push(fn); }
  function avisar(item) {
    var leve = {};
    for (var k in item) leve[k] = item[k];
    ouvintes.forEach(function (fn) { try { fn(leve); } catch (e) {} });
  }

  // ---------------- processamento ----------------
  function elegivel(i, agora) {
    if (i.status === 'fila') return true;
    if (i.status === 'erro' && (i.tentativas || 0) <= ESPERAS.length && (i.proxTentativa || 0) <= agora) return true;
    if (i.status === 'enviando' && agora - (i.inicio || 0) > PRESO) return true;
    return false;
  }
  function dormir(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function enviarItem(item) {
    item.status = 'enviando'; item.inicio = Date.now();
    await gravar(item); avisar(item);
    try {
      var d = await pegar('dados', item.id);
      if (!d || !d.payload) throw new Error('Foto não encontrada no aparelho.');
      var args = {};
      for (var k in d.payload) args[k] = d.payload[k];
      args.idFoto = item.id; args.enviadoPor = item.enviadoPor || ''; args.forcar = !!item.forcar;
      var r = await chamar('processarFoto', [args]);
      var atual = await pegar('itens', item.id);
      if (!atual) return;                         // removido pela pessoa durante o envio
      item = atual;
      if (r.duplicado) { item.status = 'dup'; item.dup = r; }
      else { item.status = 'ok'; item.res = r; await apagar(item.id, true); }   // libera espaço
      item.erro = null;
    } catch (e) {
      var atual2 = await pegar('itens', item.id);
      if (!atual2) return;
      item = atual2;
      item.tentativas = (item.tentativas || 0) + 1;
      item.status = 'erro';
      item.erro = (e && e.message) || String(e);
      item.proxTentativa = Date.now() + ESPERAS[Math.min(item.tentativas - 1, ESPERAS.length - 1)];
    }
    await gravar(item); avisar(item);
  }

  var rodando = null;
  function processar() {
    if (rodando) return rodando;
    rodando = (async function () {
      var ocupados = {};
      try {
        while (true) {
          var agora = Date.now();
          var itens = await listar();
          var prontos = itens.filter(function (i) { return !ocupados[i.id] && elegivel(i, agora); })
            .sort(function (a, b) { return a.criado - b.criado; });
          var vagas = SIMULTANEOS - Object.keys(ocupados).length;
          if (prontos.length && vagas > 0) {
            prontos.slice(0, vagas).forEach(function (i) {
              ocupados[i.id] = enviarItem(i).catch(function () {}).then(function () { delete ocupados[i.id]; });
            });
          }
          var emAndamento = Object.keys(ocupados).map(function (k) { return ocupados[k]; });
          if (emAndamento.length) { await Promise.race(emAndamento.concat([dormir(1500)])); continue; }
          // nada enviando: há erro aguardando nova tentativa automática?
          var esperas = itens.filter(function (i) { return i.status === 'erro' && (i.tentativas || 0) <= ESPERAS.length; })
            .map(function (i) { return (i.proxTentativa || 0) - agora; });
          if (esperas.length) { await dormir(Math.max(800, Math.min.apply(null, esperas))); continue; }
          break;
        }
      } finally { rodando = null; }
      var resto = (await listar()).filter(function (i) { return i.status === 'fila' || i.status === 'enviando'; });
      return resto.length === 0;
    })();
    return rodando;
  }

  G.RLEFila = {
    API_URL: API_URL, chamar: chamar, processar: processar, aoMudar: aoMudar,
    listar: listar, pegar: pegar, gravar: gravar, apagar: apagar,
    pendentes: async function () {
      return (await listar()).filter(function (i) {
        return i.status === 'fila' || i.status === 'enviando' || (i.status === 'erro' && (i.tentativas || 0) <= ESPERAS.length);
      }).length;
    }
  };
})(typeof self !== 'undefined' ? self : this);

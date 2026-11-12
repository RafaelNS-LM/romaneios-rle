/**
 * ROMANEIOS - RLE  |  Arquivo e Pesquisa de Protocolos de Carregamento
 * Web app do Google Apps Script (Drive pessoal, acesso por link, sem login).
 *
 *  - Recebe as fotos do romaneio e lê o texto (OCR do Google)
 *  - Salva o PDF em:  Romaneios - RLE / <Destinatário> / <AAAA-MM> / <data>_<hora>_<destinatário>.pdf
 *    (romaneio com mais de um destinatário vai para a pasta "Outras Lojas")
 *  - Data/hora registrada = momento do envio
 *  - Registra cada envio na planilha "Romaneios - RLE - Índice" (base da pesquisa)
 *  - Nº Lista, pedidos e NFs são lidos em segundo plano: servem para a pesquisa
 *    e para avisar se o mesmo romaneio já foi enviado
 *
 * Requisito: Serviços (+) > "Drive API" ativado no editor do Apps Script.
 */

const CONFIG = {
  PASTA_RAIZ_ID: '',               // vazio = cria/usa a pasta "Romaneios - RLE" no Meu Drive. Para usar outra pasta, cole aqui o ID dela.
  NOME_PASTA_RAIZ: 'Romaneios - RLE',
  NOME_PLANILHA: 'Romaneios - RLE - Índice',
  PASTA_MISTURADO: 'Outras Lojas',
  SUBPASTA_POR_MES: true,          // false = salva direto na pasta do destinatário
  PDF_ABERTO_POR_LINK: true,       // cada PDF abre por link sem login (o link só aparece dentro da ferramenta)
  FUSO: 'America/Sao_Paulo',
  MAX_RESULTADOS: 100
};

const CAB = [
  'Enviado em', 'Destinatário (pasta)', 'Destinatários no romaneio', 'Qtd entregas',
  'Nº Lista', 'Entregas', 'NFs', 'Pedidos', 'Páginas',
  'Arquivo', 'Link', 'Enviado por', 'ID arquivo', 'Texto OCR'
];
const COL = {};
CAB.forEach(function (c, i) { COL[c] = i; });

// ============================================================ WEB APP
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Romaneios - RLE')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Rode UMA vez pelo editor para autorizar e criar a pasta e a planilha. */
function testarConfiguracao() {
  const raiz = pastaRaiz_();
  const sh = planilha_();
  if (typeof Drive === 'undefined') {
    throw new Error('Falta ativar o serviço "Drive API": no editor, clique em Serviços (+) > Drive API > Adicionar.');
  }
  Logger.log('OK! Pasta: ' + raiz.getUrl());
  Logger.log('OK! Planilha índice: ' + sh.getParent().getUrl());
}

/** Dados iniciais da tela: destinatários existentes + últimos envios. */
function inicial() {
  return { destinatarios: listarDestinatarios_(), recentes: pesquisar('', '') };
}

// ============================================================ LEITURA (OCR)
/** @param {string[]} imagensBase64 páginas em JPEG (base64, sem prefixo data:) */
function lerRomaneio(imagensBase64) {
  const imgs = [].concat(imagensBase64 || []);
  const textos = [];
  let erroOcr = '';
  imgs.forEach(function (b64, i) {
    try {
      const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'pag' + (i + 1) + '.jpg');
      textos.push(ocr_(blob));
    } catch (e) {
      erroOcr = String((e && e.message) || e);
    }
  });
  const dados = extrairDados_(textos.join('\n'));
  dados.erroOcr = erroOcr;
  dados.destinatariosExistentes = listarDestinatarios_();
  return dados;
}

function ocr_(blob) {
  if (typeof Drive === 'undefined') {
    throw new Error('Leitura automática desligada: ative o serviço "Drive API" no editor do Apps Script.');
  }
  let arq;
  if (Drive.Files.create) { // Drive API v3
    arq = Drive.Files.create({ name: 'ocr_tmp_romaneio', mimeType: MimeType.GOOGLE_DOCS }, blob, { ocrLanguage: 'pt' });
  } else {                  // Drive API v2
    arq = Drive.Files.insert({ title: 'ocr_tmp_romaneio', mimeType: MimeType.GOOGLE_DOCS }, blob, { ocr: true, ocrLanguage: 'pt' });
  }
  try {
    return DocumentApp.openById(arq.id).getBody().getText();
  } finally {
    try { Drive.Files.remove(arq.id); } catch (e) { DriveApp.getFileById(arq.id).setTrashed(true); }
  }
}

/** Extrai os dados do texto lido. Destinatário e quantidade são conferidos pela pessoa antes de salvar. */
function extrairDados_(texto) {
  const t = String(texto || '');
  const T = t.toUpperCase();
  const out = {
    textoOcr: t, lista: '', destinatario: '', destinatariosDetectados: [], misturado: false,
    entregas: [], nfs: [], pedidos: [], qtdEntregas: 0
  };

  // Nº Lista (cabeçalho ou URL do rodapé ".../imprimir-lista/21546559") – só para pesquisa e duplicidade
  const m = T.match(/LISTA\D{0,15}?(\d{7,10})/) || T.match(/IMPRIMIR-LISTA\/(\d{6,10})/);
  if (m) out.lista = m[1];

  // Destinatários (códigos tipo SC1087). Corrige confusões comuns do OCR: O→0, I/L→1
  const cont = {};
  const reDest = /\b([A-Z]{2})([0-9OIL]{3,5})\b/g;
  let md;
  while ((md = reDest.exec(T)) !== null) {
    if ((md[2].match(/\d/g) || []).length < 2) continue;
    const cod = md[1] + md[2].replace(/O/g, '0').replace(/[IL]/g, '1');
    cont[cod] = (cont[cod] || 0) + 1;
  }
  let dets = Object.keys(cont).map(function (k) { return { codigo: k, qtd: cont[k] }; })
    .sort(function (a, b) { return b.qtd - a.qtd; });
  if (dets.length) {
    const topo = dets[0];
    // variação de 1 caractere com poucas ocorrências = provável erro de leitura
    dets = dets.filter(function (d, i) {
      if (i === 0) return true;
      if (d.qtd < 2) return false;
      if (d.qtd < 3 && difere1_(d.codigo, topo.codigo)) { topo.qtd += d.qtd; return false; }
      return true;
    });
  }
  out.destinatariosDetectados = dets;
  out.misturado = dets.length > 1;
  out.destinatario = out.misturado ? CONFIG.PASTA_MISTURADO : (dets[0] ? dets[0].codigo : '');

  // Entregas (9 dígitos), pedidos (16 dígitos ou 160832374-NE-1) e NFs (17760/2)
  out.entregas = unicos_(T.match(/\b\d{9}\b(?![-:])/g));
  out.pedidos = unicos_((T.match(/\b\d{16}\b/g) || [])
    .concat((T.match(/\b\d{6,12}[-:][A-Z]{2}[-:]\d{1,2}\b/g) || []).map(function (s) { return s.replace(/:/g, '-'); })));
  out.nfs = unicos_(T.match(/\b\d{3,8}\/[0-9A-Z]{1,2}\b/g));

  // Quantidade de entregas = maior contagem entre as colunas lidas (cada linha tem 1 entrega, 1 pedido, 1 NF, 1 destinatário)
  const somaDest = dets.reduce(function (s, d) { return s + d.qtd; }, 0);
  out.qtdEntregas = Math.max(out.entregas.length, out.pedidos.length, out.nfs.length, somaDest);
  return out;
}

// ============================================================ SALVAR
/**
 * p = { pdfBase64 | imagens[], paginas, destinatario, destinatariosNoRomaneio, qtdEntregas,
 *       lista, entregas, nfs, pedidos, textoOcr, enviadoPor, forcar }
 */
function salvarRomaneio(p) {
  p = p || {};
  const lista = String(p.lista || '').replace(/\D/g, '');
  const dest = nomeSeguro_(p.destinatario) || 'Sem destinatário';
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = planilha_();
    if (lista && !p.forcar) {
      const dup = buscarLista_(sh, lista);
      if (dup) return { duplicado: true, existente: dup };
    }

    const agora = new Date();
    const raiz = pastaRaiz_();
    let pasta = subpasta_(raiz, dest);
    let caminho = raiz.getName() + ' / ' + dest;
    if (CONFIG.SUBPASTA_POR_MES) {
      const mes = Utilities.formatDate(agora, CONFIG.FUSO, 'yyyy-MM');
      pasta = subpasta_(pasta, mes);
      caminho += ' / ' + mes;
    }

    const nome = Utilities.formatDate(agora, CONFIG.FUSO, 'yyyy-MM-dd_HH\'h\'mm\'m\'ss') + '_' +
      dest.replace(/\s+/g, '-') + '.pdf';

    const blob = p.pdfBase64
      ? Utilities.newBlob(Utilities.base64Decode(p.pdfBase64), 'application/pdf', nome)
      : pdfDeImagens_(p.imagens || [], nome);
    blob.setName(nome);
    const arq = pasta.createFile(blob);
    if (CONFIG.PDF_ABERTO_POR_LINK) {
      // o time não faz login: sem isso, o "Abrir PDF" pediria permissão de acesso
      try { arq.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* segue sem compartilhar */ }
    }

    const entregas = texto_(p.entregas), nfs = texto_(p.nfs), pedidos = texto_(p.pedidos);
    const qtd = parseInt(p.qtdEntregas, 10);
    try {
      arq.setDescription(('Destinatário ' + dest + ' | ' + (isNaN(qtd) ? '' : qtd + ' entregas') +
        (lista ? ' | Lista ' + lista : '') + ' | Pedidos: ' + pedidos + ' | NFs: ' + nfs).slice(0, 3800));
    } catch (e) { /* descrição é opcional */ }

    const linha = [];
    linha[COL['Enviado em']] = agora;
    linha[COL['Destinatário (pasta)']] = dest;
    linha[COL['Destinatários no romaneio']] = texto_(p.destinatariosNoRomaneio) || dest;
    linha[COL['Qtd entregas']] = isNaN(qtd) ? '' : qtd;
    linha[COL['Nº Lista']] = "'" + lista;
    linha[COL['Entregas']] = "'" + entregas;
    linha[COL['NFs']] = "'" + nfs;
    linha[COL['Pedidos']] = "'" + pedidos;
    linha[COL['Páginas']] = p.paginas || 1;
    linha[COL['Arquivo']] = nome;
    linha[COL['Link']] = arq.getUrl();
    linha[COL['Enviado por']] = p.enviadoPor || '';
    linha[COL['ID arquivo']] = arq.getId();
    linha[COL['Texto OCR']] = String(p.textoOcr || '').slice(0, 45000);
    sh.appendRow(linha);

    return {
      ok: true, url: arq.getUrl(), nome: nome, caminho: caminho,
      enviadoEm: Utilities.formatDate(agora, CONFIG.FUSO, 'dd/MM/yyyy HH:mm')
    };
  } finally {
    lock.releaseLock();
  }
}

/** Plano B (se a biblioteca de PDF não carregar no aparelho): monta o PDF no servidor. */
function pdfDeImagens_(imagens, nome) {
  if (!imagens.length) throw new Error('Nenhuma imagem recebida.');
  const doc = DocumentApp.create('tmp_' + nome);
  const body = doc.getBody();
  body.setMarginTop(14).setMarginBottom(14).setMarginLeft(14).setMarginRight(14);
  const maxW = body.getPageWidth() - 28, maxH = body.getPageHeight() - 40;
  imagens.forEach(function (b64, i) {
    const blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', 'p' + i + '.jpg');
    const par = i === 0 ? body.getParagraphs()[0] : body.appendParagraph('');
    const img = par.appendInlineImage(blob);
    const r = Math.min(maxW / img.getWidth(), maxH / img.getHeight(), 1);
    img.setWidth(Math.floor(img.getWidth() * r)).setHeight(Math.floor(img.getHeight() * r));
    if (i < imagens.length - 1) body.appendPageBreak();
  });
  doc.saveAndClose();
  const arqDoc = DriveApp.getFileById(doc.getId());
  const pdf = arqDoc.getAs('application/pdf');
  arqDoc.setTrashed(true);
  return pdf;
}

// ============================================================ PESQUISA
/** Busca por qualquer termo (destinatário, data dd/mm/aaaa, lista, pedido, NF, quem enviou). */
function pesquisar(termo, destFiltro) {
  const sh = planilha_();
  const n = sh.getLastRow();
  if (n < 2) return { total: 0, itens: [] };
  const vals = sh.getRange(2, 1, n - 1, CAB.length).getValues();
  const tokens = String(termo || '').trim().split(/\s+/).map(norm_).filter(Boolean);
  const filtro = norm_(destFiltro);
  const itens = [];
  for (let i = vals.length - 1; i >= 0; i--) {
    const r = vals[i];
    if (!r[COL['Link']]) continue;
    if (filtro && norm_(r[COL['Destinatário (pasta)']]) !== filtro &&
        norm_(r[COL['Destinatários no romaneio']]).indexOf(filtro) < 0) continue;
    if (tokens.length) {
      const blob = norm_(dataTxt_(r[COL['Enviado em']]) + ' ' + r.join(' '));
      if (!tokens.every(function (tk) { return blob.indexOf(tk) >= 0; })) continue;
    }
    itens.push(item_(r));
    if (itens.length >= CONFIG.MAX_RESULTADOS) break;
  }
  return { total: itens.length, itens: itens };
}

function item_(r) {
  return {
    enviadoEm: dataTxt_(r[COL['Enviado em']]),
    pasta: String(r[COL['Destinatário (pasta)']]),
    destinatarios: String(r[COL['Destinatários no romaneio']]),
    qtd: String(r[COL['Qtd entregas']]),
    lista: String(r[COL['Nº Lista']]),
    paginas: String(r[COL['Páginas']]),
    enviadoPor: String(r[COL['Enviado por']]),
    link: String(r[COL['Link']])
  };
}

function buscarLista_(sh, lista) {
  const n = sh.getLastRow();
  if (n < 2) return null;
  const vals = sh.getRange(2, 1, n - 1, CAB.length).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][COL['Nº Lista']]).replace(/\D/g, '') === lista && vals[i][COL['Link']]) return item_(vals[i]);
  }
  return null;
}

// ============================================================ INFRA
function pastaRaiz_() {
  if (CONFIG.PASTA_RAIZ_ID) return DriveApp.getFolderById(CONFIG.PASTA_RAIZ_ID);
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PASTA_RAIZ_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) {
        if (f.getName() !== CONFIG.NOME_PASTA_RAIZ) f.setName(CONFIG.NOME_PASTA_RAIZ);
        return f;
      }
    } catch (e) { /* recria abaixo */ }
  }
  const raizDrive = DriveApp.getRootFolder();
  const it = raizDrive.getFoldersByName(CONFIG.NOME_PASTA_RAIZ);
  const pasta = it.hasNext() ? it.next() : raizDrive.createFolder(CONFIG.NOME_PASTA_RAIZ);
  props.setProperty('PASTA_RAIZ_ID', pasta.getId());
  return pasta;
}

function planilha_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PLANILHA_ID');
  let ss = null;
  if (id) {
    try { if (!DriveApp.getFileById(id).isTrashed()) ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    const raiz = pastaRaiz_();
    const it = raiz.getFilesByName(CONFIG.NOME_PLANILHA);
    if (it.hasNext()) {
      ss = SpreadsheetApp.open(it.next());
    } else {
      ss = SpreadsheetApp.create(CONFIG.NOME_PLANILHA);
      DriveApp.getFileById(ss.getId()).moveTo(raiz);
    }
    props.setProperty('PLANILHA_ID', ss.getId());
  }
  let sh = ss.getSheets()[0];
  const cabAtual = sh.getRange(1, 1, 1, CAB.length).getValues()[0];
  const cabOk = CAB.every(function (c, i) { return cabAtual[i] === c; });
  if (!cabOk) {
    if (sh.getLastRow() > 1) {          // dados de uma versão antiga: guarda e começa aba nova
      sh.setName('Índice (antigo ' + Utilities.formatDate(new Date(), CONFIG.FUSO, 'ddMMyy-HHmm') + ')');
      sh = ss.insertSheet('Índice', 0);
    } else {
      sh.clear();
      sh.setName('Índice');
    }
    sh.getRange(1, 1, 1, CAB.length).setValues([CAB])
      .setFontWeight('bold').setBackground('#0b2545').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.hideColumns(COL['ID arquivo'] + 1);
    sh.hideColumns(COL['Texto OCR'] + 1);
  }
  if (ss.getName() !== CONFIG.NOME_PLANILHA) ss.rename(CONFIG.NOME_PLANILHA);
  return sh;
}

function subpasta_(pai, nome) {
  const it = pai.getFoldersByName(nome);
  return it.hasNext() ? it.next() : pai.createFolder(nome);
}

function listarDestinatarios_() {
  const nomes = [];
  const it = pastaRaiz_().getFolders();
  while (it.hasNext()) nomes.push(it.next().getName());
  if (nomes.indexOf(CONFIG.PASTA_MISTURADO) < 0) nomes.push(CONFIG.PASTA_MISTURADO);
  return nomes.sort();
}

// ============================================================ UTIL
function dataTxt_(d) {
  return d instanceof Date ? Utilities.formatDate(d, CONFIG.FUSO, 'dd/MM/yyyy HH:mm') : String(d || '');
}
function nomeSeguro_(s) {
  return String(s || '').replace(/[\\\/:*?"<>|#%]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function texto_(v) {
  return Array.isArray(v) ? v.join(', ') : String(v || '').trim();
}
function unicos_(arr) {
  const vistos = {}, out = [];
  (arr || []).forEach(function (x) { if (!vistos[x]) { vistos[x] = 1; out.push(x); } });
  return out;
}
function difere1_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d === 1;
}
function norm_(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s\-\/.,:]/g, '');
}

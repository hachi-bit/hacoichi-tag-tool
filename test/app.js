// ハコイチ値札加工ツール
// すべての処理はブラウザ内で完結（PDFはサーバーに送信されません）

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs";

const MM = 2.83465; // pt per mm
const RENDER_SCALE = 4; // render resolution multiplier for card detection

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const processStatusEl = document.getElementById("processStatus");
const optionsEl = document.getElementById("options");
const processBtn = document.getElementById("processBtn");
const previewArea = document.getElementById("previewArea");
const previewPagesEl = document.getElementById("previewPages");
const downloadLink = document.getElementById("downloadLink");
const cutGuideEnabledInput = document.getElementById("cutGuideEnabled");
const stapleEnabledInput = document.getElementById("stapleEnabled");
const cardMarginInput = document.getElementById("cardMargin");
const cardTrimInput = document.getElementById("cardTrim");
const marginAboveRow = document.getElementById("marginAboveRow");
const marginBelowRow = document.getElementById("marginBelowRow");
const marginAboveInput = document.getElementById("marginAbove");
const marginBelowInput = document.getElementById("marginBelow");
const gapMmInput = document.getElementById("gapMm");
const schematicPreview = document.getElementById("schematicPreview");
const cardsSectionEl = document.getElementById("cardsSection");
const cardsListEl = document.getElementById("cardsList");

let currentFileBytes = null;
let allCardsByPage = null; // detection result for the current file, cached so re-clicking "変換する" doesn't re-detect
let trimPreviewSource = null; // a real, uncropped raster of one detected card, shown in the schematic in place of the placeholder
let trimPreviewCardWpt = 0;
let trimPreviewCardHpt = 0;

// parseFloat(...) || fallback would wrongly replace a legitimate 0 with the
// fallback (0 is falsy), so check for a finite number instead.
function numOr(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---- live schematic preview (illustrative sizing, not the loaded PDF's actual card size) ----
const SCHEM_PX_PER_MM = 3.6;
const SCHEM_CARD_W_MM = 42;
const SCHEM_CARD_H_MM = 25;

function schemPx(mm) {
  return mm * SCHEM_PX_PER_MM;
}

function schemTagHtml(tagWmm, tagHmm, cardMarginMm, marginAboveMm, foldMm, cardWmm, cardHmm, cardImgSrc, showStaple, showCutGuide) {
  const staple = showStaple
    ? `<div class="schem-fold" style="top:${schemPx(foldMm)}px;"></div>
       <div class="schem-cross" style="top:${schemPx(marginAboveMm)}px;">⊕</div>`
    : "";
  const border = showCutGuide ? "1px dashed #b9b2a3" : "none";
  // once a real card is detected, show it (cropped by the current trim)
  // instead of the generic hatched placeholder
  const cardStyle = cardImgSrc
    ? `background-image:url(${cardImgSrc}); background-size:cover; background-position:center; background-repeat:no-repeat;`
    : "";
  return `
    <div class="schem-tag" style="width:${schemPx(tagWmm)}px;height:${schemPx(tagHmm)}px;border:${border};">
      ${staple}
      <div class="schem-card" style="left:${schemPx(cardMarginMm)}px; top:${schemPx(foldMm)}px; width:${schemPx(cardWmm)}px; height:${schemPx(cardHmm)}px; ${cardStyle}"></div>
    </div>
  `;
}

// offscreen canvas used only to crop the real reference card at the current
// trim amount for the schematic preview below
const trimCropCanvas = document.createElement("canvas");
function cropTrimPreview(trimMm) {
  const trimPx = trimMm * MM * RENDER_SCALE;
  const sw = Math.max(1, trimPreviewSource.width - 2 * trimPx);
  const sh = Math.max(1, trimPreviewSource.height - 2 * trimPx);
  const sx = Math.min(trimPx, trimPreviewSource.width / 2);
  const sy = Math.min(trimPx, trimPreviewSource.height / 2);
  trimCropCanvas.width = sw;
  trimCropCanvas.height = sh;
  trimCropCanvas.getContext("2d").drawImage(trimPreviewSource, sx, sy, sw, sh, 0, 0, sw, sh);
  return trimCropCanvas.toDataURL("image/png");
}

function renderSchematic() {
  const showStaple = stapleEnabledInput.checked;
  const showCutGuide = cutGuideEnabledInput.checked;
  marginAboveRow.hidden = !showStaple;
  marginBelowRow.hidden = !showStaple;
  let cardMarginMm = Math.max(0, numOr(cardMarginInput.value, 3));
  // a cut guide drawn flush against the card's own edge (margin 0) has no
  // room of its own - it sits exactly on the card's edge (or, for touching
  // cards, on both neighbors' edges at once) and gets covered or doubled up,
  // so reserve a sliver of real space for it whenever it's on
  if (showCutGuide) cardMarginMm = Math.max(cardMarginMm, 1);
  // without a staple mark there's no special top region to reserve - just
  // give the card the same small margin on every side
  const marginAboveMm = showStaple ? numOr(marginAboveInput.value, 0) : cardMarginMm;
  const marginBelowMm = showStaple ? numOr(marginBelowInput.value, 0) : 0;
  const gapMm = Math.max(0, numOr(gapMmInput.value, 0));
  const cardTrimMm = Math.max(0, numOr(cardTrimInput.value, 2));
  const foldMm = marginAboveMm + marginBelowMm;

  let cardWmm = SCHEM_CARD_W_MM;
  let cardHmm = SCHEM_CARD_H_MM;
  let cardImgSrc = null;
  if (trimPreviewSource) {
    cardWmm = Math.max(4, trimPreviewCardWpt / MM - 2 * cardTrimMm);
    cardHmm = Math.max(4, trimPreviewCardHpt / MM - 2 * cardTrimMm);
    cardImgSrc = cropTrimPreview(cardTrimMm);
  }

  const tagWmm = cardMarginMm * 2 + cardWmm;
  const tagHmm = foldMm + cardHmm + cardMarginMm;
  const tag = schemTagHtml(tagWmm, tagHmm, cardMarginMm, marginAboveMm, foldMm, cardWmm, cardHmm, cardImgSrc, showStaple, showCutGuide);
  schematicPreview.innerHTML = `${tag}<div class="schem-gap" style="width:${schemPx(gapMm)}px;"></div>${tag}`;
}

function adjustValue(input, step) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  let next = numOr(input.value, 0) + step;
  if (!Number.isNaN(min)) next = Math.max(min, next);
  if (!Number.isNaN(max)) next = Math.min(max, next);
  input.value = next;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// tap = one step; press and hold = repeat, so reaching the far end of a
// range doesn't take dozens of individual taps. Delegated on `document`
// (rather than attached per-button at load) so it also covers the
// per-card count steppers, which don't exist yet until a PDF is detected.
let repeatTimer = null;
function stopRepeat() {
  clearTimeout(repeatTimer);
  window.removeEventListener("pointerup", stopRepeat);
  window.removeEventListener("pointercancel", stopRepeat);
}
document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest(".step-btn");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.target);
  const step = parseFloat(btn.dataset.step);
  e.preventDefault();
  adjustValue(input, step);
  window.addEventListener("pointerup", stopRepeat);
  window.addEventListener("pointercancel", stopRepeat);
  repeatTimer = setTimeout(function tick() {
    adjustValue(input, step);
    repeatTimer = setTimeout(tick, 90);
  }, 450);
});

cutGuideEnabledInput.addEventListener("change", renderSchematic);
stapleEnabledInput.addEventListener("change", renderSchematic);
cardMarginInput.addEventListener("input", renderSchematic);
marginAboveInput.addEventListener("input", renderSchematic);
marginBelowInput.addEventListener("input", renderSchematic);
gapMmInput.addEventListener("input", renderSchematic);
cardTrimInput.addEventListener("input", renderSchematic);
renderSchematic();

// upload/detection messages go next to the dropzone; conversion messages go
// next to the "変換する" button - each near the control that triggered it,
// so an error doesn't end up out of view above a long cards/settings list
function setStatus(msg, kind) {
  setStatusOn(statusEl, msg, kind);
}
function setProcessStatus(msg, kind) {
  setStatusOn(processStatusEl, msg, kind);
}
function setStatusOn(el, msg, kind) {
  el.hidden = false;
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

async function handleFile(file) {
  if (file.type !== "application/pdf") {
    setStatus("PDFファイルを選んでください。", "error");
    return;
  }
  currentFileBytes = new Uint8Array(await file.arrayBuffer());
  allCardsByPage = null;
  trimPreviewSource = null;
  trimPreviewCardWpt = 0;
  trimPreviewCardHpt = 0;
  cardsSectionEl.hidden = true;
  optionsEl.hidden = true;
  previewArea.hidden = true;
  processStatusEl.hidden = true;
  setStatus(`「${file.name}」を読み込みました。カードを検出しています…`, null);

  try {
    allCardsByPage = await detectCards();
    renderCardsList();
    renderSchematic();
    cardsSectionEl.hidden = false;
    optionsEl.hidden = false;
    const totalCards = allCardsByPage.reduce((s, p) => s + p.cards.length, 0);
    setStatus(`${totalCards}件のタグを検出しました。枚数と設定を確認して「変換する」を押してください。`, "ok");
  } catch (err) {
    console.error(err);
    setStatus("エラーが発生しました：" + err.message, "error");
  }
}

// render each source page to a canvas, detect card boxes, and crop a
// thumbnail per card so the "枚数" list can show what each one actually is
async function detectCards() {
  const loadingTask = pdfjsLib.getDocument({ data: currentFileBytes.slice() });
  const doc = await loadingTask.promise;

  const result = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;

    setStatus(`${pageNum}ページ目のカードを検出しています…`, null);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const boxesPx = detectCardBoxes(imgData, canvas.width, canvas.height);
    if (boxesPx.length === 0) {
      throw new Error(
        `${pageNum}ページ目で商品カードを検出できませんでした。フォーマットが対応していない可能性があります。`
      );
    }
    const pageHeightPt = viewport.height / RENDER_SCALE;
    const THUMB_W = 160;
    const sortedBoxes = boxesPx.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
    const cardsPt = sortedBoxes.map((b) => {
      const wPx = b.maxX - b.minX, hPx = b.maxY - b.minY;
      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = THUMB_W;
      thumbCanvas.height = Math.round((hPx / wPx) * THUMB_W);
      thumbCanvas
        .getContext("2d")
        .drawImage(canvas, b.minX, b.minY, wPx, hPx, 0, 0, thumbCanvas.width, thumbCanvas.height);
      return {
        x0: b.minX / RENDER_SCALE,
        x1: b.maxX / RENDER_SCALE,
        top: b.minY / RENDER_SCALE,
        bottom: b.maxY / RENDER_SCALE,
        thumbUrl: thumbCanvas.toDataURL("image/png"),
      };
    });
    if (!trimPreviewSource) {
      // keep a real, full-resolution, uncropped copy of one card so
      // "カードのふちを削る" can show the actual crop instead of a mock-up
      const b = sortedBoxes[0];
      const src = document.createElement("canvas");
      src.width = b.maxX - b.minX;
      src.height = b.maxY - b.minY;
      src.getContext("2d").drawImage(canvas, b.minX, b.minY, src.width, src.height, 0, 0, src.width, src.height);
      trimPreviewSource = src;
      trimPreviewCardWpt = src.width / RENDER_SCALE;
      trimPreviewCardHpt = src.height / RENDER_SCALE;
    }
    result.push({ pageIndex: pageNum - 1, pageHeightPt, cards: cardsPt });
  }
  return result;
}

function renderCardsList() {
  let idx = 0;
  const items = [];
  for (const page of allCardsByPage) {
    for (const c of page.cards) {
      c.countInputId = `cardCount${idx}`;
      items.push(`
        <div class="card-item">
          <img class="card-thumb" src="${c.thumbUrl}" alt="検出したタグ ${idx + 1}">
          <span class="stepper">
            <button type="button" class="step-btn" data-target="${c.countInputId}" data-step="-1" aria-label="1枚減らす">－</button>
            <input type="number" id="${c.countInputId}" value="1" min="0" max="50" step="1">
            <button type="button" class="step-btn" data-target="${c.countInputId}" data-step="1" aria-label="1枚増やす">＋</button>
            <span class="unit">枚</span>
          </span>
        </div>
      `);
      idx++;
    }
  }
  cardsListEl.innerHTML = items.join("");
}


processBtn.addEventListener("click", () => {
  if (!currentFileBytes || !allCardsByPage) return;
  process().catch((err) => {
    console.error(err);
    processBtn.disabled = false;
    setProcessStatus("エラーが発生しました：" + err.message, "error");
  });
});

async function process() {
  processBtn.disabled = true;
  setProcessStatus("タグPDFを作成しています…", null);

  const showCutGuide = cutGuideEnabledInput.checked;
  const stapleEnabled = stapleEnabledInput.checked;
  let cardMarginMm = Math.max(0, numOr(cardMarginInput.value, 3));
  // a cut guide drawn flush against the card's own edge (margin 0) has no
  // room of its own - it sits exactly on the card's edge (or, for touching
  // cards, on both neighbors' edges at once) and gets covered or doubled up,
  // so reserve a sliver of real space for it whenever it's on
  if (showCutGuide) cardMarginMm = Math.max(cardMarginMm, 1);
  const cardTrimMm = Math.max(0, numOr(cardTrimInput.value, 2));
  // without a staple mark there's no special top region to reserve - just
  // give the card the same margin on every side as the rest of the tag
  const marginAboveMm = stapleEnabled ? numOr(marginAboveInput.value, 8) : cardMarginMm;
  const marginBelowMm = stapleEnabled ? numOr(marginBelowInput.value, 7) : 0;
  const gapMm = numOr(gapMmInput.value, 0);

  const totalCards = allCardsByPage.reduce(
    (s, p) => s + p.cards.reduce((s2, c) => s2 + Math.max(0, Math.round(numOr(document.getElementById(c.countInputId).value, 1))), 0),
    0
  );
  if (totalCards === 0) {
    throw new Error("少なくとも1つのタグの枚数を1枚以上にしてください。");
  }

  const { PDFDocument, rgb } = window.PDFLib;
  const srcDoc = await PDFDocument.load(currentFileBytes);
  const srcPages = srcDoc.getPages();

  const outDoc = await PDFDocument.create();

  const staple_margin_above = marginAboveMm * MM;
  const staple_margin_below = marginBelowMm * MM;
  const staple_margin = staple_margin_above + staple_margin_below;
  const bottom_margin = cardMarginMm * MM;
  const side_margin = cardMarginMm * MM;
  const gap = gapMm * MM;
  const trim = cardTrimMm * MM; // shaves the source card's own border off by cropping it out of the embed
  const min_page_margin = 3 * MM; // printer-safe minimum, not a fixed layout margin
  const page_w = 595.0, page_h = 842.0; // A4

  // cards are usually a consistent size, but height can vary slightly row
  // to row depending on content (e.g. a longer category line), so size the
  // tag grid from the largest card rather than assuming uniform size; each
  // card is still drawn at its own true size below, so nothing gets
  // stretched or squished to fit
  const allCards = allCardsByPage.flatMap((p) => p.cards);
  const maxCardW = Math.max(...allCards.map((c) => Math.max(1, c.x1 - c.x0 - 2 * trim)));
  const maxCardH = Math.max(...allCards.map((c) => Math.max(1, c.bottom - c.top - 2 * trim)));
  const tag_w = side_margin * 2 + maxCardW;
  const tag_h = staple_margin + maxCardH + bottom_margin;

  // fit as many columns/rows as actually fit within a minimal margin, then
  // center the resulting grid so leftover space is spread evenly around it
  // instead of being dumped as one big unused strip on the right/bottom
  const cols = Math.max(1, Math.floor((page_w - 2 * min_page_margin + gap) / (tag_w + gap)));
  const rows = Math.max(1, Math.floor((page_h - 2 * min_page_margin + gap) / (tag_h + gap)));
  const perPage = cols * rows;
  const grid_w = cols * tag_w + (cols - 1) * gap;
  const grid_h = rows * tag_h + (rows - 1) * gap;
  const page_margin_x = (page_w - grid_w) / 2;
  const page_margin_y = (page_h - grid_h) / 2;

  let outPage = null;
  let idx = 0;
  for (const pageInfo of allCardsByPage) {
    const srcPage = srcPages[pageInfo.pageIndex];
    const pageHeight = pageInfo.pageHeightPt;
    for (const c of pageInfo.cards) {
      const count = Math.max(0, Math.round(numOr(document.getElementById(c.countInputId).value, 1)));
      if (count === 0) continue;

      // crop the trim amount off each edge before embedding, so the source
      // card's own border (baked into its vector artwork) is cropped away
      // rather than just covered up
      const cropX0 = c.x0 + trim, cropX1 = c.x1 - trim;
      const cropTop = c.top + trim, cropBottom = c.bottom - trim;
      const card_w = Math.max(1, cropX1 - cropX0);
      const card_h = Math.max(1, cropBottom - cropTop);
      // embedding is the same regardless of how many times this card repeats
      const embedded = await outDoc.embedPage(srcPage, {
        left: cropX0, right: cropX1,
        top: pageHeight - cropTop, bottom: pageHeight - cropBottom,
      });

      for (let n = 0; n < count; n++) {
        const pos = idx % perPage;
        if (pos === 0) outPage = outDoc.addPage([page_w, page_h]);
        const col = pos % cols;
        const row = Math.floor(pos / cols);
        const ox = page_margin_x + col * (tag_w + gap);
        const oyTop = page_margin_y + row * (tag_h + gap);
        const tagBottomY = page_h - (oyTop + tag_h);

        if (showCutGuide) {
          const guideColor = rgb(0.5, 0.5, 0.5);
          const guideWidth = 0.7;
          const dashArray = [4, 2.5];
          const left = ox, right = ox + tag_w;
          const bottom = tagBottomY, top = tagBottomY + tag_h;
          // when tags touch (gap 0) each tag drawing its own full rectangle
          // means the shared edge between two neighbors gets drawn twice -
          // once by each tag - which is redundant, not "a thicker line".
          // Tags are filled left-to-right then top-to-bottom, so a tag's
          // left/top neighbor (when gap is 0) has always already drawn that
          // shared edge; only draw the two edges nothing else owns yet.
          const skipLeft = col > 0 && gap === 0;
          const skipTop = row > 0 && gap === 0;
          if (!skipLeft) {
            outPage.drawLine({ start: { x: left, y: bottom }, end: { x: left, y: top }, color: guideColor, thickness: guideWidth, dashArray });
          }
          if (!skipTop) {
            outPage.drawLine({ start: { x: left, y: top }, end: { x: right, y: top }, color: guideColor, thickness: guideWidth, dashArray });
          }
          outPage.drawLine({ start: { x: right, y: bottom }, end: { x: right, y: top }, color: guideColor, thickness: guideWidth, dashArray });
          outPage.drawLine({ start: { x: left, y: bottom }, end: { x: right, y: bottom }, color: guideColor, thickness: guideWidth, dashArray });
        }

        if (stapleEnabled) {
          const foldYFromTop = oyTop + staple_margin;
          const foldYBottom = page_h - foldYFromTop;
          outPage.drawLine({
            start: { x: ox + 2, y: foldYBottom }, end: { x: ox + tag_w - 2, y: foldYBottom },
            color: rgb(0.7, 0.7, 0.7), thickness: 0.5, dashArray: [1, 2],
          });

          const cx = ox + tag_w / 2;
          const cyFromTop = oyTop + staple_margin_above;
          const cyBottom = page_h - cyFromTop;
          const r = 4.5;
          outPage.drawEllipse({ x: cx, y: cyBottom, xScale: r, yScale: r, borderColor: rgb(0.65, 0.65, 0.65), borderWidth: 0.5 });
          outPage.drawLine({ start: { x: cx - r - 2, y: cyBottom }, end: { x: cx + r + 2, y: cyBottom }, color: rgb(0.65, 0.65, 0.65), thickness: 0.5 });
          outPage.drawLine({ start: { x: cx, y: cyBottom - r - 2 }, end: { x: cx, y: cyBottom + r + 2 }, color: rgb(0.65, 0.65, 0.65), thickness: 0.5 });
        }

        const destX = ox + side_margin;
        const destYTopOffset = oyTop + staple_margin;
        const destYBottom = page_h - (destYTopOffset + card_h);
        outPage.drawPage(embedded, { x: destX, y: destYBottom, width: card_w, height: card_h });

        idx++;
      }
    }
  }

  const outBytes = await outDoc.save();
  const blob = new Blob([outBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  downloadLink.href = url;
  downloadLink.hidden = false;

  await renderPreview(outBytes);

  setProcessStatus(`完成しました！${totalCards}件のタグを作成しました。`, "ok");
  processBtn.disabled = false;
}

async function renderPreview(pdfBytes) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
  const doc = await loadingTask.promise;
  previewPagesEl.innerHTML = "";
  // show every output page, not just the first - otherwise a multi-page
  // result looks like only one sheet was produced until you download it
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.className = "preview-page-canvas";
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const wrapper = document.createElement("div");
    if (doc.numPages > 1) {
      const label = document.createElement("p");
      label.className = "preview-page-label";
      label.textContent = `${pageNum} / ${doc.numPages} ページ目`;
      wrapper.appendChild(label);
    }
    wrapper.appendChild(canvas);
    previewPagesEl.appendChild(wrapper);
  }
  previewArea.hidden = false;
}

// ---- card detection: binarize -> dilate -> connected components -> pick repeating box size ----
function detectCardBoxes(imgData, width, height) {
  const { data } = imgData;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const idx = (rowOff + x) << 2;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
      mask[rowOff + x] = a > 10 && (r < 245 || g < 245 || b < 245) ? 1 : 0;
    }
  }

  const R = 10; // px, merges nearby glyphs/lines while keeping distinct cards separate
  const dil = dilateVert(dilateHoriz(mask, width, height, R), width, height, R);

  const labels = new Int32Array(width * height).fill(-1);
  const boxes = [];
  const stackX = new Int32Array(width * height);
  const stackY = new Int32Array(width * height);
  let nextLabel = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (dil[idx] !== 1 || labels[idx] !== -1) continue;
      let sp = 0;
      stackX[sp] = x; stackY[sp] = y; sp++;
      labels[idx] = nextLabel;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      while (sp > 0) {
        sp--;
        const cx = stackX[sp], cy = stackY[sp];
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx > 0) { const n = cy * width + (cx - 1); if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx - 1; stackY[sp] = cy; sp++; } }
        if (cx < width - 1) { const n = cy * width + (cx + 1); if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx + 1; stackY[sp] = cy; sp++; } }
        if (cy > 0) { const n = (cy - 1) * width + cx; if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx; stackY[sp] = cy - 1; sp++; } }
        if (cy < height - 1) { const n = (cy + 1) * width + cx; if (dil[n] === 1 && labels[n] === -1) { labels[n] = nextLabel; stackX[sp] = cx; stackY[sp] = cy + 1; sp++; } }
      }
      boxes.push({ minX, minY, maxX, maxY, area });
      nextLabel++;
    }
  }

  const minArea = (30 * RENDER_SCALE) * (30 * RENDER_SCALE);
  const big = boxes.filter((b) => b.area > minArea);
  if (big.length === 0) return [];

  // Group by rounded WIDTH, not height: this format lays cards out in fixed-
  // width columns, so a card's width stays the same across every row even
  // when a row's height varies with content (a longer category line, an
  // extra note, etc). Grouping by height would split rows with different
  // content into separate groups, at risk of losing a row entirely - or, for
  // a lone leftover card in a partial last row, losing just that one card -
  // whenever the "most common group" heuristic below picks another row's
  // height. Width doesn't have that problem, so a single group is normally
  // enough to capture every real card regardless of row/column count.
  const buckets = {};
  for (const b of big) {
    const w = b.maxX - b.minX;
    const key = Math.round(w / 15) * 15;
    (buckets[key] = buckets[key] || []).push(b);
  }
  let bestKey = null, bestCount = 0;
  for (const k in buckets) {
    const cnt = buckets[k].length;
    if (cnt > bestCount || (cnt === bestCount && bestKey !== null && Number(k) > Number(bestKey))) {
      bestCount = cnt; bestKey = k;
    }
  }
  if (bestCount < 1) return [];

  // Still keep any other group with 2+ members as a safety net, in case
  // width isn't perfectly uniform (rendering jitter, or a format where it
  // legitimately varies) - same reasoning as above, just belt-and-braces.
  const candidates = [];
  for (const k in buckets) {
    if (buckets[k].length >= 2 || k === bestKey) candidates.push(...buckets[k]);
  }

  // Each card's outer border and its denser inner content (barcode + text)
  // can end up as two separate connected components landing in two
  // different (both legitimately repeating) buckets, double-counting the
  // same physical card. Keep only the outermost box of any such overlap.
  const boxArea = (b) => (b.maxX - b.minX) * (b.maxY - b.minY);
  const containedFraction = (inner, outer) => {
    const ix0 = Math.max(inner.minX, outer.minX);
    const iy0 = Math.max(inner.minY, outer.minY);
    const ix1 = Math.min(inner.maxX, outer.maxX);
    const iy1 = Math.min(inner.maxY, outer.maxY);
    if (ix1 <= ix0 || iy1 <= iy0) return 0;
    return ((ix1 - ix0) * (iy1 - iy0)) / boxArea(inner);
  };
  const byAreaDesc = candidates.slice().sort((a, b) => boxArea(b) - boxArea(a));
  const kept = [];
  for (const b of byAreaDesc) {
    if (!kept.some((k) => containedFraction(b, k) > 0.8)) kept.push(b);
  }
  return kept;
}

function dilateHoriz(src, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    let count = 0;
    for (let x = 0; x < w; x++) {
      const addIdx = x + r, remIdx = x - r - 1;
      if (addIdx < w && src[off + addIdx]) count++;
      if (remIdx >= 0 && src[off + remIdx]) count--;
      out[off + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}
function dilateVert(src, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) {
      const addIdx = y + r, remIdx = y - r - 1;
      if (addIdx < h && src[addIdx * w + x]) count++;
      if (remIdx >= 0 && src[remIdx * w + x]) count--;
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

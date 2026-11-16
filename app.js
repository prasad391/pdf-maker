"use strict";
// =====================================================================
//  Sheet Maker – folder of images -> print-sheet PDF with cut marks
//  Everything runs in the browser. Nothing is uploaded.
// =====================================================================
const {
  PDFDocument, PDFName, PDFHexString, cmyk,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  drawObject, rectangle, clip, endPath,
} = PDFLib;

// ---------- Constants ----------
const PT = 72;                    // 1 inch = 72 PDF points
const THUMB_SIZE = 480;           // preview thumbnails only (never used in the PDF)
const MAX_PREVIEW_PAGES = 60;     // keeps the preview fast on big jobs
const MAX_CANVAS_PIXELS = 250e6;  // browsers cannot make canvases bigger than this

const SHEETS = {
  "13x19":  { w: 13, h: 19, tag: "13x19" },
  "12x18":  { w: 12, h: 18, tag: "12x18" },
  "11x17":  { w: 11, h: 17, tag: "11x17" },
  "a3plus": { w: 329 / 25.4, h: 483 / 25.4, tag: "A3plus" },
  "a3":     { w: 297 / 25.4, h: 420 / 25.4, tag: "A3" },
  "a4":     { w: 210 / 25.4, h: 297 / 25.4, tag: "A4" },
  "letter": { w: 8.5, h: 11, tag: "Letter" },
};

const QUALITY = {
  high:   { dpi: 300, q: 0.95 },
  medium: { dpi: 200, q: 0.85 },
  low:    { dpi: 100, q: 0.70 },
};

// [columns, rows] for every "images per page" choice
const GRIDS = [
  [1, 1], [1, 2], [2, 1], [1, 3], [3, 1], [2, 2], [1, 4], [4, 1],
  [2, 3], [3, 2], [2, 4], [4, 2], [3, 3], [3, 4], [4, 3],
];

// ---------- Page elements ----------
const $ = (id) => document.getElementById(id);
const el = {
  folder: $("folder"), sheet: $("sheet"), orient: $("orient"), layout: $("layout"),
  copies: $("copies"), fit: $("fit"), order: $("order"), rotate: $("rotate"),
  margin: $("margin"), gap: $("gap"), marks: $("marks"), markGap: $("markGap"),
  quality: $("quality"), qDpi: $("qDpi"), qJpeg: $("qJpeg"),
  customW: $("customW"), customH: $("customH"),
  customRow: $("customRow"), qualityRow: $("qualityRow"), dpiInfo: $("dpiInfo"),
  make: $("make"), cancel: $("cancel"), bar: $("bar"), status: $("status"),
  again: $("again"), pages: $("pages"), title: $("previewTitle"), note: $("previewNote"),
};

// ---------- State ----------
let files = [];        // sorted image files
let thumbs = [];       // preview URLs (same order as files)
let dims = [];         // true pixel size of each image {w,h}
let busy = false;
let cancelRequested = false;
let loadToken = 0;
let lastPdfUrl = null;
let lastPdfName = "";

// ---------- Small helpers ----------
const tick = () => new Promise((r) => setTimeout(r, 0));   // lets the page repaint
const fmt = (n) => String(+n.toFixed(2));

function setStatus(msg, kind = "") {
  el.status.textContent = msg;
  el.status.className = kind;
}

function clampNum(input, min, max, def) {
  let v = parseFloat(input.value);
  if (!Number.isFinite(v)) v = def;
  return Math.min(Math.max(v, min), max);
}

// Check the browser can do everything we need
function checkBrowser() {
  const missing = [];
  if (!("webkitdirectory" in el.folder)) missing.push("folder selection");
  if (typeof createImageBitmap !== "function") missing.push("image decoding");
  if (missing.length) {
    setStatus("This browser does not support: " + missing.join(", ") + ". Please use the latest Chrome or Edge.", "error");
    el.folder.disabled = true;
    return false;
  }
  return true;
}

// ---------- Settings (always read through this, values are clamped) ----------
function readSettings() {
  const isCard = el.layout.value === "card5x5";
  const [cols, rows] = isCard ? [5, 5] : el.layout.value.split("x").map(Number);
  // fixed cell size in points (null = normal equal-split layout)
  const cellFixed = isCard ? { w: (54 / 25.4) * PT, h: (86 / 25.4) * PT } : null;

  let wIn, hIn, tag;
  if (el.sheet.value === "custom") {
    wIn = clampNum(el.customW, 3, 60, 13);
    hIn = clampNum(el.customH, 3, 60, 19);
    tag = `${fmt(Math.min(wIn, hIn))}x${fmt(Math.max(wIn, hIn))}`;
  } else {
    const s = SHEETS[el.sheet.value] || SHEETS["13x19"];
    wIn = s.w; hIn = s.h; tag = s.tag;
  }
  const shortSide = Math.min(wIn, hIn), longSide = Math.max(wIn, hIn);
  const landscape = el.orient.value === "landscape";

  let quality;
  if (el.quality.value === "original") quality = { mode: "original" };
  else if (el.quality.value === "custom") {
    quality = { mode: "jpeg", dpi: clampNum(el.qDpi, 50, 1200, 300), q: clampNum(el.qJpeg, 30, 100, 90) / 100 };
  } else {
    const p = QUALITY[el.quality.value] || QUALITY.high;
    quality = { mode: "jpeg", dpi: p.dpi, q: p.q };
  }

  return {
    W: (landscape ? longSide : shortSide) * PT,
    H: (landscape ? shortSide : longSide) * PT,
    tag, cols, rows, cellFixed,
    marginPt: clampNum(el.margin, 0.25, Math.min(2, shortSide / 4), 0.5) * PT,
    gapPt: (clampNum(el.gap, 0, 25, 2) / 25.4) * PT,   // gap is entered in mm
    fit: el.fit.value === "fill" ? "fill" : "fit",
    order: el.order.value === "column" ? "column" : "row",
    autoRotate: el.rotate.checked,
    copies: Math.round(clampNum(el.copies, 1, 50, 1)),
    marksOn: el.marks.value === "on",
    markGapPt: clampNum(el.markGap, 0, 0.25, 0.02) * PT,
    quality,
  };
}

// Show the clamped values back in the boxes so what you see is what is used
function normalizeInputs() {
  const S = readSettings();
  el.copies.value = S.copies;
  el.margin.value = fmt(S.marginPt / PT);
  el.gap.value = fmt((S.gapPt / PT) * 25.4);   // show back in mm
  el.markGap.value = fmt(S.markGapPt / PT);
  if (el.sheet.value === "custom") {
    el.customW.value = fmt(clampNum(el.customW, 3, 60, 13));
    el.customH.value = fmt(clampNum(el.customH, 3, 60, 19));
  }
  if (el.quality.value === "custom") {
    el.qDpi.value = S.quality.dpi;
    el.qJpeg.value = Math.round(S.quality.q * 100);
  }
}

// each image repeated `copies` times, in file order
function buildSequence(S) {
  const seq = [];
  files.forEach((_, i) => { for (let k = 0; k < S.copies; k++) seq.push(i); });
  return seq;
}

// ---------- Geometry (origin = top-left, units = points) ----------
function getCells(S) {
  let cellW, cellH, offX = S.marginPt, offY = S.marginPt;

  if (S.cellFixed) {
    // fixed-size cells, whole grid centred on the sheet
    cellW = S.cellFixed.w;
    cellH = S.cellFixed.h;
    const gridW = cellW * S.cols + S.gapPt * (S.cols - 1);
    const gridH = cellH * S.rows + S.gapPt * (S.rows - 1);
    if (gridW > S.W - 2 * S.marginPt + 0.01 || gridH > S.H - 2 * S.marginPt + 0.01) return null;
    offX = (S.W - gridW) / 2;
    offY = (S.H - gridH) / 2;
  } else {
    cellW = (S.W - 2 * S.marginPt - S.gapPt * (S.cols - 1)) / S.cols;
    cellH = (S.H - 2 * S.marginPt - S.gapPt * (S.rows - 1)) / S.rows;
    if (cellW < PT * 0.5 || cellH < PT * 0.5) return null;    // no room for images
  }

  const cells = [];
  for (let r = 0; r < S.rows; r++) {
    for (let c = 0; c < S.cols; c++) {
      cells.push({
        x: offX + c * (cellW + S.gapPt),
        y: offY + r * (cellH + S.gapPt),
        w: cellW, h: cellH, r, c,
      });
    }
  }
  if (S.order === "column") cells.sort((a, b) => a.c - b.c || a.r - b.r);
  return cells;
}

// Where the image goes inside its cell. Never stretched.
function placeImage(cell, iw, ih, S) {
  let rot = false;
  if (S.autoRotate) {
    const normal = Math.min(cell.w / iw, cell.h / ih);
    const turned = Math.min(cell.w / ih, cell.h / iw);
    rot = turned > normal * 1.0001;
  }
  const dw = rot ? ih : iw;                 // size as it appears on the page
  const dh = rot ? iw : ih;
  const scale = S.fit === "fill"
    ? Math.max(cell.w / dw, cell.h / dh)
    : Math.min(cell.w / dw, cell.h / dh);   // points per image pixel
  const w = dw * scale, h = dh * scale;
  const draw = { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
  const vis = S.fit === "fill" ? { x: cell.x, y: cell.y, w: cell.w, h: cell.h } : draw;
  return { rot, scale, draw, vis };
}

// Cut marks start at the page edge and run right up to the real image edge.
// A mark stops at the first image it meets, so it never crosses another image.
function getMarks(rects, S) {
  if (!S.marksOn) return [];
  const EPS = 0.75, gap = S.markGapPt;
  const seen = new Set();
  const lines = [];
  const add = (x1, y1, x2, y2) => {
    if (Math.abs(x2 - x1) + Math.abs(y2 - y1) < 1) return;
    const key = [x1, y1, x2, y2].map((n) => n.toFixed(2)).join(",");
    if (!seen.has(key)) { seen.add(key); lines.push({ x1, y1, x2, y2 }); }
  };
  const xs = new Set(), ys = new Set();
  rects.forEach((r) => {
    xs.add(+r.x.toFixed(2)); xs.add(+(r.x + r.w).toFixed(2));
    ys.add(+r.y.toFixed(2)); ys.add(+(r.y + r.h).toFixed(2));
  });
  xs.forEach((x) => {
    const hit = rects.filter((r) => x >= r.x - EPS && x <= r.x + r.w + EPS);
    if (!hit.length) return;
    add(x, 0, x, Math.min(...hit.map((r) => r.y)) - gap);
    add(x, Math.max(...hit.map((r) => r.y + r.h)) + gap, x, S.H);
  });
  ys.forEach((y) => {
    const hit = rects.filter((r) => y >= r.y - EPS && y <= r.y + r.h + EPS);
    if (!hit.length) return;
    add(0, y, Math.min(...hit.map((r) => r.x)) - gap, y);
    add(Math.max(...hit.map((r) => r.x + r.w)) + gap, y, S.W, y);
  });
  return lines;
}

// =====================================================================
//  Preview
// =====================================================================
let previewFrame = 0;
function schedulePreview() {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(drawPreview);
}

function drawPreview() {
  const S = readSettings();
  const cells = getCells(S);
  updateQualityUi();

  if (!cells) {
    el.pages.innerHTML = "";
    el.title.textContent = "Page preview";
    setStatus("Margin and gap leave no room for images. Reduce them.", "error");
    el.make.disabled = true;
    return;
  }
  if (!busy) el.make.disabled = files.length === 0;
  if (el.status.className === "error" && el.status.textContent.startsWith("Margin and gap")) setStatus("");

  const perPage = cells.length;
  const seq = buildSequence(S);
  const pageCount = seq.length ? Math.ceil(seq.length / perPage) : 1;
  const shown = Math.min(pageCount, MAX_PREVIEW_PAGES);
  let minDpi = Infinity;
  let html = "";

  for (let p = 0; p < shown; p++) {
    const count = seq.length ? Math.min(perPage, seq.length - p * perPage) : perPage;
    let svg = `<svg viewBox="0 0 ${S.W} ${S.H}" xmlns="http://www.w3.org/2000/svg">`;
    const rects = [];
    for (let j = 0; j < count; j++) {
      const cell = cells[j];
      const fi = seq[p * perPage + j];
      const url = fi !== undefined ? thumbs[fi] : null;
      const d = fi !== undefined ? dims[fi] : null;
      if (url && d) {
        const pl = placeImage(cell, d.w, d.h, S);
        rects.push(pl.vis);
        minDpi = Math.min(minDpi, PT / pl.scale);
        const cx = pl.draw.x + pl.draw.w / 2, cy = pl.draw.y + pl.draw.h / 2;
        const img = pl.rot
          ? `<image href="${url}" x="${cx - pl.draw.h / 2}" y="${cy - pl.draw.w / 2}" width="${pl.draw.h}" height="${pl.draw.w}" transform="rotate(90 ${cx} ${cy})" preserveAspectRatio="none"/>`
          : `<image href="${url}" x="${pl.draw.x}" y="${pl.draw.y}" width="${pl.draw.w}" height="${pl.draw.h}" preserveAspectRatio="none"/>`;
        // nested svg clips anything outside the cell (needed for "Fill cell")
        svg += `<svg x="${cell.x}" y="${cell.y}" width="${cell.w}" height="${cell.h}" viewBox="${cell.x} ${cell.y} ${cell.w} ${cell.h}">${img}</svg>`;
      } else {
        rects.push(cell);
        svg += `<rect x="${cell.x}" y="${cell.y}" width="${cell.w}" height="${cell.h}" fill="#cfd8e3"/>`;
      }
    }
    for (const m of getMarks(rects, S)) {
      svg += `<line x1="${m.x1}" y1="${m.y1}" x2="${m.x2}" y2="${m.y2}" stroke="#d92d20" stroke-width="3"/>`;
    }
    svg += `</svg>`;
    html += `<div class="page"><figure>${svg}<figcaption>Page ${p + 1}</figcaption></figure></div>`;
  }
  el.pages.innerHTML = html;

  el.title.textContent = seq.length
    ? `Page preview – ${pageCount} page${pageCount > 1 ? "s" : ""}`
    : "Page preview";
  el.note.textContent = (pageCount > shown ? `Showing the first ${shown} of ${pageCount} pages. ` : "")
    + "Red lines are the cut marks. The PDF uses the quality you choose; this preview uses small thumbnails.";

  if (Number.isFinite(minDpi)) {
    const d = Math.round(minDpi);
    el.dpiInfo.textContent = `At this layout the lowest image resolution is about ${d} DPI`
      + (d < 150 ? " (low for print)." : ".");
  } else {
    el.dpiInfo.textContent = "";
  }
}

function updateQualityUi() {
  el.qualityRow.hidden = el.quality.value !== "custom";
  el.customRow.hidden = el.sheet.value !== "custom";
}

async function buildThumbnails(token) {
  thumbs.forEach((u) => u && URL.revokeObjectURL(u));
  thumbs = [];
  dims = [];
  for (let i = 0; i < files.length; i++) {
    if (token !== loadToken) return;               // a newer folder was chosen
    setStatus(`Loading preview ${i + 1} of ${files.length}…`);
    let bmp = null;
    try {
      bmp = await createImageBitmap(files[i]);
      dims[i] = { w: bmp.width, h: bmp.height };
      const scale = Math.min(1, THUMB_SIZE / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale));
      c.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
      thumbs[i] = blob ? URL.createObjectURL(blob) : null;
      c.width = c.height = 0;
    } catch (e) {
      thumbs[i] = null;
      dims[i] = null;
    } finally {
      if (bmp) bmp.close();
    }
  }
  if (token !== loadToken) return;
  setStatus("");
  drawPreview();
}

// =====================================================================
//  Folder selection
// =====================================================================
el.folder.addEventListener("change", () => {
  if (busy) return;
  const isImage = (f) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name) && !f.name.startsWith(".");
  files = [...el.folder.files].filter(isImage).sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true })
  );
  el.make.disabled = files.length === 0;
  el.again.hidden = true;
  el.folderInfo = $("folderInfo");
  el.folderInfo.textContent = files.length
    ? `${files.length} image${files.length > 1 ? "s" : ""} found`
    : "No images found in that folder";
  thumbs = [];
  dims = [];
  drawPreview();
  if (files.length) buildThumbnails(++loadToken);
  else loadToken++;
});

// preview updates while typing/choosing, numbers are tidied when you leave the box
[el.sheet, el.orient, el.layout, el.copies, el.fit, el.order, el.rotate, el.margin, el.gap,
 el.marks, el.markGap, el.quality, el.qDpi, el.qJpeg, el.customW, el.customH]
  .forEach((x) => x.addEventListener("input", schedulePreview));
[el.copies, el.margin, el.gap, el.markGap, el.qDpi, el.qJpeg, el.customW, el.customH]
  .forEach((x) => x.addEventListener("change", () => { normalizeInputs(); schedulePreview(); }));

// =====================================================================
//  Image embedding
//    Original: JPEG as-is, PNG pixel data as-is, others lossless.
//    Lower quality: shrunk to the chosen DPI and saved as JPEG.
// =====================================================================

// --- JPEG: read the EXIF "orientation" tag (phone photos) ---
function jpegOrientation(b) {
  try {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
    let p = 2;
    while (p + 4 < b.length && b[p] === 0xff) {
      const m = b[p + 1];
      const len = (b[p + 2] << 8) | b[p + 3];
      if (m === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
        const t = p + 10;
        const le = b[t] === 0x49;
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const ifd = t + dv.getUint32(t + 4, le);
        const n = dv.getUint16(ifd, le);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le);
        }
        return 1;
      }
      if (m === 0xda) break;
      p += 2 + len;
    }
  } catch (e) { /* treat as upright */ }
  return 1;
}

// --- PNG: read chunks so the original pixel data can be reused as-is ---
function parsePng(b) {
  try {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let pos = 8, ihdr = null, plte = null, trns = false;
    const idat = [];
    while (pos + 8 <= b.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
      const data = b.subarray(pos + 8, pos + 8 + len);
      if (type === "IHDR") ihdr = { w: dv.getUint32(pos + 8), h: dv.getUint32(pos + 12), depth: data[8], ctype: data[9], interlace: data[12] };
      else if (type === "PLTE") plte = data;
      else if (type === "tRNS") trns = true;
      else if (type === "IDAT") idat.push(data);
      else if (type === "IEND") break;
      pos += 12 + len;
    }
    if (!ihdr || !idat.length || ihdr.interlace !== 0 || trns) return null;
    const { ctype, depth } = ihdr;
    const ok =
      (ctype === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
      (ctype === 2 && (depth === 8 || depth === 16)) ||
      (ctype === 3 && plte && plte.length >= 3);
    if (!ok) return null;                       // alpha / interlaced -> other path
    let total = 0;
    idat.forEach((d) => (total += d.length));
    const stream = new Uint8Array(total);
    let off = 0;
    idat.forEach((d) => { stream.set(d, off); off += d.length; });
    return { ...ihdr, plte, stream };
  } catch (e) {
    return null;
  }
}

async function deflate(u8) {
  const out = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function addImageObject(pdf, dict, bytes) {
  dict.Type = "XObject";
  dict.Subtype = "Image";
  dict.Length = bytes.length;
  return pdf.context.register(pdf.context.stream(bytes, dict));
}

function makeCanvas(w, h) {
  if (w * h > MAX_CANVAS_PIXELS) throw new Error("image is too large for this browser");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("not enough memory for this image");
  ctx.fillStyle = "#fff";                       // transparent areas become white
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

// Smaller JPEG copy (used for the quality presets, and as a safety fallback)
async function embedAsJpeg(pdf, bmp, pixelScale, quality) {
  const w = Math.max(1, Math.round(bmp.width * pixelScale));
  const h = Math.max(1, Math.round(bmp.height * pixelScale));
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("could not create the JPEG");
  const img = await pdf.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  return { ref: img.ref, w, h, method: `jpeg ${Math.round(quality * 100)}%` };
}

// Full-size pixel copy with no quality loss (transparent PNG, WEBP, GIF, BMP, rotated JPEG)
async function embedAsPixels(pdf, bmp, warnings) {
  if (typeof CompressionStream !== "function") {
    warnings.add("This browser cannot compress losslessly, so some images were saved as 98% JPEG.");
    return embedAsJpeg(pdf, bmp, 1, 0.98);
  }
  const w = bmp.width, h = bmp.height;
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.drawImage(bmp, 0, 0);
  const rgb = new Uint8Array(w * h * 3);
  const STRIP = 256;                            // read in strips to keep memory low
  for (let y0 = 0; y0 < h; y0 += STRIP) {
    const rows = Math.min(STRIP, h - y0);
    const d = ctx.getImageData(0, y0, w, rows).data;
    let j = y0 * w * 3;
    for (let i = 0; i < d.length; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
  }
  canvas.width = canvas.height = 0;
  const bytes = await deflate(rgb);
  const ref = addImageObject(pdf, {
    Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Filter: "FlateDecode",
  }, bytes);
  return { ref, w, h, method: "pixels (lossless)" };
}

// Original JPEG / PNG data, untouched. Returns null when that is not possible.
async function embedOriginal(pdf, bytes, bmp, allowPng) {
  try {
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (isJpeg) {
      if (jpegOrientation(bytes) !== 1) return null;
      const img = await pdf.embedJpg(bytes);
      if (img.width !== bmp.width || img.height !== bmp.height) return null;
      return { ref: img.ref, w: img.width, h: img.height, method: "jpeg (original)" };
    }
    if (!allowPng) return null;
    const png = parsePng(bytes);
    if (!png || png.w !== bmp.width || png.h !== bmp.height) return null;
    const n = png.ctype === 2 ? 3 : 1;
    let cs = png.ctype === 2 ? "DeviceRGB" : "DeviceGray";
    if (png.ctype === 3) {
      const hex = [...png.plte].map((v) => v.toString(16).padStart(2, "0")).join("");
      cs = [PDFName.of("Indexed"), PDFName.of("DeviceRGB"), Math.floor(png.plte.length / 3) - 1, PDFHexString.of(hex)];
    }
    const ref = addImageObject(pdf, {
      Width: png.w, Height: png.h, ColorSpace: cs, BitsPerComponent: png.depth,
      Filter: "FlateDecode",
      DecodeParms: { Predictor: 15, Colors: n, BitsPerComponent: png.depth, Columns: png.w },
    }, png.stream);
    return { ref, w: png.w, h: png.h, method: "png (original)" };
  } catch (e) {
    return null;                                // fall back to the pixel path
  }
}

// Returns { ref, w, h } for one image file (cached, so copies share one embed)
async function embedImage(pdf, file, cell, S, cache, warnings) {
  if (cache.has(file)) {
    const hit = cache.get(file);
    if (hit.error) throw hit.error;             // a broken file is not tried again
    return hit;
  }
  let bmp = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    bmp = await createImageBitmap(file);        // proves the file is readable, gives the true size
    const lossy = S.quality.mode === "jpeg";
    const pl = placeImage(cell, bmp.width, bmp.height, S);
    // share of the original pixels needed for the chosen DPI (never enlarged)
    const pixelScale = lossy ? Math.min(1, (S.quality.dpi * pl.scale) / PT) : 1;

    let info = null;
    if (!lossy || pixelScale >= 1) info = await embedOriginal(pdf, bytes, bmp, !lossy);
    if (!info) info = lossy
      ? await embedAsJpeg(pdf, bmp, pixelScale, S.quality.q)
      : await embedAsPixels(pdf, bmp, warnings);
    cache.set(file, info);
    return info;
  } catch (e) {
    cache.set(file, { error: e });
    throw e;
  } finally {
    if (bmp) bmp.close();
  }
}

// =====================================================================
//  Build the PDF
// =====================================================================
function setBusy(on) {
  busy = on;
  document.querySelectorAll(".controls input, .controls select").forEach((x) => (x.disabled = on));
  el.make.hidden = on;
  el.cancel.hidden = !on;
  el.bar.hidden = !on && el.bar.value === 0;
  if (!on) el.make.disabled = files.length === 0;
}

function downloadLast() {
  if (!lastPdfUrl) return;
  const a = document.createElement("a");
  a.href = lastPdfUrl;
  a.download = lastPdfName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
el.again.addEventListener("click", downloadLast);
el.cancel.addEventListener("click", () => { cancelRequested = true; setStatus("Cancelling…"); });

el.make.addEventListener("click", async () => {
  if (busy || !files.length) return;
  normalizeInputs();
  const S = readSettings();
  const cells = getCells(S);
  if (!cells) { setStatus("Margin and gap leave no room for images. Reduce them.", "error"); return; }

  const perPage = cells.length;
  const seq = buildSequence(S);
  const failed = new Set();
  let failCount = 0;
  const warnings = new Set();
  const cache = new Map();
  let imgCounter = 0;

  cancelRequested = false;
  el.again.hidden = true;
  el.bar.value = 0;
  setBusy(true);
  el.bar.hidden = false;

  try {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.setTitle("Sheet Maker");
    pdf.setCreator("Sheet Maker");
    // ask the print dialog NOT to scale the page (keeps the sheet size exact)
    pdf.catalog.set(PDFName.of("ViewerPreferences"), pdf.context.obj({ PrintScaling: "None" }));

    for (let i = 0; i < seq.length; i += perPage) {
      const page = pdf.addPage([S.W, S.H]);
      const group = seq.slice(i, i + perPage);
      const rects = [];

      for (let j = 0; j < group.length; j++) {
        if (cancelRequested) throw new Error("__cancelled__");
        const n = i + j + 1;
        const file = files[group[j]];
        const cell = cells[j];
        setStatus(`Processing image ${n} of ${seq.length}…`);
        el.bar.value = (n / seq.length) * 95;
        await tick();

        try {
          const info = await embedImage(pdf, file, cell, S, cache, warnings);
          const pl = placeImage(cell, info.w, info.h, S);
          rects.push(pl.vis);

          const key = PDFName.of("Im" + ++imgCounter);
          page.node.setXObject(key, info.ref);
          const d = pl.draw;
          const X = d.x, Y = S.H - d.y - d.h;               // bottom-left in PDF coordinates
          const ops = [pushGraphicsState()];
          if (S.fit === "fill") {
            ops.push(rectangle(cell.x, S.H - cell.y - cell.h, cell.w, cell.h), clip(), endPath());
          }
          ops.push(pl.rot
            ? concatTransformationMatrix(0, -d.h, d.w, 0, X, Y + d.h)   // turned 90° clockwise
            : concatTransformationMatrix(d.w, 0, 0, d.h, X, Y));
          ops.push(drawObject(key), popGraphicsState());
          page.pushOperators(...ops);
        } catch (e) {
          if (e && e.message === "__cancelled__") throw e;
          console.error(file.name, e);
          failed.add(`${file.name} (${(e && e.message) || "unreadable"})`);
          failCount++;
          rects.push(cell);
        }
      }

      // cut marks: single black ink, thin vector lines
      for (const m of getMarks(rects, S)) {
        page.drawLine({
          start: { x: m.x1, y: S.H - m.y1 },
          end: { x: m.x2, y: S.H - m.y2 },
          thickness: 0.5,
          color: cmyk(0, 0, 0, 1),
        });
      }
    }

    if (failCount === seq.length) throw new Error("none of the images could be read");

    setStatus("Saving PDF…");
    el.bar.value = 98;
    await tick();
    const bytes = await pdf.save();

    if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
    lastPdfUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const folderName = (files[0].webkitRelativePath || "images").split("/")[0];
    lastPdfName = `${folderName.replace(/[^\w.-]+/g, "_")}_${S.tag}.pdf`;
    downloadLast();

    el.bar.value = 100;
    let msg = `Done. ${pdf.getPageCount()} page${pdf.getPageCount() > 1 ? "s" : ""}, ${(bytes.length / 1048576).toFixed(1)} MB.`;
    if (warnings.size) msg += " " + [...warnings].join(" ");
    if (failed.size) msg += ` Could not use: ${[...failed].join(", ")}`;
    setStatus(msg, failed.size ? "error" : "");
    el.again.hidden = false;
  } catch (e) {
    if (e && e.message === "__cancelled__") {
      setStatus("Cancelled. No PDF was created.");
    } else {
      console.error(e);
      const memory = e instanceof RangeError || /memory/i.test((e && e.message) || "");
      setStatus("Something went wrong: " + ((e && e.message) || e)
        + (memory ? " Try a lower quality setting or fewer images per run." : ""), "error");
    }
  } finally {
    cache.clear();
    setBusy(false);
  }
});

// ---------- Start ----------
(function init() {
  GRIDS.forEach(([c, r]) => {
    const o = document.createElement("option");
    o.value = `${c}x${r}`;
    o.textContent = `${c * r} per page – ${c} × ${r}`;
    if (c === 2 && r === 2) o.selected = true;
    el.layout.appendChild(o);
  });
  // fixed-size portrait cards: 5.4 cm wide x 8.6 cm tall, 5 x 5 = 25 per page
  const card = document.createElement("option");
  card.value = "card5x5";
  card.textContent = "25 per page – 5 × 5 (portrait cards 5.4 × 8.6 cm)";
  el.layout.appendChild(card);
  el.folderInfo = $("folderInfo");
  checkBrowser();
  drawPreview();
})();

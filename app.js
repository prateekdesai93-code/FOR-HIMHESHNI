// Price List Updater — app logic.
// Everything runs client-side: pdf.js extracts text from the PDF, the
// matching engine below (ported from a hand-verified Python implementation)
// pairs each Excel colour/size variant with the right PDF price, and SheetJS
// reads/writes the Excel file. No file ever leaves the browser.

import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.worker.min.mjs";

/* =========================================================================
   MATCHING ENGINE
   Ported from a Python implementation that was hand-verified against a real
   customer PDF + pricelist export, then parity-tested row-by-row in Node
   against that proven output (421/421 rows identical) before this port was
   trusted. See README.md "How matching works" for the full rules.
   ========================================================================= */

const UNIT_ALIASES = {
  LT: "L", L: "L", ML: "ML",
  KG: "KG", GM: "G", GR: "G", G: "G", MM: "MM",
};

const SIZE_RE = /(\d+(?:\.\d+)?)\s*(ML|LT|L|KG|GM|GR|G|MM)\b/gi;
const SIZE_TOKEN_RE = /^\d+(\.\d+)?(ML|L|KG|G|MM)$/;
const MULT_TOKEN_RE = /^X\d+$/;

// Deliberately NOT stripping bare "L"/"G"/"ML"/"KG"/"MM"/"GM"/"GR" as words -
// after unit normalization a real size token is always digit-glued ("1L",
// "500G"); a bare letter like "L","G","S","B","D","F" in a product name is a
// genuine colour abbreviation (G Brown = Golden Brown, L Blue = Light Blue,
// S Red = Summer/Signal Red, ...) and must survive to the colour key.
const NON_COLOUR_WORDS = new Set([
  "1LT", "5LT", "20LT", "LT", "X", "DOZ",
  "COLOURS", "COLORS", "COLOUR", "COLOR", "QD", "ENAMEL", "HIGH", "GLOSS",
  "ULTIMATE", "SHINE", "UNIVERSAL", "ROOF", "UNDERCOAT", "UNIV", "MASTER",
  "DECORATORS", "PICK", "SAVE", "AND", "N", "ECONO", "DECOR", "PVA", "ECLIPSE",
  "7", "IN", "1", "ACRYLIC", "LOW", "SHEEN", "VARNISH", "STAINERS", "BONDING",
  "LIQUID", "FACE", "BRICK", "DRESSING", "HI", "HIDING", "CONTRACTORS", "CONT",
  "PUTTY", "CRACK", "FILLER", "DISTEMPER", "MEMBRANE", "WATERBASE", "PLASTER",
  "PRIMER", "OXIDE", "PRODUCT", "PRICE", "APRIL",
  "STOEP", "GRIP", "COAT", "RAINPROOF", "BASE", "CLEAR", "PLAIN", "ALKYD", "ROOF",
]);

// Verified against real price data (not assumed from spelling): same colour,
// different abbreviation between an Odoo export and a supplier PDF.
const COLOUR_SYNONYMS = {
  "GOLDEN BROWN": "G BROWN",
  "SIGNAL RED": "RED",
};

// Product-line alias table: every listed token must be present in a name;
// the alias matching the MOST tokens wins (longest/most-specific match).
// RAINPROOF is listed before MEMBRANE deliberately - "Rainproof + Membrane"
// must classify as RAINPROOF, not MEMBRANE (both are 1-token matches; the
// first occurrence wins a tie in this implementation).
const PRODUCT_LINE_ALIASES = [
  [["3", "IN", "1"], "GRIP COAT"],
  [["QD", "ENAMEL"], "QD ENAMEL"],
  [["QD", "BLACK", "OXIDE", "PRIMER"], "QD BLACK OXIDE PRIMER"],
  [["QD", "RED", "OXIDE", "PRIMER"], "QD RED OXIDE PRIMER"],
  [["QD", "OXIDE", "PRIMER", "RED"], "QD RED OXIDE PRIMER"],
  [["HIGH", "GLOSS", "ENAMEL"], "HIGH GLOSS ENAMEL"],
  [["ULTIMATE", "SHINE"], "ULTIMATE SHINE"],
  [["UNIVERSAL", "ROOF"], "UNIVERSAL ROOF"],
  [["UNIVERSAL", "UNDERCOAT"], "UNIVERSAL UNDERCOAT"],
  [["UNIV", "UNDERCOAT"], "UNIVERSAL UNDERCOAT"],
  [["MASTER", "DECORATORS"], "MASTER DECORATORS"],
  [["PICK", "SAVE"], "PICK AND SAVE"],
  [["PICK", "N", "SAVE", "ECONO"], "PICK AND SAVE"],
  [["DECOR", "PVA"], "DECOR PVA"],
  [["DECOR"], "DECOR PVA"],
  [["ECLIPSE", "PVA"], "ECLIPSE PVA"],
  [["7", "IN", "1", "ACRYLIC", "PVA"], "7 IN 1 ACRYLIC PVA"],
  [["VARNISH"], "VARNISH"],
  [["STAINERS"], "STAINERS"],
  [["BONDING", "LIQUID"], "BONDING LIQUID"],
  [["FACE", "BRICK"], "FACE BRICK"],
  [["HI", "HIDING", "PVA", "CONTRACTORS"], "HI HIDING PVA CONTRACTORS"],
  [["HI", "HIDING", "CONT", "PVA"], "HI HIDING PVA CONTRACTORS"],
  [["PUTTY"], "PUTTY"],
  [["CRACK", "FILLER"], "CRACK FILLER"],
  [["DISTEMPER"], "DISTEMPER"],
  [["RAINPROOF"], "RAINPROOF"],
  [["MEMBRANE"], "MEMBRANE"],
  [["WATERBASE", "PLASTER", "PRIMER"], "WATERBASE PLASTER PRIMER"],
  [["OXIDE"], "OXIDE SINGLE"],
  [["STOEP"], "STOEP"],
];

function normalizeText(sRaw) {
  let s = String(sRaw).toUpperCase();
  s = s.replace(/Q\.D/g, "QD").replace(/Q D/g, "QD");
  s = s.replace(/’/g, "'").replace(/[–—]/g, "-");
  s = s.replace(/[.\-/(),'&]/g, " ");
  s = s.replace(/(\d+(?:\.\d+)?)\s*LT\b/g, "$1L");
  s = s.replace(/(\d+(?:\.\d+)?)\s*(GR|GM)\b/g, "$1G");
  s = s.replace(/(\d+(?:\.\d+)?)\s*KG\b/g, "$1KG");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function extractSizes(raw) {
  const out = [];
  let m;
  const re = new RegExp(SIZE_RE.source, "gi");
  while ((m = re.exec(String(raw))) !== null) {
    const unit = UNIT_ALIASES[m[2].toUpperCase()] || m[2].toUpperCase();
    let n = m[1];
    if (n.includes(".")) n = n.replace(/0+$/, "").replace(/\.$/, "");
    out.push(`${n}${unit}`);
  }
  return out;
}

function sizeKey(raw) {
  const sizes = extractSizes(raw);
  return sizes.length ? sizes[sizes.length - 1] : null;
}

function tokensOf(normStr) {
  return normStr.split(" ").filter(Boolean);
}

function productLineKey(tokenSet) {
  let best = null;
  let bestLen = 0;
  for (const [aliasTokens, canon] of PRODUCT_LINE_ALIASES) {
    if (aliasTokens.every((t) => tokenSet.has(t))) {
      if (aliasTokens.length > bestLen) {
        best = canon;
        bestLen = aliasTokens.length;
      }
    }
  }
  return best;
}

function colourWords(tokens) {
  return tokens.filter(
    (t) => !NON_COLOUR_WORDS.has(t) && !/^\d+$/.test(t) && !SIZE_TOKEN_RE.test(t) && !MULT_TOKEN_RE.test(t)
  );
}

function colourKey(colourStr) {
  // Order-independent AND duplicate-collapsing - e.g. "Blue Oxide Blue"
  // (colour parsed as "BLUE BLUE" because the product name itself repeats
  // the word) must key identically to a PDF row's plain "BLUE".
  if (!colourStr) return "";
  const c = COLOUR_SYNONYMS[colourStr] || colourStr;
  const uniqueSorted = [...new Set(c.split(" ").filter(Boolean))].sort();
  return uniqueSorted.join(" ");
}

function parseEntry(rawName) {
  const n = normalizeText(rawName);
  const tokens = tokensOf(n);
  const tokenSet = new Set(tokens);
  const size = sizeKey(rawName);
  const product = productLineKey(tokenSet);
  const cw = colourWords(tokens);
  const colour = cw.length ? cw.join(" ") : null;
  return { raw: rawName, norm: n, tokens, tokenSet, size, product, colour };
}

function buildPdfEntry(label, price) {
  const p = parseEntry(label);
  const isGeneric = p.tokenSet.has("COLOURS") || p.tokenSet.has("COLORS");
  let slashColours = null;
  if (String(label).includes("/")) {
    slashColours = String(label).split("/").map((part) => normalizeText(part));
  }
  let specificColour = isGeneric ? null : p.colour;
  let isGenericFinal = isGeneric;
  // Varnish "Stained" acts as the generic cascade for the Varnish family
  // (validated: matches every non-Copal Varnish colour price exactly).
  if (p.product === "VARNISH" && p.tokenSet.has("STAINED")) {
    isGenericFinal = true;
    specificColour = null;
  }
  return {
    raw: label,
    price,
    product: p.product,
    size: p.size,
    isGeneric: isGenericFinal,
    specificColour,
    slashColours,
  };
}

// pdfRows: [{label, price}], xlsxRows: [{name, price}] (price = current
// fixed price). Returns an array parallel to xlsxRows:
// {old, new, matchType, note}
function runMatcher(pdfRows, xlsxRows) {
  const pdfEntries = pdfRows.map((r) => buildPdfEntry(r.label, r.price));
  const pdfByGroup = new Map();
  for (const e of pdfEntries) {
    const key = `${e.product}::${e.size}`;
    if (!pdfByGroup.has(key)) pdfByGroup.set(key, []);
    pdfByGroup.get(key).push(e);
  }

  const parsedXlsx = xlsxRows.map((r) => {
    const p = parseEntry(r.name);
    const specialVariant = ["PLAIN", "BASE", "CLEAR"].some((w) => p.tokenSet.has(w));
    return { ...r, parsed: p, specialVariant };
  });

  const variantCounts = new Map();
  const groupPrices = new Map();
  const groupPriceCounts = new Map();
  for (const row of parsedXlsx) {
    if (!row.parsed.product || row.specialVariant) continue;
    const key = `${row.parsed.product}::${row.parsed.size}`;
    if (!variantCounts.has(key)) variantCounts.set(key, new Set());
    variantCounts.get(key).add(row.parsed.colour);
    if (row.price !== null && row.price !== undefined && row.price !== "") {
      const rp = Math.round(Number(row.price) * 100) / 100;
      if (!groupPrices.has(key)) groupPrices.set(key, new Set());
      groupPrices.get(key).add(rp);
      if (!groupPriceCounts.has(key)) groupPriceCounts.set(key, new Map());
      const m = groupPriceCounts.get(key);
      m.set(rp, (m.get(rp) || 0) + 1);
    }
  }

  const results = [];

  for (const row of parsedXlsx) {
    const oldPrice = row.price === "" ? null : row.price;
    let newPrice = oldPrice;
    let matchType = "NOT FOUND";
    let note = "";

    if (row.specialVariant) {
      results.push({ old: oldPrice, new: newPrice, matchType: "SKIPPED (special variant: PLAIN/BASE/CLEAR)", note: "" });
      continue;
    }
    const { product: prod, size: sz, colour } = row.parsed;
    if (!prod) {
      results.push({ old: oldPrice, new: newPrice, matchType: "NOT FOUND (product line not recognised)", note: "" });
      continue;
    }

    const key = `${prod}::${sz}`;
    const candidates = pdfByGroup.get(key) || [];
    const myKey = colourKey(colour);

    let exact = null;
    for (const c of candidates) {
      if (c.specificColour && colour && colourKey(c.specificColour) === myKey) { exact = c; break; }
    }
    if (!exact) {
      for (const c of candidates) {
        if (c.slashColours && colour) {
          const colourToks = new Set(colour.split(" "));
          let hit = false;
          for (const part of c.slashColours) {
            const partToks = new Set(tokensOf(part).filter((t) => t && !NON_COLOUR_WORDS.has(t)));
            if (partToks.size === 0) continue;
            let overlap = false;
            for (const t of partToks) if (colourToks.has(t)) { overlap = true; break; }
            const subsetEither =
              [...partToks].every((t) => colourToks.has(t)) || [...colourToks].every((t) => partToks.has(t));
            if (overlap || subsetEither) { hit = true; break; }
          }
          if (hit) { exact = c; break; }
        }
      }
    }
    let generic = null;
    if (!exact) {
      for (const c of candidates) if (c.isGeneric) { generic = c; break; }
    }
    let unnamedDefault = null;
    if (!exact && !generic) {
      const unnamed = candidates.filter((c) => !c.specificColour && !c.slashColours);
      if (unnamed.length === 1) unnamedDefault = unnamed[0];
    }

    const curGroupPrices = groupPrices.get(key) || new Set();
    const isUniformGroup = curGroupPrices.size <= 1;
    const priceCounts = groupPriceCounts.get(key) || new Map();
    let modalPrice = null, modalCount = -1;
    for (const [p, c] of priceCounts) if (c > modalCount) { modalPrice = p; modalCount = c; }
    const rowMatchesMajority =
      isUniformGroup || oldPrice === null || oldPrice === undefined ||
      Math.round(Number(oldPrice) * 100) / 100 === modalPrice;

    if (exact) {
      newPrice = exact.price;
      matchType = "AUTO (exact/slash colour match)";
      note = `matched PDF row: '${exact.raw}'`;
    } else if (generic) {
      newPrice = generic.price;
      matchType = "AUTO (group 'Colours' price)";
      note = `matched PDF row: '${generic.raw}'`;
    } else if (unnamedDefault && rowMatchesMajority) {
      newPrice = unnamedDefault.price;
      matchType = "AUTO (default price - only unnamed-colour PDF row in group)";
      note = `matched PDF row: '${unnamedDefault.raw}'`;
    } else if (
      candidates.length &&
      new Set(candidates.map((c) => Math.round(c.price * 100) / 100)).size === 1 &&
      isUniformGroup
    ) {
      const c = candidates[0];
      newPrice = c.price;
      matchType = "AUTO (verified-uniform group cascade)";
      note = `matched PDF row: '${c.raw}' - all colours in this group were already priced identically`;
    } else if (unnamedDefault && !rowMatchesMajority) {
      matchType = "REVIEW NEEDED (this colour is priced differently from the rest of its group today)";
      note = `this row's current price ${oldPrice} does not match the group's dominant current price ${modalPrice} - PDF only gives one undifferentiated price ('${unnamedDefault.raw}'=${unnamedDefault.price}) for the group, so we won't guess which tier this colour belongs to`;
    } else if (candidates.length && candidates.some((c) => c.specificColour || c.slashColours || c.isGeneric)) {
      matchType = "NOT FOUND (this colour not named in the PDF update)";
      note = "other colours in this group were updated, but not this one";
    } else if (candidates.length) {
      matchType = "REVIEW NEEDED (ambiguous - colours priced differently today, PDF gives one undifferentiated price)";
      note = `current prices in this group: ${[...curGroupPrices].sort((a, b) => a - b).join(", ")}`;
    } else {
      matchType = "NOT FOUND (no PDF row for this product+size)";
      note = "";
    }

    results.push({ old: oldPrice, new: newPrice, matchType, note });
  }

  return results;
}

/* =========================================================================
   PDF TEXT EXTRACTION
   ========================================================================= */

// Trailing price at the end of a line, e.g. "1LT High Gloss Enamel Colours
// 84.43" or "20LT Roof & Stoep  1,392.00". Requires the label part to
// contain at least one letter, so we don't mistake stray numeric lines
// (page numbers, dates) for a price row. The decimal cents (".43") are
// required in the strict pass - real price sheets always show them, while a
// bare trailing integer ("...01 Apr 2026") is far more likely a date, page
// number, or quantity than a price. If the strict pass finds nothing at all
// (a price sheet that genuinely uses whole-number prices), we fall back to
// the looser pattern that also accepts a bare integer.
const LINE_PRICE_RE_STRICT = /^(.*[A-Za-z].*?)\s+R?\s*(\d{1,3}(?:[, ]\d{3})*\.\d{1,2}|\d+\.\d{1,2})\s*$/;
const LINE_PRICE_RE_LOOSE = /^(.*[A-Za-z].*?)\s+R?\s*(\d{1,3}(?:[, ]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*$/;

async function extractPdfRows(file) {
  const buf = await file.arrayBuffer();

  const lines = [];
  let totalItems = 0;

  // Any failure inside pdf.js while opening or reading this file - a
  // malformed PDF, a scanned document with a broken/absent text layer, a
  // browser/library incompatibility - is treated the same way: "couldn't
  // read text from this PDF". The caller shows one clear message for that
  // rather than a raw library error, since none of these are something the
  // user can act on beyond "try a different export of this PDF".
  try {
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      totalItems += content.items.length;

      // Group text items into visual lines by y-position.
      const buckets = [];
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const y = item.transform[5];
        const x = item.transform[4];
        let bucket = buckets.find((b) => Math.abs(b.y - y) < 3);
        if (!bucket) {
          bucket = { y, items: [] };
          buckets.push(bucket);
        }
        bucket.items.push({ x, str: item.str });
      }
      // Reading order: top of page first (larger y in PDF space), left to right.
      buckets.sort((a, b) => b.y - a.y);
      for (const b of buckets) {
        b.items.sort((p, q) => p.x - q.x);
        let line = "";
        let lastX = null;
        for (const it of b.items) {
          if (lastX !== null && it.x - lastX > 18 && !line.endsWith(" ")) line += "  ";
          else if (line && !line.endsWith(" ") && !it.str.startsWith(" ")) line += " ";
          line += it.str;
          lastX = it.x;
        }
        line = line.replace(/\s+/g, " ").trim();
        if (line) lines.push(line);
      }
    }
  } catch (err) {
    console.error("PDF text extraction failed:", err);
    return { rows: [], unparsed: [], hasText: false };
  }

  const parseWith = (re) => {
    const rows = [];
    const unparsed = [];
    for (const line of lines) {
      const m = line.match(re);
      if (!m) {
        unparsed.push(line);
        continue;
      }
      const label = m[1].trim();
      const priceStr = m[2].replace(/[, ]/g, "");
      const price = parseFloat(priceStr);
      if (!label || label.length < 2 || !Number.isFinite(price) || price <= 0 || price > 1000000) {
        unparsed.push(line);
        continue;
      }
      rows.push({ label, price });
    }
    return { rows, unparsed };
  };

  let { rows, unparsed } = parseWith(LINE_PRICE_RE_STRICT);
  if (!rows.length && lines.length) {
    // No line had a decimal-cents price - this price sheet likely uses
    // whole-number prices, so retry with the looser pattern.
    ({ rows, unparsed } = parseWith(LINE_PRICE_RE_LOOSE));
  }

  return { rows, unparsed, hasText: totalItems > 0 };
}

/* =========================================================================
   EXCEL I/O
   ========================================================================= */

const NAME_HEADER = "item_ids/product_tmpl_id/name";
const PRICE_HEADER = "item_ids/fixed_price";

function readWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  if (!aoa.length) throw new Error("The Excel file appears to be empty.");
  const header = aoa[0].map((h) => (h == null ? "" : String(h).trim()));

  let nameCol = header.indexOf(NAME_HEADER);
  let priceCol = header.indexOf(PRICE_HEADER);
  let usedFallback = false;
  if (nameCol === -1 || priceCol === -1) {
    // Fall back to the known Odoo export layout (column H = name, column J =
    // fixed price) and flag it clearly rather than failing outright.
    nameCol = nameCol === -1 ? 7 : nameCol;
    priceCol = priceCol === -1 ? 9 : priceCol;
    usedFallback = true;
  }

  const customerRaw = aoa[1] && aoa[1][1] != null ? String(aoa[1][1]) : "";
  const m = customerRaw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const customerName = m ? m[1].trim() : customerRaw || "Customer";
  const accountNumber = m ? m[2].trim() : "";

  const allRows = []; // one entry per data row, in order, {name, price, rowIdx} or null
  for (let r = 1; r < aoa.length; r++) {
    const rawName = aoa[r] ? aoa[r][nameCol] : null;
    const name = rawName == null || rawName === "" ? null : String(rawName);
    if (!name) { allRows.push(null); continue; }
    const rawPrice = aoa[r] ? aoa[r][priceCol] : null;
    const price = rawPrice === null || rawPrice === "" ? null : Number(rawPrice);
    allRows.push({ name, price, rowIdx: r });
  }

  return { wb, sheetName, ws, header, nameCol, priceCol, usedFallback, customerName, accountNumber, allRows, totalDataRows: aoa.length - 1 };
}

function buildOutputWorkbook(parsed, results) {
  const { wb, sheetName, ws, header, priceCol, allRows } = parsed;

  const oldCol = header.length;
  const statusCol = header.length + 1;
  const notesCol = header.length + 2;

  const setCell = (r, c, value, type) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    if (value === null || value === undefined || value === "") {
      delete ws[ref];
      return;
    }
    ws[ref] = type === "n" ? { t: "n", v: value } : { t: "s", v: String(value) };
  };

  setCell(0, oldCol, "Old Price", "s");
  setCell(0, statusCol, "Price Match Status", "s");
  setCell(0, notesCol, "Update Notes", "s");

  let resultIdx = 0;
  for (const row of allRows) {
    if (row === null) continue;
    const res = results[resultIdx++];
    const r = row.rowIdx;
    setCell(r, oldCol, res.old === null || res.old === undefined ? null : Number(res.old), "n");
    setCell(r, statusCol, res.matchType, "s");
    setCell(r, notesCol, res.note, "s");
    if (res.matchType.startsWith("AUTO") && res.new !== null && res.new !== undefined) {
      setCell(r, priceCol, Number(res.new), "n");
    }
  }

  // Expand the sheet range to include the new columns.
  const range = XLSX.utils.decode_range(ws["!ref"]);
  range.e.c = Math.max(range.e.c, notesCol);
  ws["!ref"] = XLSX.utils.encode_range(range);

  ws["!cols"] = ws["!cols"] || [];
  ws["!cols"][oldCol] = { wch: 12 };
  ws["!cols"][statusCol] = { wch: 32 };
  ws["!cols"][notesCol] = { wch: 70 };

  return wb;
}

/* =========================================================================
   APP STATE + UI WIRING
   ========================================================================= */

const state = {
  pdfFile: null,
  xlsxFile: null,
  xlsxBuffer: null,
  pdfRows: [],
  unparsedLines: [],
  parsedXlsx: null,
  results: null,
  resultRows: null, // enriched, display-ready rows for the results table
};

const $ = (id) => document.getElementById(id);

function showBanner(message, kind = "error") {
  const slot = $("global-banner-slot");
  slot.innerHTML = "";
  const div = document.createElement("div");
  div.className = `banner banner-${kind}`;
  div.setAttribute("role", kind === "error" ? "alert" : "status");
  div.textContent = message;
  slot.appendChild(div);
}

function clearBanner() {
  $("global-banner-slot").innerHTML = "";
}

function goToStep(n) {
  for (let i = 1; i <= 3; i++) {
    $(`panel-${i}`).classList.toggle("active", i === n);
    const pill = $(`step-pill-${i}`);
    pill.classList.toggle("active", i === n);
    pill.classList.toggle("done", i < n);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Step 1: upload ---------- */

function setupDropzone(zoneId, inputId, filenameId, titleId, onFile) {
  const zone = $(zoneId);
  const input = $(inputId);
  const filenameEl = $(filenameId);
  const titleEl = $(titleId);

  const handleFiles = (files) => {
    if (!files || !files.length) return;
    const file = files[0];
    onFile(file);
    zone.classList.add("has-file");
    titleEl.style.display = "none";
    filenameEl.hidden = false;
    filenameEl.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = file.name;
    const removeBtn = document.createElement("button");
    removeBtn.className = "dz-remove";
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", "Remove file");
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = "";
      onFile(null);
      zone.classList.remove("has-file");
      titleEl.style.display = "";
      filenameEl.hidden = true;
      updateExtractButton();
    });
    filenameEl.appendChild(span);
    filenameEl.appendChild(removeBtn);
    updateExtractButton();
  };

  input.addEventListener("change", (e) => handleFiles(e.target.files));

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
  });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });
}

function updateExtractButton() {
  $("btn-extract").disabled = !(state.pdfFile && state.xlsxFile);
}

setupDropzone("dz-pdf", "file-pdf", "dz-pdf-filename", "dz-pdf-title", (file) => {
  state.pdfFile = file;
});
setupDropzone("dz-xlsx", "file-xlsx", "dz-xlsx-filename", "dz-xlsx-title", (file) => {
  state.xlsxFile = file;
});

$("btn-extract").addEventListener("click", async () => {
  clearBanner();
  const btn = $("btn-extract");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Reading PDF…`;

  try {
    const { rows, unparsed, hasText } = await extractPdfRows(state.pdfFile);
    if (!hasText) {
      throw new Error(
        "Couldn't read any text from this PDF. Either it's a scanned image with no real text layer " +
        "(this tool doesn't do OCR), or the file is in a form this browser can't parse. Try a different " +
        "export/scan of the same price list, or a different browser."
      );
    }
    if (!rows.length) {
      throw new Error(
        "No price rows could be recognised in this PDF. If the layout is unusual, use “+ Add row manually” " +
        "on the next step, or check the raw text extraction below."
      );
    }
    state.pdfRows = rows;
    state.unparsedLines = unparsed;

    state.xlsxBuffer = await state.xlsxFile.arrayBuffer();
    state.parsedXlsx = readWorkbook(state.xlsxBuffer);
    if (state.parsedXlsx.usedFallback) {
      showBanner(
        "Couldn't find the expected column headers (item_ids/product_tmpl_id/name, item_ids/fixed_price) — " +
        "falling back to columns H and J. Double check the results before downloading.",
        "warn"
      );
    }

    renderPdfRowsTable();
    goToStep(2);
  } catch (err) {
    showBanner(err.message || String(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
    updateExtractButton();
  }
});

/* ---------- Step 2: review extracted PDF rows ---------- */

function renderPdfRowsTable() {
  const tbody = $("pdf-rows-tbody");
  tbody.innerHTML = "";
  state.pdfRows.forEach((row, idx) => {
    tbody.appendChild(buildPdfRowTr(row, idx));
  });
  $("pdf-row-count").textContent = `${state.pdfRows.length} row${state.pdfRows.length === 1 ? "" : "s"}`;

  const details = $("unparsed-details");
  if (state.unparsedLines.length) {
    details.hidden = false;
    $("unparsed-summary").textContent =
      `${state.unparsedLines.length} line${state.unparsedLines.length === 1 ? "" : "s"} in the PDF weren't recognised as price rows`;
    $("unparsed-text").textContent = state.unparsedLines.join("\n");
  } else {
    details.hidden = true;
  }
}

function buildPdfRowTr(row, idx) {
  const tr = document.createElement("tr");

  const labelTd = document.createElement("td");
  const labelInput = document.createElement("input");
  labelInput.className = "cell-input";
  labelInput.value = row.label;
  labelInput.setAttribute("aria-label", "Label");
  labelInput.addEventListener("input", () => { state.pdfRows[idx].label = labelInput.value; });
  labelTd.appendChild(labelInput);

  const priceTd = document.createElement("td");
  const priceInput = document.createElement("input");
  priceInput.className = "cell-input price-input";
  priceInput.type = "number";
  priceInput.step = "0.01";
  priceInput.value = row.price;
  priceInput.setAttribute("aria-label", "Price");
  priceInput.addEventListener("input", () => {
    const v = parseFloat(priceInput.value);
    state.pdfRows[idx].price = Number.isFinite(v) ? v : 0;
  });
  priceTd.appendChild(priceInput);

  const actionTd = document.createElement("td");
  const delBtn = document.createElement("button");
  delBtn.className = "row-del";
  delBtn.type = "button";
  delBtn.setAttribute("aria-label", "Remove row");
  delBtn.textContent = "✕";
  delBtn.addEventListener("click", () => {
    state.pdfRows.splice(idx, 1);
    renderPdfRowsTable();
  });
  actionTd.appendChild(delBtn);

  tr.appendChild(labelTd);
  tr.appendChild(priceTd);
  tr.appendChild(actionTd);
  return tr;
}

$("btn-add-row").addEventListener("click", () => {
  state.pdfRows.push({ label: "", price: 0 });
  renderPdfRowsTable();
  const inputs = document.querySelectorAll("#pdf-rows-tbody tr:last-child .cell-input");
  if (inputs.length) inputs[0].focus();
});

$("btn-back-1").addEventListener("click", () => goToStep(1));

$("btn-match").addEventListener("click", () => {
  clearBanner();
  const cleanRows = state.pdfRows
    .map((r) => ({ label: (r.label || "").trim(), price: Number(r.price) }))
    .filter((r) => r.label && Number.isFinite(r.price) && r.price > 0);

  if (!cleanRows.length) {
    showBanner("No valid price rows to match — add at least one row with a label and a price.", "error");
    return;
  }

  const comparable = state.parsedXlsx.allRows.filter((r) => r !== null);
  const results = runMatcher(cleanRows, comparable);
  state.results = results;
  renderResults();
  goToStep(3);
});

/* ---------- Step 3: results ---------- */

const SIZE_SPLIT_RE = /^(.*?)\s+(\d+(?:\.\d+)?\s?(?:ML|L|KG|G|MM))$/i;

function splitNameSize(fullName) {
  const m = fullName.match(SIZE_SPLIT_RE);
  if (m) return { name: m[1].trim(), size: m[2].trim() };
  return { name: fullName, size: "" };
}

function categorize(res) {
  if (res.matchType.startsWith("AUTO")) {
    if (res.old !== null && res.new !== null && Math.round(Number(res.old) * 100) !== Math.round(Number(res.new) * 100)) {
      return "changed";
    }
    return "unchanged";
  }
  if (res.matchType.startsWith("REVIEW")) return "review";
  if (res.matchType.startsWith("SKIPPED")) return "skipped";
  return "notfound";
}

const STATUS_META = {
  changed: { label: "Price changed", cls: "st-changed" },
  unchanged: { label: "Confirmed", cls: "st-unchanged" },
  review: { label: "Needs review", cls: "st-review" },
  notfound: { label: "Not found", cls: "st-notfound" },
  skipped: { label: "Skipped", cls: "st-skipped" },
};

function renderResults() {
  const comparable = state.parsedXlsx.allRows.filter((r) => r !== null);
  const rows = comparable.map((row, i) => {
    const res = state.results[i];
    const { name, size } = splitNameSize(row.name);
    return {
      fullName: row.name,
      name,
      size,
      old: res.old,
      new: res.new,
      matchType: res.matchType,
      note: res.note,
      status: categorize(res),
    };
  });
  rows.sort((a, b) => (a.name + a.size).localeCompare(b.name + b.size));
  state.resultRows = rows;

  const customer = state.parsedXlsx.customerName;
  const account = state.parsedXlsx.accountNumber;
  document.getElementById("results-sub").textContent =
    `${customer}${account ? " (" + account + ")" : ""} — review the changes, then download the updated Excel.`;

  const counts = { changed: 0, unchanged: 0, review: 0, notfound: 0, skipped: 0 };
  for (const r of rows) counts[r.status]++;

  const statsGrid = $("stats-grid");
  statsGrid.innerHTML = "";
  const statDefs = [
    ["changed", "Price updated", "c-auto"],
    ["unchanged", "Confirmed / unchanged", ""],
    ["review", "Needs review", "c-review"],
    ["notfound", "Not found in PDF", "c-notfound"],
    ["skipped", "Skipped variants", ""],
  ];
  for (const [key, label, cls] of statDefs) {
    const div = document.createElement("div");
    div.className = `stat-card ${cls}`;
    div.innerHTML = `<div class="n">${counts[key]}</div><div class="l">${label}</div>`;
    statsGrid.appendChild(div);
  }

  renderResultsTable();
}

function fmtPrice(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(2);
}

function renderResultsTable() {
  const search = $("results-search").value.trim().toLowerCase();
  const filter = $("results-filter").value;
  const tbody = $("results-tbody");
  tbody.innerHTML = "";

  const filtered = state.resultRows.filter((r) => {
    if (filter !== "all" && r.status !== filter) return false;
    if (search && !r.fullName.toLowerCase().includes(search)) return false;
    return true;
  });

  $("results-empty").hidden = filtered.length !== 0;

  const frag = document.createDocumentFragment();
  for (const r of filtered) {
    const tr = document.createElement("tr");
    const meta = STATUS_META[r.status];
    const priceUp = r.status === "changed" && r.new !== null && r.old !== null && Number(r.new) > Number(r.old);
    tr.innerHTML = `
      <td>${escapeHtml(r.name)}${r.size ? ` <span style="color:var(--text-dim);">${escapeHtml(r.size)}</span>` : ""}</td>
      <td class="price-old">${fmtPrice(r.old)}</td>
      <td class="price-new${priceUp ? " up" : ""}">${fmtPrice(r.new)}</td>
      <td><span class="status-badge ${meta.cls}">${meta.label}</span></td>
      <td class="note-cell" title="${escapeHtml(r.matchType)}">${escapeHtml(r.note || r.matchType)}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("results-search").addEventListener("input", renderResultsTable);
$("results-filter").addEventListener("change", renderResultsTable);
$("btn-back-2").addEventListener("click", () => goToStep(2));

/* ---------- downloads ---------- */

function pad2(n) { return String(n).padStart(2, "0"); }

function timestampedFilename(base, ext) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return `${base} ${stamp}.${ext}`;
}

$("btn-download-xlsx").addEventListener("click", () => {
  const customer = state.parsedXlsx.customerName;
  const account = state.parsedXlsx.accountNumber;
  const wbOut = buildOutputWorkbook(state.parsedXlsx, state.results);
  const base = `${customer}${account ? " (" + account + ")" : ""} - Price Update`;
  XLSX.writeFile(wbOut, timestampedFilename(base, "xlsx"));
});

$("btn-download-report").addEventListener("click", () => {
  const html = buildReportHtml(state.parsedXlsx.customerName, state.parsedXlsx.accountNumber, state.resultRows);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = timestampedFilename(`${state.parsedXlsx.customerName} - Price List Report`, "html");
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

function buildReportHtml(customerName, accountNumber, rows) {
  const dataJson = JSON.stringify(
    rows.map((r) => ({ name: r.name, size: r.size, price: r.new, old: r.old, status: r.status, note: r.matchType }))
  );
  const title = `${customerName}${accountNumber ? " (" + accountNumber + ")" : ""} — Price List`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  :root{--bg:#0a0b0f;--panel:#14161f;--panel-2:#1a1d29;--border:#262a38;--text:#f2f3f5;--text-muted:#9aa0ab;--text-dim:#6b7180;--teal:#5eead4;--teal-ink:#063a35;--yellow:#f5c518;--danger:#f38b8b;--radius:12px;--font:-apple-system,"system-ui","Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  *{box-sizing:border-box;} html,body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);}
  body{padding:32px 20px 60px;} .wrap{max-width:900px;margin:0 auto;}
  h1{font-size:19px;margin:0 0 4px;} .sub{color:var(--text-muted);font-size:13px;margin:0 0 20px;}
  .toolbar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;}
  input,select{background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px 12px;font-size:13px;font-family:var(--font);}
  input{flex:1;min-width:160px;}
  table{width:100%;border-collapse:collapse;font-size:13px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim);background:var(--panel-2);padding:10px 12px;border-bottom:1px solid var(--border);}
  td{padding:8px 12px;border-bottom:1px solid var(--border);}
  tr:last-child td{border-bottom:none;}
  .old{color:var(--text-dim);text-decoration:line-through;font-family:monospace;font-size:12px;}
  .new{font-family:monospace;font-weight:600;}
  .badge{display:inline-flex;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;}
  .st-changed{background:rgba(94,234,212,.12);color:var(--teal);}
  .st-unchanged{background:rgba(255,255,255,.06);color:var(--text-muted);}
  .st-review{background:rgba(245,197,24,.12);color:var(--yellow);}
  .st-notfound{background:rgba(243,139,139,.12);color:var(--danger);}
  .st-skipped{background:rgba(255,255,255,.04);color:var(--text-dim);}
  footer{text-align:center;color:var(--text-dim);font-size:12px;margin-top:24px;}
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(customerName)}${accountNumber ? ` <span style="color:var(--text-dim);font-weight:500;">(${escapeHtml(accountNumber)})</span>` : ""}</h1>
  <p class="sub">Generated by Price List Updater — ${new Date().toLocaleString()}</p>
  <div class="toolbar">
    <input type="text" id="q" placeholder="Search product name…" />
    <select id="f">
      <option value="all">All statuses</option>
      <option value="changed">Price changed</option>
      <option value="unchanged">Confirmed / unchanged</option>
      <option value="review">Needs review</option>
      <option value="notfound">Not found</option>
      <option value="skipped">Skipped</option>
    </select>
  </div>
  <table>
    <thead><tr><th>Product</th><th>Old</th><th>New</th><th>Status</th><th>Note</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <footer>Static report — no data leaves this page.</footer>
</div>
<script>
  const ROWS = ${dataJson};
  const META = {
    changed:["Price changed","st-changed"], unchanged:["Confirmed","st-unchanged"],
    review:["Needs review","st-review"], notfound:["Not found","st-notfound"], skipped:["Skipped","st-skipped"]
  };
  function esc(s){return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function fmt(v){return v===null||v===undefined||isNaN(Number(v))?"—":Number(v).toFixed(2);}
  function render(){
    const q = document.getElementById("q").value.trim().toLowerCase();
    const f = document.getElementById("f").value;
    const tbody = document.getElementById("tbody");
    tbody.innerHTML = "";
    for (const r of ROWS) {
      if (f !== "all" && r.status !== f) continue;
      if (q && !(r.name + " " + r.size).toLowerCase().includes(q)) continue;
      const [label, cls] = META[r.status];
      const tr = document.createElement("tr");
      tr.innerHTML = \`<td>\${esc(r.name)}\${r.size?" <span style='color:var(--text-dim)'>"+esc(r.size)+"</span>":""}</td>
        <td class="old">\${fmt(r.old)}</td><td class="new">\${fmt(r.price)}</td>
        <td><span class="badge \${cls}">\${label}</span></td>
        <td style="color:var(--text-dim);font-size:11.5px;">\${esc(r.note)}</td>\`;
      tbody.appendChild(tr);
    }
  }
  document.getElementById("q").addEventListener("input", render);
  document.getElementById("f").addEventListener("change", render);
  render();
<\/script>
</body>
</html>`;
}

/* =========================================================================
   MODE SELECTOR
   ========================================================================= */

$("mode-card-update").addEventListener("click", () => {
  $("mode-selector").hidden = true;
  $("mode-update-wrap").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("mode-card-build").addEventListener("click", () => {
  $("mode-selector").hidden = true;
  $("mode-build-wrap").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
});

document.querySelectorAll("[data-back-to-selector]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("mode-update-wrap").hidden = true;
    $("mode-build-wrap").hidden = true;
    $("mode-selector").hidden = false;
    clearBanner();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

/* =========================================================================
   MODE: BUILD NEW PRICELIST
   New customer, no existing Odoo export — upload their typed/digital price
   list PDF and this reads it, matches every row against the live Olympic
   Paints product catalog (catalog-data.js + catalog-match.js — the browser
   port of the Phase 8 Python matching engine, hand-verified against Kelly's
   Hardware and Acornhoek Hardware's real builds), and produces a
   from-scratch Odoo pricelist import Excel with freshly-minted, stable
   External IDs — fully automatically, no manual transcription step.
   Anything that can't be safely auto-matched is flagged REVIEW NEEDED /
   NOT FOUND rather than guessed — same standing rule as every other phase
   of this project. Scanned/handwritten PDFs (and PDFs with handwritten
   price corrections on top of printed prices) are deliberately NOT handled
   here — this mode only trusts the PDF's printed text layer and has no way
   to see or verify handwriting, so a handwritten override could otherwise
   be silently missed. Those go to the user's chat with Claude instead,
   where they're transcribed and verified by eye before matching.
   ========================================================================= */

const stateB = {
  pdfFile: null,
  customer: "",
  account: "",
  results: null,
  displayRows: null,
};

function goToStepB(n) {
  for (let i = 1; i <= 2; i++) {
    $(`panel-b${i}`).classList.toggle("active", i === n);
    const pill = $(`b-step-pill-${i}`);
    pill.classList.toggle("active", i === n);
    pill.classList.toggle("done", i < n);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Step B1: customer details + PDF ---------- */

function updateBContinueButton() {
  const ok = !!stateB.pdfFile && $("b-customer-name").value.trim() && $("b-account-number").value.trim();
  $("b-btn-continue").disabled = !ok;
}

setupDropzone("b-dz-pdf", "b-file-pdf", "b-dz-pdf-filename", "b-dz-pdf-title", (file) => {
  stateB.pdfFile = file;
  updateBContinueButton();
});

$("b-customer-name").addEventListener("input", updateBContinueButton);
$("b-account-number").addEventListener("input", updateBContinueButton);

// A pack-size token leading the label, e.g. "1LT High Gloss Enamel Colours"
// -> pack "1LT", product "High Gloss Enamel Colours". If the label doesn't
// start with a recognisable size, the whole thing goes in "product" and the
// pack is left blank for manual entry — never guessed.
const LEADING_PACK_RE = /^(\d+(?:\.\d+)?)\s*(ML|LT|L|KG|GR|GM|G|MM)\b\s*(.*)$/i;

function splitLeadingPack(label) {
  const m = String(label || "").trim().match(LEADING_PACK_RE);
  if (!m) return { pack: "", product: String(label || "").trim() };
  return { pack: `${m[1]}${m[2]}`.toUpperCase(), product: m[3].trim() };
}

$("b-btn-continue").addEventListener("click", async () => {
  clearBanner();
  const btn = $("b-btn-continue");
  const originalLabel = btn.innerHTML;
  const customer = $("b-customer-name").value.trim();
  const account = $("b-account-number").value.trim();
  if (!customer || !account || !stateB.pdfFile) {
    showBanner("Enter the customer name, account number, and upload their PDF before continuing.", "error");
    return;
  }
  if (!window.NewPricelistPipeline) {
    showBanner("The product catalog didn't load — check your connection and reload the page.", "error");
    return;
  }
  stateB.customer = customer;
  stateB.account = account;

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Reading PDF…`;
  try {
    const { rows, hasText } = await extractPdfRows(stateB.pdfFile);

    if (!rows.length) {
      showBanner(
        "Couldn't find readable price rows in this PDF — it looks scanned, handwritten, or laid out in a way " +
        "this automatic mode can't parse. Attach this PDF directly in your chat with Claude instead: it will " +
        "transcribe every row (zooming into any handwriting) and build the Excel for you.",
        "warn"
      );
      return;
    }

    let flat = [];
    for (const r of rows) {
      const { pack, product } = splitLeadingPack(r.label);
      flat = flat.concat(window.NewPricelistPipeline.processRow({ product, pack, printed: r.price }));
    }
    flat = window.NewPricelistPipeline.mergeDuplicates(flat);
    flat.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    stateB.results = flat;
    renderBResults();
    goToStepB(2);
  } catch (err) {
    showBanner(err.message || String(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
    updateBContinueButton();
  }
});

/* ---------- Step B2: results ---------- */

const B_STATUS_META = {
  matched: { label: "Matched", cls: "st-changed" },
  corrected: { label: "Name corrected", cls: "st-changed" },
  generated: { label: "Generated (Colours)", cls: "st-unchanged" },
  split: { label: "Split (slash)", cls: "st-unchanged" },
  review: { label: "Needs review", cls: "st-review" },
  notfound: { label: "Not found", cls: "st-notfound" },
};

function categorizeB(row) {
  if (row.matchType === "AUTO") {
    if (row.note && row.note.startsWith("Generated from")) return "generated";
    if (row.note && row.note.startsWith("Split from")) return "split";
    if (row.note && row.note.startsWith("Name corrected")) return "corrected";
    return "matched";
  }
  if (row.matchType === "REVIEW") return "review";
  return "notfound";
}

function renderBResults() {
  const rows = stateB.results.map((r) => ({ ...r, status: categorizeB(r) }));
  stateB.displayRows = rows;

  $("b-results-sub").textContent =
    `${stateB.customer} (${stateB.account}) — ${rows.length} row${rows.length === 1 ? "" : "s"}. ` +
    `Review flagged rows before importing into Odoo, then download.`;

  const counts = { matched: 0, corrected: 0, generated: 0, split: 0, review: 0, notfound: 0 };
  for (const r of rows) counts[r.status]++;

  const statsGrid = $("b-stats-grid");
  statsGrid.innerHTML = "";
  const statDefs = [
    ["matched", "Matched", "c-auto"],
    ["corrected", "Name corrected", "c-auto"],
    ["generated", "Generated (Colours)", ""],
    ["split", "Split (slash)", ""],
    ["review", "Needs review", "c-review"],
    ["notfound", "Not found", "c-notfound"],
  ];
  for (const [key, label, cls] of statDefs) {
    const div = document.createElement("div");
    div.className = `stat-card ${cls}`;
    div.innerHTML = `<div class="n">${counts[key]}</div><div class="l">${label}</div>`;
    statsGrid.appendChild(div);
  }

  renderBResultsTable();
}

function renderBResultsTable() {
  const search = $("b-results-search").value.trim().toLowerCase();
  const filter = $("b-results-filter").value;
  const tbody = $("b-results-tbody");
  tbody.innerHTML = "";

  const filtered = stateB.displayRows.filter((r) => {
    if (filter !== "all" && r.status !== filter) return false;
    if (search && !String(r.name).toLowerCase().includes(search)) return false;
    return true;
  });

  $("b-results-empty").hidden = filtered.length !== 0;

  const frag = document.createDocumentFragment();
  for (const r of filtered) {
    const tr = document.createElement("tr");
    const meta = B_STATUS_META[r.status];
    tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td class="price-new">${fmtPrice(r.price)}</td>
      <td><span class="status-badge ${meta.cls}">${meta.label}</span></td>
      <td class="note-cell" title="${escapeHtml(r.note || "")}">${escapeHtml(r.note || "")}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

$("b-results-search").addEventListener("input", renderBResultsTable);
$("b-results-filter").addEventListener("change", renderBResultsTable);
$("b-btn-back-result").addEventListener("click", () => goToStepB(1));

/* ---------- Step B2: download ---------- */

// Same 13-column Odoo pricelist import shape, and the same
// __import__.olympic_pricelist(_item)_<account>[_NNNN] External-ID scheme,
// as every from-scratch build in this project since Phase 8 — so a
// re-import of the same customer later updates these rows instead of
// duplicating them.
function buildFromScratchWorkbook(customerLabel, rows, accountCode) {
  const headers = [
    "id", "name", "company_id", "selectable", "item_ids/applied_on",
    "item_ids/display_applied_on", "item_ids/id", "item_ids/product_tmpl_id/name",
    "item_ids/compute_price", "item_ids/fixed_price", "item_ids/min_quantity",
    "item_ids/date_start", "Note",
  ];
  const withIds = window.NewPricelistPipeline.mintIds(rows, accountCode);
  const aoa = [headers];
  withIds.forEach((row, i) => {
    aoa.push([
      i === 0 ? row.pricelistId : null,
      i === 0 ? customerLabel : null,
      i === 0 ? "Olympic Paints" : null,
      i === 0 ? false : null,
      "Product", "Product",
      row.itemId,
      row.name,
      "Fixed Price",
      Math.round(Number(row.price) * 100) / 100,
      0,
      null,
      row.note || "",
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [34, 24, 14, 10, 16, 20, 30, 40, 14, 14, 12, 14, 70].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Pricelist");
  return wb;
}

$("b-btn-download-xlsx").addEventListener("click", () => {
  const customerLabel = `${stateB.customer} (${stateB.account})`;
  const wb = buildFromScratchWorkbook(customerLabel, stateB.results, stateB.account);
  const base = `${stateB.customer} (${stateB.account}) - Price List`;
  XLSX.writeFile(wb, timestampedFilename(base, "xlsx"));
});

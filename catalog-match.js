// catalog-match.js — client-side port of the Phase 8 Python matching engine
// (matcher.py / rebuild_names.py / build_pricelists.py's VOCAB expansion),
// hand-verified against Kelly's Hardware (KK038) and Acornhoek Hardware
// (KA058)'s from-scratch pricelist builds. Classic script (not a module) —
// exposes window.CatalogEngine and window.NewPricelistPipeline.
//
// Requires catalog-data.js (window.CATALOG_EXACT / window.CATALOG_TRAILING)
// to be loaded first.
//
// Never guesses: every function here either returns a name that exactly
// exists in the live Odoo catalog, or returns null/flags so the caller can
// mark the row REVIEW NEEDED / NOT FOUND. Nothing is invented.

(function () {
  "use strict";

  const EXACT = window.CATALOG_EXACT || {};
  const TRAILING = window.CATALOG_TRAILING || {};

  /* ============================== matcher.py port ============================== */

  function normWs(s) {
    return String(s).replace(/\s+/g, " ").trim().toUpperCase();
  }

  function normalizePack(tokRaw) {
    const t = String(tokRaw).trim().toUpperCase();
    const m = t.match(/^(\d+(?:\.\d+)?)(LT|KG|GR|MM|ML|L|G)$/);
    if (!m) return [t];
    const num = m[1];
    const unit = m[2];
    const cands = [];
    if (unit === "LT") cands.push(num + "L");
    else if (unit === "KG") cands.push(num + "KG");
    else if (unit === "GR") { cands.push(num + "GR"); cands.push(num + "G"); }
    else if (unit === "G") { cands.push(num + "G"); cands.push(num + "GR"); }
    else cands.push(num + unit);
    cands.push(t);
    return cands;
  }

  // frozenset(...) equivalent: a de-duplicating word-set, with Q+D -> QD and
  // 3+IN+1 -> 3IN1 merged so "Q.D"/"Q D"/"QD" and "3-In-1"/"3 In 1"/"3IN1"
  // compare equal — exactly matcher.py's bag().
  function bagOf(sRaw) {
    const words = String(sRaw).toUpperCase().replace(/[^A-Z0-9 ]/g, " ");
    const toks = words.split(/\s+/).filter(Boolean);
    const out = [];
    let i = 0;
    while (i < toks.length) {
      if (toks[i] === "Q" && toks[i + 1] === "D") { out.push("QD"); i += 2; continue; }
      if (toks[i] === "3" && toks[i + 1] === "IN" && toks[i + 2] === "1") { out.push("3IN1"); i += 3; continue; }
      out.push(toks[i]);
      i += 1;
    }
    return new Set(out);
  }

  function bagKey(bagSet) {
    return Array.from(bagSet).sort().join(" ");
  }

  function isSubset(small, big) {
    for (const x of small) if (!big.has(x)) return false;
    return true;
  }

  // Precompute a bag-index over every catalog "base" (name minus its
  // trailing size token), mirroring matcher.py's module-level _bag_index.
  const baseBagCache = new Map();
  const bagIndex = new Map();
  for (const base of Object.keys(TRAILING)) {
    const b = bagOf(base);
    baseBagCache.set(base, b);
    const k = bagKey(b);
    if (!bagIndex.has(k)) bagIndex.set(k, []);
    bagIndex.get(k).push(base);
  }

  // Returns {name: realCatalogNameOrNull, method: string}
  function matchName(fullNameRaw) {
    const fullName = String(fullNameRaw || "").trim();
    const m = fullName.match(/^(\S+)\s+([\s\S]*)$/);
    if (!m || !m[2].trim()) return { name: null, method: "no-pack-token" };
    const packTok = m[1];
    const rest = m[2];
    const restNorm = normWs(rest);
    const packCands = normalizePack(packTok);

    for (const candSize of packCands) {
      if (TRAILING[restNorm] && TRAILING[restNorm][candSize]) {
        return { name: TRAILING[restNorm][candSize], method: "trailing-exact" };
      }
      const key = normWs(`${rest} ${candSize}`);
      if (EXACT[key]) return { name: EXACT[key], method: "exact-reordered" };
    }

    const b = bagOf(restNorm);
    const bk = bagKey(b);
    if (bagIndex.has(bk)) {
      for (const base of bagIndex.get(bk)) {
        for (const candSize of packCands) {
          if (TRAILING[base][candSize]) return { name: TRAILING[base][candSize], method: "bag-match" };
        }
      }
    }

    const whole = normWs(fullName);
    if (EXACT[whole]) return { name: EXACT[whole], method: "whole-exact" };
    const wb = bagOf(whole);
    const wbk = bagKey(wb);
    const hits = new Set();
    if (bagIndex.has(wbk)) {
      for (const base of bagIndex.get(wbk)) {
        for (const real of Object.values(TRAILING[base])) hits.add(real);
      }
    }
    if (hits.size === 1) return { name: Array.from(hits)[0], method: "whole-bag-unique" };
    return { name: null, method: "not-found" };
  }

  // Non-binding hints only — never auto-applied. Mirrors matcher.py suggest().
  function suggest(fullNameRaw, maxExtraWords) {
    maxExtraWords = maxExtraWords == null ? 3 : maxExtraWords;
    const fullName = String(fullNameRaw || "").trim();
    const m = fullName.match(/^(\S+)\s+([\s\S]*)$/);
    if (!m || !m[2].trim()) return [];
    const packTok = m[1];
    const rest = m[2];
    const mineWords = bagOf(rest);
    if (!mineWords.size) return [];
    const packCands = new Set(normalizePack(packTok));
    const results = [];
    for (const base of Object.keys(TRAILING)) {
      const baseWords = baseBagCache.get(base);
      if (!isSubset(mineWords, baseWords)) continue;
      const extra = baseWords.size - mineWords.size;
      if (extra > maxExtraWords) continue;
      const sizes = TRAILING[base];
      for (const size of Object.keys(sizes)) {
        results.push({ real: sizes[size], extra, sizeMatch: packCands.has(size) });
      }
    }
    results.sort((a, b) => (a.sizeMatch === b.sizeMatch ? a.extra - b.extra : a.sizeMatch ? -1 : 1));
    const seen = new Set();
    const out = [];
    for (const r of results) {
      if (seen.has(r.real)) continue;
      seen.add(r.real);
      out.push({ name: r.real, extra: r.extra });
      if (out.length >= 3) break;
    }
    return out;
  }

  /* ===================== line/colour splitting (for "Colours" tag + slash rows) =====================
     Ported from app.js's existing normalizeText / tokensOf / productLineKey / colourWords —
     duplicated here (not imported) so this file has no load-order dependency on app.js. */

  const NON_COLOUR_WORDS = new Set([
    "1LT", "5LT", "20LT", "LT", "X", "DOZ",
    "COLOURS", "COLORS", "COLOUR", "COLOR", "QD", "ENAMEL", "HIGH", "GLOSS",
    "ULTIMATE", "SHINE", "UNIVERSAL", "ROOF", "UNDERCOAT", "UNIV", "MASTER",
    "DECORATORS", "PICK", "SAVE", "AND", "N", "ECONO", "DECOR", "PVA", "ECLIPSE",
    "7", "IN", "1", "ACRYLIC", "LOW", "SHEEN", "VARNISH", "STAINERS", "BONDING",
    "LIQUID", "FACE", "BRICK", "DRESSING", "HI", "HIDING", "CONTRACTORS", "CONT",
    "PUTTY", "CRACK", "FILLER", "DISTEMPER", "MEMBRANE", "WATERBASE", "WATERBASED", "PLASTER",
    "PRIMER", "OXIDE", "PRODUCT", "PRICE", "APRIL",
    "STOEP", "GRIP", "COAT", "RAINPROOF", "BASE", "CLEAR", "PLAIN", "ALKYD",
    "HYPER", "STEEL",
  ]);

  const SIZE_TOKEN_RE = /^\d+(\.\d+)?(ML|L|KG|G|MM)$/;
  const MULT_TOKEN_RE = /^X\d+$/;

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

  // Real Odoo catalog line-name text for each canonical key, in priority
  // order (first candidate tried first). Corrections here come directly
  // from Phase 8's cross-check against the live 13,247-product catalog —
  // where a line genuinely has two real variants (plain vs "Hyper Steel"),
  // both are listed so the safe, exact/bag matcher below picks whichever
  // one actually exists for that colour+size, never guessing between them.
  const REAL_LINE_PREFIXES = {
    "GRIP COAT": ["3-In-1 Q.D Grip Coat", "Hyper Steel Q.D Grip Coat"],
    "QD ENAMEL": ["Q.D Enamel", "Hyper Steel Q.D Enamel"],
    "QD BLACK OXIDE PRIMER": ["Q.D Black Oxide Primer"],
    "QD RED OXIDE PRIMER": ["Q.D Oxide Primer Red"],
    "HIGH GLOSS ENAMEL": ["High Gloss Enamel"],
    "ULTIMATE SHINE": ["Ultimate Shine"],
    "UNIVERSAL ROOF": ["Universal Roof", "Univ Roof"],
    "UNIVERSAL UNDERCOAT": ["Univ Undercoat", "Universal Undercoat"],
    "MASTER DECORATORS": ["Master Decorators"],
    "PICK AND SAVE": ["Pick 'N Save Econo", "Pick and Save"],
    "DECOR PVA": ["Decor", "Decor Pva"],
    "ECLIPSE PVA": ["Eclipse Pva"],
    "7 IN 1 ACRYLIC PVA": ["7 In 1 Acrylic Pva"],
    "VARNISH": ["Varnish"],
    "STAINERS": ["Stainers"],
    "BONDING LIQUID": ["Bonding Liquid"],
    "FACE BRICK": ["Face Brick"],
    "HI HIDING PVA CONTRACTORS": ["Hi Hiding Pva Contractors"],
    "PUTTY": ["Putty"],
    "CRACK FILLER": ["Crack Filler"],
    "DISTEMPER": ["Distemper"],
    "RAINPROOF": ["Rainproof"],
    "MEMBRANE": ["Membrane"],
    "WATERBASE PLASTER PRIMER": ["Waterbased Plaster Primer", "Waterbase Plaster Primer"],
    "OXIDE SINGLE": ["Oxide Primer", "Q.D Oxide Primer"],
    "STOEP": ["Stoep"],
  };

  function normalizeText(sRaw) {
    let s = String(sRaw).toUpperCase();
    s = s.replace(/Q\.D/g, "QD").replace(/Q D/g, "QD");
    s = s.replace(/'/g, "'").replace(/[–—]/g, "-");
    s = s.replace(/[.\-/(),'&]/g, " ");
    s = s.replace(/(\d+(?:\.\d+)?)\s*LT\b/g, "$1L");
    s = s.replace(/(\d+(?:\.\d+)?)\s*(GR|GM)\b/g, "$1G");
    s = s.replace(/(\d+(?:\.\d+)?)\s*KG\b/g, "$1KG");
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  function tokensOf(normStr) {
    return normStr.split(" ").filter(Boolean);
  }

  function productLineKey(tokenSet) {
    let best = null;
    let bestLen = 0;
    for (const [aliasTokens, canon] of PRODUCT_LINE_ALIASES) {
      if (aliasTokens.every((t) => tokenSet.has(t))) {
        if (aliasTokens.length > bestLen) { best = canon; bestLen = aliasTokens.length; }
      }
    }
    return best;
  }

  function colourWords(tokens) {
    return tokens.filter(
      (t) => !NON_COLOUR_WORDS.has(t) && !/^\d+$/.test(t) && !SIZE_TOKEN_RE.test(t) && !MULT_TOKEN_RE.test(t)
    );
  }

  function titleCase(s) {
    return String(s)
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function linePrefixesFor(canonKey) {
    if (!canonKey) return null;
    return REAL_LINE_PREFIXES[canonKey] || [titleCase(canonKey)];
  }

  // Try to match a (pack, productText) pair against the catalog two ways:
  // first exactly as typed, then — if that fails and the text names a
  // recognised product line — retrying with that line's REAL catalog
  // prefix substituted in (e.g. a PDF's "Pick and Save Black" retried as
  // "Pick 'N Save Econo Black", or "Ultimate Shine Enamel D Blue" retried
  // as "Ultimate Shine D Blue"). Both attempts still only ever return a
  // name that's an exact/bag match in the live catalog — never a guess.
  // `prefixesOverride` lets a caller supply the line prefixes detected from
  // a larger piece of text than `productText` itself (needed for slash-list
  // parts like "Cream" that don't repeat the line name on their own).
  function matchWithLineFallback(pack, productText, prefixesOverride) {
    let hit = matchName(`${pack} ${productText}`);
    if (hit.name) return hit;
    const tokens = tokensOf(normalizeText(productText));
    const prefixes = prefixesOverride !== undefined ? prefixesOverride : linePrefixesFor(productLineKey(new Set(tokens)));
    if (prefixes) {
      const colour = colourWords(tokens).join(" ");
      if (colour) {
        for (const prefix of prefixes) {
          hit = matchName(`${pack} ${prefix} ${colour}`);
          if (hit.name) return hit;
        }
      }
    }
    return { name: null, method: "not-found" };
  }

  /* ============================== pipeline ============================== */

  // A generic "Colours" row: scan the live catalog for every colour that
  // exists for this product line + pack size. Nothing is invented — only
  // colours that are literally present in the catalog for this exact line
  // and pack size are returned.
  function expandColoursRow(pack, productText, price, origLabel) {
    const tokens = tokensOf(normalizeText(productText));
    const canonKey = productLineKey(new Set(tokens));
    const prefixes = linePrefixesFor(canonKey);
    if (!prefixes) {
      return {
        recognized: false,
        rows: [
          {
            name: origLabel,
            price,
            matchType: "REVIEW",
            note:
              `REVIEW NEEDED: "${origLabel}" is tagged as a generic "Colours" row, but this product line ` +
              `isn't one this tool recognises yet, so it can't be safely expanded into individual colours. ` +
              `Add the colours for this line as separate rows instead, or tell Pratik's app maintainer to add ` +
              `this line to its list.`,
          },
        ],
      };
    }
    const packCands = normalizePack(pack);
    const found = new Map(); // realName -> colourText
    for (const prefix of prefixes) {
      // Require the catalog base to POSITIONALLY start with the exact
      // prefix tokens (not just "contains the same words somewhere") — a
      // handful of catalog entries carry a stray leading item code (a
      // data-entry artifact from the source PDFs, e.g. "299725 High Gloss
      // Enamel Grey 1L"); a loose bag-subset check would wrongly treat
      // that code as part of the colour and mint a garbage product name.
      // Anchoring the prefix to the start rules those out completely.
      const prefixTokens = prefix.trim().toUpperCase().split(/\s+/).filter(Boolean);
      const ptLen = prefixTokens.length;
      for (const base of Object.keys(TRAILING)) {
        const baseTokens = base.split(" ");
        if (baseTokens.length <= ptLen) continue; // no leftover colour words
        let positional = true;
        for (let i = 0; i < ptLen; i++) {
          if (baseTokens[i] !== prefixTokens[i]) { positional = false; break; }
        }
        if (!positional) continue;
        const sizes = TRAILING[base];
        let realName = null;
        let matchedSize = null;
        for (const sc of packCands) {
          if (sizes[sc]) { realName = sizes[sc]; matchedSize = sc; break; }
        }
        if (!realName || found.has(realName)) continue;
        const colourText = titleCase(baseTokens.slice(ptLen).join(" ").toLowerCase());
        if (colourText) found.set(realName, colourText);
      }
    }
    if (!found.size) {
      return {
        recognized: true,
        rows: [
          {
            name: origLabel,
            price,
            matchType: "REVIEW",
            note:
              `REVIEW NEEDED: "${origLabel}" is tagged as a generic "Colours" row for a recognised product line, ` +
              `but no colours for that line + pack size (${pack}) were found in your live Odoo catalog. The pack ` +
              `size may not exist for this line, or the catalog may need refreshing. Name kept as transcribed.`,
          },
        ],
      };
    }
    const rows = [];
    for (const [realName, colourText] of found) {
      rows.push({
        name: realName,
        price,
        matchType: "AUTO",
        note:
          `Generated from the PDF's generic "${origLabel}" line — not printed individually on the price sheet, ` +
          `priced the same as every other colour in that generic line (${Number(price).toFixed(2)} each). ` +
          `Colour "${colourText}" confirmed against your live Odoo product catalog for this product line and pack size.`,
      });
    }
    return { recognized: true, rows };
  }

  // A slash-separated row ("White / Cream / Brown"): split into one row per
  // literal colour, matching each against the catalog independently.
  function splitSlashRow(pack, productText, price, origLabel) {
    const parts = productText.split("/").map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;

    // Detected once from the WHOLE label (e.g. "Decor White / Cream") since
    // later parts ("Cream") typically don't repeat the line name on their own.
    const wholeTokens = tokensOf(normalizeText(productText));
    const prefixes = linePrefixesFor(productLineKey(new Set(wholeTokens)));

    const rows = [];
    for (const partRaw of parts) {
      // Attempt 1: the part exactly as typed (covers PDFs that repeat the
      // full "Line Colour" text on every slash segment). Attempt 2: the
      // line's real catalog prefix (detected from the whole label) + this
      // part's own colour words.
      const hit = matchWithLineFallback(pack, partRaw, prefixes);
      if (hit && hit.name) {
        rows.push({
          name: hit.name,
          price,
          matchType: "AUTO",
          note: `Split from PDF's combined listing "${origLabel}" into one line item per named colour.`,
        });
      } else {
        const sugg = suggest(`${pack} ${partRaw}`);
        const label = `${partRaw} (from combined listing "${origLabel}")`;
        if (sugg.length) {
          const suggTxt = sugg.map((s) => `"${s.name}"`).join("; ");
          rows.push({
            name: label,
            price,
            matchType: "REVIEW",
            note:
              `REVIEW NEEDED: "${partRaw}" (split from "${origLabel}") was not found as an exact product in your ` +
              `Odoo catalog. Possible match(es), NOT auto-applied: ${suggTxt}. Name kept as transcribed — needs ` +
              `your confirmation before import.`,
          });
        } else {
          rows.push({
            name: label,
            price,
            matchType: "NOTFOUND",
            note:
              `NOT FOUND: "${partRaw}" (split from "${origLabel}") does not match any product in your Odoo ` +
              `catalog, and no close candidate was found. Name kept as transcribed.`,
          });
        }
      }
    }
    return rows;
  }

  // A plain row naming exactly one colour (or a fixed single-colour
  // product): matched directly against the catalog, no line-guessing
  // needed at all.
  function processPlainRow(pack, productText, price, origLabel) {
    const hit = matchWithLineFallback(pack, productText);
    if (hit.name) {
      const alreadyExact = normWs(hit.name) === normWs(`${pack} ${productText}`);
      return [
        {
          name: hit.name,
          price,
          matchType: "AUTO",
          note: alreadyExact
            ? ""
            : `Name corrected to match Odoo catalog (was transcribed as "${origLabel}").`,
        },
      ];
    }
    const sugg = suggest(`${pack} ${productText}`);
    if (sugg.length) {
      const suggTxt = sugg.map((s) => `"${s.name}"`).join("; ");
      return [
        {
          name: origLabel,
          price,
          matchType: "REVIEW",
          note:
            `REVIEW NEEDED: "${origLabel}" was not found as an exact product in your Odoo catalog. Possible ` +
            `match(es), NOT auto-applied: ${suggTxt}. Name kept as transcribed — needs your confirmation before import.`,
        },
      ];
    }
    return [
      {
        name: origLabel,
        price,
        matchType: "NOTFOUND",
        note:
          `NOT FOUND: "${origLabel}" does not match any product in your Odoo catalog, and no close candidate ` +
          `was found either. Name kept as transcribed — this product may need to be created in Odoo first, or ` +
          `may be named very differently there.`,
      },
    ];
  }

  // Top-level: takes one editable-table row {product, pack, printed,
  // special} and returns an array of output rows (1 for a plain row, many
  // for a "Colours" tag or slash-list).
  function processRow(row) {
    const pack = String(row.pack || "").trim().toUpperCase();
    const product = String(row.product || "").trim();
    const printed = row.printed === "" || row.printed === null || row.printed === undefined ? null : Number(row.printed);
    const special = row.special === "" || row.special === null || row.special === undefined ? null : Number(row.special);
    const hasSpecial = special !== null && Number.isFinite(special) && special > 0;
    const hasPrinted = printed !== null && Number.isFinite(printed) && printed > 0;
    const price = hasSpecial ? special : hasPrinted ? printed : null;
    const origLabel = `${pack} ${product}`.trim();

    if (!product) return [];
    if (!pack) {
      return [
        {
          name: product,
          price: price || 0,
          matchType: "REVIEW",
          note: `REVIEW NEEDED: no pack size given for "${product}" — can't match against the Odoo catalog without it.`,
        },
      ];
    }
    if (price === null) {
      return [
        {
          name: origLabel,
          price: 0,
          matchType: "REVIEW",
          note: `REVIEW NEEDED: no valid price given for "${origLabel}" (checked both Printed Price and Special Price columns).`,
        },
      ];
    }

    const priceNote = hasSpecial && hasPrinted && Math.round(special * 100) !== Math.round(printed * 100)
      ? ` (special/handwritten price ${special.toFixed(2)} used — printed price was ${printed.toFixed(2)}.)`
      : "";

    const tokens = tokensOf(normalizeText(product));
    const isGeneric = tokens.includes("COLOURS") || tokens.includes("COLORS");

    let results;
    if (isGeneric) {
      results = expandColoursRow(pack, product, price, origLabel).rows;
    } else if (product.includes("/")) {
      results = splitSlashRow(pack, product, price, origLabel) || processPlainRow(pack, product, price, origLabel);
    } else {
      results = processPlainRow(pack, product, price, origLabel);
    }

    if (priceNote) {
      for (const r of results) r.note = (r.note || "") + priceNote;
    }
    for (const r of results) r.origLabel = origLabel;
    return results;
  }

  // Merge rows that resolved to the identical real catalog product (can
  // happen when two differently-worded PDF rows — e.g. a specific colour
  // AND a "Colours" generic line — both resolve to the same product). Keeps
  // the first occurrence; documents any price discrepancy rather than
  // silently picking one, per standing project rule.
  function mergeDuplicates(rows) {
    const byName = new Map();
    const out = [];
    for (const row of rows) {
      if (row.matchType !== "AUTO" || !row.name) { out.push(row); continue; }
      if (!byName.has(row.name)) { byName.set(row.name, row); out.push(row); continue; }
      const existing = byName.get(row.name);
      if (Math.round(existing.price * 100) === Math.round(row.price * 100)) {
        existing.note = (existing.note ? existing.note + " " : "") +
          `(Duplicate PDF row "${row.origLabel || row.name}" at the same price — merged.)`;
      } else {
        existing.note = (existing.note ? existing.note + " " : "") +
          `(Note: an alternate price ${Number(row.price).toFixed(2)} was also seen for this product, from ` +
          `"${row.origLabel || row.name}" — kept ${Number(existing.price).toFixed(2)}. Please verify in Odoo.)`;
      }
    }
    return out;
  }

  function mintIds(rows, accountCode) {
    const slug = String(accountCode || "customer").trim().toLowerCase().replace(/[^a-z0-9]+/g, "") || "customer";
    const pricelistId = `__import__.olympic_pricelist_${slug}`;
    const n = rows.length;
    const pad = Math.max(4, String(n).length);
    return rows.map((row, i) => ({
      ...row,
      itemId: `__import__.olympic_pricelist_item_${slug}_${String(i + 1).padStart(pad, "0")}`,
      pricelistId,
    }));
  }

  window.CatalogEngine = { normWs, normalizePack, bagOf, matchName, suggest };
  window.NewPricelistPipeline = { processRow, mergeDuplicates, mintIds };
})();

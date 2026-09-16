# Price List Updater

A small, self-contained web app for Olympic Paints pricelist work. It has two modes:

- **Update existing pricelist** — drop in a supplier price-update PDF and a customer's pricelist Excel export, and get back an updated Excel file with the new prices applied.
- **Build new pricelist** — drop in a new customer's typed/digital price-list PDF and build a brand-new Odoo pricelist import Excel from scratch, automatically, matched row-by-row against your live product catalog. One upload, one click, done — nothing to type in by hand.

Everything runs **in your browser**. There is no server, no backend, and no upload — the PDF and Excel files never leave your device.

## Mode 1: Update existing pricelist

1. **Upload** — drop in the price-update PDF and the customer's pricelist `.xlsx` (Odoo export format).
2. **Review extracted prices** — the app reads every "label ... price" line out of the PDF and shows it in an editable table. Fix, delete, or add rows before anything gets matched — nothing is applied blindly.
3. **Match** — each row in the Excel (a specific colour + pack size, e.g. "High Gloss Enamel G Brown 5L") is matched against the right PDF price, following the same rules a person would use: an exact colour match first, then a PDF row that says "Colours" (applies to every shade), then a single undifferentiated PDF price if that's all there is — but only when it's safe to assume every colour in that group should move together.
4. **Download** — get the updated Excel back, with the original `item_ids/fixed_price` column updated, plus three new columns: **Old Price**, **Price Match Status**, and **Update Notes**, so every change (and everything that *wasn't* changed) is traceable. A secondary "browsable report" `.html` export is also available if you want a shareable, searchable price list without opening Excel.

### How matching works (update mode)

For each product row in the Excel:

- **Exact colour match** — the PDF names this exact colour (e.g. "1LT QD Enamel Golden Brown") → use that price.
- **Slash-list match** — the PDF lists a few colours together (e.g. "White / Black / Brown") and this colour is one of them → use that price.
- **Generic "Colours" match** — the PDF has one row like "1LT High Gloss Enamel Colours" that's meant to apply to every shade in that product/size → use that price for every colour not named individually elsewhere.
- **Single undifferentiated price** — only one PDF row exists for that product + size and it doesn't name a colour at all → treat it as the default, **but only if this row's current price already matches what every other colour in that group is currently priced at.** If this colour is priced differently from its siblings today, it's flagged for review instead of guessed at — that mismatch is far more likely to mean "this is actually a different tier" than a typo.
- **Verified-uniform cascade** — same idea as above, for when there are several PDF candidates that all happen to agree on price and every colour in the group is already priced identically today.
- Anything that doesn't fit one of these safely is left at its old price and flagged as **Needs review** or **Not found**, with a note explaining why — never silently guessed.

Special "PLAIN", "BASE" and "CLEAR" variant rows are always skipped and flagged rather than auto-updated, since those aren't real colours.

This logic was originally built and hand-verified in Python against a real customer PDF and pricelist (421 rows, cross-checked line by line), including catching and fixing several subtle bugs along the way — bare colour-abbreviation letters ("G Brown" vs "Brown"), duplicate tokens in product names ("Blue Oxide Blue"), and a real pricing risk where one colour in a group was priced completely differently from its siblings and would have been overwritten incorrectly by a naive "just cascade the one PDF price" rule. The JavaScript engine in this app is a direct port of that same logic, and was parity-tested row-by-row against the proven Python output before being trusted here.

### Excel requirements (update mode)

Expects the standard Odoo pricelist export shape, with these two columns present somewhere in the header row:

- `item_ids/product_tmpl_id/name` — the product/colour/size name
- `item_ids/fixed_price` — the current price

Customer name and account number are read from cell B2 (e.g. `Central Building Supplies (KC013)`). If the expected headers aren't found, the app falls back to the standard column positions (H and J) and shows a warning banner so you know to double-check the result.

## Mode 2: Build new pricelist

For a brand-new customer you don't have an Odoo export for yet. Fully automatic for typed/digital PDFs — no manual data entry.

1. **Customer & PDF** — enter the customer's name and account number, and upload their price-list PDF, then click **Generate Excel**. That's it — one step.
2. **Behind the scenes** — the app reads the PDF's text layer, splits every "label ... price" line into a product/colour, pack size (e.g. `1L`, `5L`, `20L`), and price, then matches each one against a live snapshot of your Odoo product catalog (13,000+ product names, refreshed from your official Pricelist PDFs and stock-count exports).
   - A row can be a single colour ("High Gloss Enamel Black"), a generic line ("High Gloss Enamel **Colours**" — expanded into every colour that line actually has in your Odoo catalog, at that pack size), or a combined listing ("White / Cream / Brown" — split into one row per colour). The app detects which shape each PDF line is automatically.
   - A row only gets auto-applied when it resolves to a name that **exactly exists** in that catalog — otherwise it's flagged **Needs review** (with up to 3 non-binding suggestions) or **Not found**, never guessed.
3. **Result & download** — a stats grid shows how many rows were matched outright, name-corrected, generated from a "Colours" line, split from a slash-list, flagged for review, or not found. Search/filter the table, then download the Odoo pricelist import Excel.

### Scanned or handwritten PDFs

This mode deliberately does **not** attempt OCR or handle handwriting — a browser-only guess at handwriting risks a wrong price slipping into Odoo silently, which goes against this project's core rule of never guessing a price. Two cases route elsewhere instead:

- **The PDF has no readable text at all** (scanned or fully handwritten) — the app finds zero price rows and shows a banner telling you to attach that PDF directly in your chat with Claude instead. Claude reads it directly (zooming into every price, including handwriting) and builds the Excel for you there — same result, just a different place.
- **The PDF is typed but has handwritten price corrections written on top of or alongside the printed prices** — this is the more dangerous case, because the app *would* find readable rows (the printed ones) and could silently use the wrong, superseded price. There's no reliable way for the app to detect handwriting on an otherwise-typed page, so this is on you to catch: if any handwritten override appears anywhere on the sheet, upload that PDF in chat instead of using this mode.

### How matching works (build-new-pricelist mode)

This is a browser port of the same product-matching engine used to build every from-scratch pricelist in this project since Phase 8 (Kelly's Hardware, Acornhoek Hardware), hand-verified against those real builds:

- Every row is checked against the live catalog by exact name, by name with the pack size reordered, and by a punctuation/word-order-tolerant match (so "QD Enamel" / "Q.D Enamel" / "3-In-1" / "3 In 1" all compare correctly) — never a fuzzy/approximate guess, always an exact match in the catalog.
- A handful of product lines are spelled differently on price sheets than in Odoo (e.g. a PDF's "Pick and Save" is really "Pick 'N Save Econo" in Odoo, "Universal Undercoat" is really "Univ Undercoat", "Decor PVA" is really just "Decor"). The app knows these corrections and retries with the real spelling before giving up.
- A generic "**Colours**" row is expanded by scanning the live catalog for every colour that line genuinely has at that pack size — never a fixed/hardcoded colour list, and never a colour invented that isn't actually in your catalog. The scan requires the catalog entry to literally start with the product line's real name, so a stray data-entry artifact in the catalog (like a leftover item code) can't be mistaken for a colour.
- Two PDF rows that resolve to the exact same real product (e.g. a specific colour named separately *and* swept up by a "Colours" row) are merged into one line, with any price disagreement between them called out in the note rather than silently picking one.
- Every new pricelist gets freshly-minted, stable Odoo External IDs (`__import__.olympic_pricelist_<account>` / `__import__.olympic_pricelist_item_<account>_NNNN`), so re-importing the same customer later updates these rows instead of creating duplicates — same scheme as every other from-scratch build in this project.

### Output (build-new-pricelist mode)

A 13-column Odoo pricelist import Excel — `id`, `name`, `company_id`, `selectable`, `item_ids/applied_on`, `item_ids/display_applied_on`, `item_ids/id`, `item_ids/product_tmpl_id/name`, `item_ids/compute_price`, `item_ids/fixed_price`, `item_ids/min_quantity`, `item_ids/date_start`, `Note`. The Note column carries the full explanation for every row (matched, name-corrected, generated, split, or flagged) — filter/search the on-screen results table by status before downloading, since the free SheetJS build used here can't colour-highlight cells in the download itself (same limitation as update mode, see below).

### Keeping the catalog current

The product catalog is a static snapshot (`catalog-data.js`) built from your official Pricelist PDFs and stock-count export. If Olympic Paints adds new products or pack sizes, that file needs refreshing — ask in the price-update-methodology project to have it rebuilt from your latest exports.

## PDF requirements (both modes)

Both modes read the PDF's **text layer** directly (via [pdf.js](https://mozilla.github.io/pdf.js/)) — neither does OCR. That means:

- ✅ Works with PDFs exported from Word, Excel, Google Docs, or any system that produces real selectable text.
- ❌ Does not work with scanned or photographed price sheets (image-only PDFs), and isn't safe for a typed PDF with handwritten price corrections written on top. If you try to upload a scanned/handwritten PDF to build-new-pricelist mode, the app tells you clearly and points you to the chat-based path instead (see "Scanned or handwritten PDFs" under Mode 2 above) rather than silently failing or guessing.

The line-extraction heuristic looks for lines ending in a price (e.g. `1LT High Gloss Enamel Colours   84.43`). Because every real-world price sheet is laid out slightly differently, **step 2 always shows you exactly what was extracted before anything is matched**, so you can fix a misread line, delete a stray header/footer line, or add a row the parser missed, in seconds.

## Running it

This is a static site — no build step, no install.

- **Locally:** open `index.html` directly, or serve the folder with any static file server (`python3 -m http.server`, `npx serve`, etc.) — a local server is recommended since some browsers restrict JavaScript modules on `file://` URLs.
- **Hosted (GitHub Pages / Vercel / Netlify / any static host):** push all the files below to a repo and point your host at it. `index.html` is named literally (not with a date/time) because static hosts expect that exact filename as the entry point.

No environment variables, API keys, or backend of any kind are required.

## Files

- `index.html` — page structure and styling (dark theme, matches the visual style of the Dispatch & Trip Sheets app). Has both modes' UI; a mode-selector screen at the top decides which one shows.
- `app.js` — the whole app's UI logic: PDF text extraction and page rendering, the update-mode matching engine, Excel read/write (via [SheetJS](https://sheetjs.com/)), and all step/panel wiring for both modes.
- `catalog-match.js` — the build-new-pricelist matching engine (product-name matching, "Colours" expansion, slash-list splitting, duplicate merging, External-ID minting). Plain script, no build step.
- `catalog-data.js` — the live Olympic Paints product catalog snapshot (13,000+ names) that `catalog-match.js` matches against.

pdf.js and SheetJS are loaded from cdnjs at runtime — an internet connection is needed to load the page the first time, but no file you upload is ever sent anywhere. `catalog-match.js` and `catalog-data.js` are local files loaded alongside `index.html`, so all four files need to stay together in the same folder.

## Known limitations

- **Two-column / multi-price-tier PDF layouts** (e.g. a sheet with several price columns per row) aren't specifically handled — the extractor takes the *last* number on each line as the price. The review tables in both modes are the safety net for this.
- The free/community build of SheetJS used here can't write cell background colors, so the downloaded Excel shows match status as text rather than colour-highlighted cells in both modes.
- One customer at a time — there's no saved history or multi-customer batch mode. Each session starts fresh.
- Build-new-pricelist mode's "Colours" expansion and product-line corrections only know about the lines this project has already encountered (High Gloss Enamel, Q.D Enamel, Ultimate Shine, Univ Undercoat, Master Decorators, Decor, Pick 'N Save Econo, Eclipse PVA, and others — see `catalog-match.js`'s `REAL_LINE_PREFIXES` table). A line it doesn't recognise is flagged **Needs review** with a note asking for that row to be entered individually, rather than guessed at.
- Build-new-pricelist mode cannot read scanned or handwritten PDFs, and cannot detect handwritten price corrections layered on top of a typed PDF — see "Scanned or handwritten PDFs" under Mode 2 above. Those always go through the chat with Claude instead, never through this app.

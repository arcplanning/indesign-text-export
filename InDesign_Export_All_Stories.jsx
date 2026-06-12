/*

An InDesign JavaScript to export all stories.
Copyright © 2009 Adobe Systems Incorporated.
https://console.adobe.io/downloads/id
Revision: Architectural Research Consultants, Incorporated under Adobe SDK License + MIT.

Date: 2025-09-30
Revised: 2026-06-12

Update of Adobe's default script called "ExportAllStories.jsx".
Exports all stories in an InDesign document in a specified text format.
Ignores small text frames, items on pasteboard, and very short text snippets.

Formats: RTF, Plain Text, Markdown, or InDesign Tagged Text. Markdown / Plain Text
are consolidated into a single output file in reading order; RTF / Tagged Text are
written one file per story (the only thing InDesign's native exportFile supports).
Tested on macOS; filenames are sanitised for both macOS and Windows.

Key Features:
- Dialog for user configuration (format, filters, options).
- Reading-order traversal (page order, then top-to-bottom / left-to-right).
- Heading inference from style names, basedOn chain, and optionally text size.
- Automatic detection and export of tables (TSV or Markdown table).
- Cross-reference resolution in content (fast-path when none present).
- Standalone-tables block for tables not tied to any exported story.
*/

// -----------------------
// Constants
// -----------------------
var FORMAT_RTF          = 0;
var FORMAT_PLAIN_TEXT   = 1;
var FORMAT_MARKDOWN     = 2;
var FORMAT_TAGGED_TEXT  = 3;

// -----------------------
// Globals
// -----------------------
var __ALL_TABLES_INDEX__    = null; // [{table, tableId, storyId, storyOffset, pageName, top, left}]
var __TABLES_BY_STORY_ID__  = null; // { storyId: [rec, ...] } -- same recs as above, bucketed
var __EMITTED_TABLE_IDS__   = null; // { tableId: true }
var __HEADING_SIZE_LEVELS__ = null; // { roundedPointSize: headingLevel } when size-inference is enabled

// Hoisted regexes -- ExtendScript does not reliably cache regex literals across calls.
var __RE_RIGHT_INDENT_TAB__ = new RegExp("\\u0019", "g");
var __RE_TAB__              = /\t/g;
var __RE_PAGE_PLACEHOLDER__ = new RegExp("(\\b[Pp]age\\s+)[\\u0000-\\u0008\\u000B-\\u000C\\u000E-\\u001F\\uFFFC\\uFEFF\\uFFFE\\uFFFF]", "g");
var __RE_INVISIBLES__       = new RegExp("[\\u0000-\\u0008\\u000B-\\u000C\\u000E-\\u001F\\uFFFC\\uFEFF\\uFFFE\\uFFFF]", "g");
var __RE_MULTI_SPACE__      = / +/g;
var __RE_CONTROL_CHARS__    = new RegExp("[\\u0000-\\u001F]", "g");
var __RE_TRAILING_DOTSP__   = /[\s.]+$/;
var __RE_TRIM__             = /^\s+|\s+$/g;

// Windows reserved device names. Files with these basenames cannot be created on Windows
// even if the extension differs -- prefix with "_" to dodge.
var __WIN_RESERVED__ = { CON:1, PRN:1, AUX:1, NUL:1,
	COM1:1, COM2:1, COM3:1, COM4:1, COM5:1, COM6:1, COM7:1, COM8:1, COM9:1,
	LPT1:1, LPT2:1, LPT3:1, LPT4:1, LPT5:1, LPT6:1, LPT7:1, LPT8:1, LPT9:1 };

// -----------------------
// Utility Functions
// -----------------------
/**
 * Trims leading and trailing whitespace from a string.
 * @param {string} str - The input string.
 * @returns {string} Trimmed string.
 */
function trim(str) {
	return safeToString(str).replace(__RE_TRIM__, "");
}

/**
 * Repeats a string a specified number of times.
 * @param {string} str - The string to repeat.
 * @param {number} t - Number of repetitions.
 * @returns {string} Repeated string.
 */
function repeat(str, t) {
	var r = "";
	for (var i = 0; i < t; i++) {
		r += str;
	}
	return r;
}

/**
 * Safely converts any value to a string, handling null/undefined and errors.
 * @param {*} x - The value to convert.
 * @returns {string} String representation or empty string on error.
 */
function safeToString(x) {
	if (x === null || typeof x === "undefined") return "";
	try {
		return "" + x;
	} catch (e) {
		return "";
	}
}

/**
 * Safely trims a value after converting it to a string.
 * @param {*} x - The value to trim.
 * @returns {string} Trimmed string.
 */
function safeTrim(x) {
	return trim(x);
}

/**
 * Converts an array-like object to a proper Array, handling errors.
 * @param {*} a - Array-like object.
 * @returns {Array} Array or empty array on error.
 */
function toArray(a) {
	if (!a) return [];
	if (a instanceof Array) return a;
	try {
		var arr = [];
		for (var i = 0; i < a.length; i++) arr.push(a[i]);
		return arr;
	} catch (e) {
		return [];
	}
}

/**
 * parseInt with a typed fallback. Replaces bare parseInt() calls so empty fields
 * or garbage input don't propagate NaN into comparisons (where `x < NaN` is always
 * false and silently disables filters).
 * @param {string} str - Input string.
 * @param {number} fallback - Returned if parsing fails.
 * @returns {number}
 */
function parseIntOr(str, fallback) {
	var n = parseInt(str, 10);
	if (isNaN(n)) return fallback;
	return n;
}

/**
 * Sanitises a story-derived filename so it works on both macOS and Windows.
 * Strips illegal characters, control bytes, trailing dots/spaces (Windows collapses
 * those silently and can collide), and dodges reserved Windows device names like CON.
 * @param {string} name - Raw filename (no extension).
 * @param {string} fallback - Returned if sanitisation empties the name.
 * @returns {string}
 */
function sanitizeFilename(name, fallback) {
	name = safeToString(name).replace(__RE_TRIM__, "");
	var illegal = ["/", "\\", ":", "*", "?", "\"", "<", ">", "|"];
	for (var k = 0; k < illegal.length; k++) name = name.split(illegal[k]).join("");
	name = name.replace(__RE_CONTROL_CHARS__, "");
	if (name.length > 60) name = name.substring(0, 60);
	name = name.replace(__RE_TRAILING_DOTSP__, "");
	if (name === "") return fallback;
	var base = name.replace(/\.[^.]*$/, "").toUpperCase();
	if (__WIN_RESERVED__[base]) name = "_" + name;
	return name;
}

/**
 * Pre-fetches per-paragraph attributes in one DOM round-trip each. ExtendScript's
 * per-property access is the single biggest perf cost on large docs; reading via
 * `paragraphs.everyItem().<prop>` returns the whole array in one call.
 * Falls back to per-item access for any attribute the batch path can't resolve.
 * @param {Object} story - InDesign story.
 * @returns {Object} Snapshot with parallel arrays and a hasCrossRefs flag.
 */
function getStoryParaSnapshot(story) {
	var paras = story.paragraphs;
	var objs;
	try { objs = paras.everyItem().getElements(); } catch (e) { objs = null; }
	// Fallback to per-item access if the batched read fails -- otherwise the story
	// silently snapshots as empty and gets skipped by the word-count filter.
	if (!objs || (objs.length === 0 && paras.length > 0)) objs = toArray(paras);
	var n = objs.length;
	var snap = {
		story: story,
		paras: paras,
		objs: objs,
		length: n,
		contents:         batchProperty(paras, "contents", n, ""),
		leftIndents:      batchProperty(paras, "leftIndent", n, 0),
		firstLineIndents: batchProperty(paras, "firstLineIndent", n, 0),
		bullets:          batchProperty(paras, "bulletsAndNumberingResultText", n, ""),
		styles:           batchProperty(paras, "appliedParagraphStyle", n, null),
		pointSizes:       batchProperty(paras, "pointSize", n, null),
		hasCrossRefs: false
	};
	try { snap.hasCrossRefs = story.crossReferenceSources.length > 0; } catch (eCR) {}
	return snap;
}

/**
 * Reads `coll.everyItem().<prop>` and coerces it to an array of length n. If the
 * batched read fails or returns the wrong shape, falls back to per-item access.
 * Per-item entries that fail (e.g. mixed pointSize across runs in one paragraph)
 * are filled with the supplied fallback.
 * @param {Object} coll - InDesign collection.
 * @param {string} prop - Property name.
 * @param {number} n - Expected length.
 * @param {*} fallback - Value used when an individual entry is unreadable.
 * @returns {Array}
 */
function batchProperty(coll, prop, n, fallback) {
	var batched = null;
	try { batched = coll.everyItem()[prop]; } catch (e) {}
	if (batched && typeof batched.length === "number" && batched.length === n) {
		var out = [];
		for (var i = 0; i < n; i++) {
			var v = batched[i];
			if (typeof v === "undefined" || v === null) v = fallback;
			out.push(v);
		}
		return out;
	}
	var arr = [];
	for (var j = 0; j < n; j++) {
		var item = coll[j];
		var val = fallback;
		try { val = item[prop]; if (typeof val === "undefined" || val === null) val = fallback; } catch (eI) {}
		arr.push(val);
	}
	return arr;
}

/**
 * Cleans special characters from content: replaces tabs, control chars, multiple spaces.
 * Specifically handles right indent tabs, page placeholders, and invisible chars.
 * @param {string} content - The input content.
 * @returns {string} Cleaned content.
 */
function cleanSpecialCharacters(content) {
	content = content.replace(__RE_RIGHT_INDENT_TAB__, " ");
	content = content.replace(__RE_TAB__, " ");
	content = content.replace(__RE_PAGE_PLACEHOLDER__, "$1[#]");
	content = content.replace(__RE_INVISIBLES__, "");
	content = content.replace(__RE_MULTI_SPACE__, " ");
	return content;
}

/**
 * Extracts paragraph content, resolving cross-references where present.
 * Falls back to raw contents on errors.
 * @param {Object} para - InDesign paragraph object.
 * @returns {string} Resolved content.
 */
function getContentWithResolvedCrossRefs(para) {
	var content = "";
	try {
		if (para.texts && para.texts.length > 0) {
			for (var t = 0; t < para.texts.length; t++) {
				try {
					var ti = para.texts[t];
					if (ti.crossReferenceSources && ti.crossReferenceSources.length > 0) {
						var x = ti.crossReferenceSources[0];
						content += (x.resultText || "[unresolved]");
					} else {
						content += ti.contents;
					}
				} catch (ei) {
					try {
						content += para.texts[t].contents;
					} catch (ei2) {}
				}
			}
		} else {
			content = para.contents;
		}
	} catch (e) {
		content = para.contents;
	}
	return content;
}

// -----------------------
// List Detection and Classification Functions
// -----------------------
/**
 * Determines if a marker is a bullet (non-numeric, non-alphabetic list symbol).
 * Digit ("1."), alphabetic ("a)", "B.") and roman ("iv.") markers are ordered
 * markers and must be passed through literally, not collapsed to "- ".
 * @param {string} marker - The list marker text.
 * @returns {boolean} True if bullet marker.
 */
function isBulletMarker(marker) {
	if (/^[•·‣⁃◦▪▫]/.test(marker)) return true;
	if (/^\d/.test(marker)) return false;
	if (/^[A-Za-z]{1,4}[.)]/.test(marker)) return false;
	return true;
}

// One pass over the snapshot; -1 marks "not a list item" so findMinListIndent can
// ignore it. isStructuralListItem already treats a bullet/numbering marker as a list,
// so listIndents[i] !== -1 doubles as the per-paragraph "is a list item" answer in
// the build loops (avoids re-running the heuristic per paragraph).
function precomputeListIndents(snap) {
	var indents = [];
	for (var i = 0; i < snap.length; i++) {
		indents.push(isStructuralListItem(snap, i) ? (snap.leftIndents[i] || 0) : -1);
	}
	return indents;
}

/**
 * Finds the minimum left indent in nearby list items to establish list baseline.
 * Scans 5 paras before/after for context.
 * @param {Array} listIndents - Precomputed indent array (-1 for non-list items).
 * @param {number} startIndex - Paragraph index to start from.
 * @returns {number} Minimum indent or 0.
 */
function findMinListIndent(listIndents, startIndex) {
	var min = 999999;
	var lo = Math.max(0, startIndex - 5);
	var hi = Math.min(listIndents.length, startIndex + 6);
	for (var i = lo; i < hi; i++) {
		var v = listIndents[i];
		if (v !== -1 && v < min) min = v;
	}
	return min === 999999 ? 0 : min;
}

/**
 * Infers the indent step (points per nesting level) from the distinct list
 * indents actually used in the story: smallest gap between adjacent distinct
 * indents, ignoring sub-6pt jitter. Falls back to 20pt when there's only one
 * indent value to look at.
 * @param {Array} listIndents - Precomputed indent array (-1 for non-list items).
 * @returns {number} Indent step in points.
 */
function computeListIndentStep(listIndents) {
	var seen = {}, distinct = [];
	for (var i = 0; i < listIndents.length; i++) {
		var v = listIndents[i];
		if (v < 0) continue;
		var key = Math.round(v * 10) / 10;
		if (!seen[key]) { seen[key] = true; distinct.push(key); }
	}
	if (distinct.length < 2) return 20;
	distinct.sort(function(a, b) { return a - b; });
	var step = 0;
	for (var j = 1; j < distinct.length; j++) {
		var gap = distinct[j] - distinct[j - 1];
		if (gap >= 6 && (step === 0 || gap < step)) step = gap;
	}
	return step > 0 ? step : 20;
}

/**
 * Calculates nesting level for lists based on relative indent.
 * @param {number} leftIndent - Paragraph left indent in points.
 * @param {number} minIndent - Baseline indent.
 * @param {number} step - Points per nesting level (from computeListIndentStep).
 * @returns {number} Nesting level.
 */
function getListNestingLevel(leftIndent, minIndent, step) {
	if (!step || step <= 0) step = 20;
	var rel = leftIndent - minIndent;
	if (rel <= 0) return 0;
	return Math.floor(rel / step);
}

/**
 * Detects if a paragraph is part of a structural list (hanging indent, marker, context).
 * Operates entirely on snapshot arrays -- no DOM access -- so it's cheap to call
 * repeatedly. Uses raw paragraph contents length for the short-line heuristic;
 * resolving cross-references here just to measure length would be wasteful.
 * @param {Object} snap - Story snapshot from getStoryParaSnapshot.
 * @param {number} i - Paragraph index.
 * @returns {boolean}
 */
function isStructuralListItem(snap, i) {
	var leftIndent = snap.leftIndents[i] || 0;
	var firstLineIndent = snap.firstLineIndents[i] || 0;
	var hasHangingIndent = leftIndent > 0 && firstLineIndent < 0;
	var hasListMarker = (snap.bullets[i] || "").length > 0;
	if (hasHangingIndent || hasListMarker) return true;
	if (leftIndent <= 0) return false;
	var rawLen = (snap.contents[i] || "").length;
	if (rawLen === 0 || rawLen >= 200) return false;
	if (i > 0) {
		var prevLi = snap.leftIndents[i - 1] || 0;
		if (prevLi > 0 && Math.abs(prevLi - leftIndent) < 5) return true;
	}
	if (i < snap.length - 1) {
		var nextLi = snap.leftIndents[i + 1] || 0;
		if (nextLi > 0 && Math.abs(nextLi - leftIndent) < 5) return true;
	}
	return false;
}

/**
 * Tries to classify a style by its name alone. Returns null on no match.
 * Recognises digit-suffixed heading names (H1, Heading 2, Header3, Title 4...),
 * name-only cues (Title/Chapter → H1, Subtitle/Subhead/Section → H2),
 * and bullet/numbered hints. Name-only cues are suppressed when the name also
 * contains a non-heading word ("Title Page Credits", "Section Divider Rule").
 * @param {string} rawName - Style name.
 * @returns {Object|null}
 */
function classifyStyleName(rawName) {
	var n = trim((rawName || "").toLowerCase());
	if (!n) return null;
	var m = n.match(/(h|head|heading|header|title|banner)[^\d]*(\d+)/);
	if (m) {
		var level = parseInt(m[2], 10);
		if (level >= 1 && level <= 6) return { type: "heading", level: level };
	}
	var notHeading = /\b(body|caption|footer|footnote|credit|credits|rule|divider|page|folio)\b/.test(n);
	if (!notHeading) {
		if (/\bchapter\b/.test(n)) return { type: "heading", level: 1 };
		if (/\bsubtitle\b/.test(n) || /\bsubhead(ing)?\b/.test(n) || /\bsection\b/.test(n)) return { type: "heading", level: 2 };
		if (/\btitle\b/.test(n)) return { type: "heading", level: 1 };
	}
	if (n.indexOf("bullet") > -1 || /^b\d+/.test(n)) return { type: "bullet" };
	if (n.indexOf("number") > -1 || n.indexOf("num") > -1 || /^n\d+/.test(n)) return { type: "numbered" };
	return null;
}

/**
 * Walks the basedOn chain of a paragraph style and returns the first classification hit.
 * Lets house styles inherit semantics from their parent ("Body Lead" based on "Heading 2 Custom").
 * Cycle-safe via visited set.
 * @param {Object} style - InDesign paragraph style.
 * @returns {Object|null}
 */
function classifyStyleChain(style) {
	var visited = {};
	var s = style;
	while (s) {
		var sid;
		try { sid = "" + s.id; } catch(eId) { break; }
		if (visited[sid]) break;
		visited[sid] = true;
		var hit = classifyStyleName(s.name);
		if (hit) return hit;
		var parent = null;
		try { parent = s.basedOn; } catch(eB) { break; }
		if (!parent || parent === s) break;
		try { if (parent.name === "[No Paragraph Style]") break; } catch(eN) { break; }
		s = parent;
	}
	return null;
}

/**
 * Coerces a raw pointSize value (from snapshot or DOM) to a number rounded to 1 decimal.
 * Returns null when the value is mixed/missing. Caller is responsible for any style-level
 * fallback (we no longer chase that automatically -- callers that need it pass it in).
 * @param {*} raw - Raw pointSize value.
 * @returns {number|null}
 */
function roundPointSize(raw) {
	var sz = null;
	if (typeof raw === "number") sz = raw;
	else if (raw && typeof raw.length === "number" && raw.length > 0 && typeof raw[0] === "number") sz = raw[0];
	if (typeof sz !== "number" || isNaN(sz) || sz <= 0) return null;
	return Math.round(sz * 10) / 10;
}

/**
 * Builds a {size: headingLevel} map by sampling paragraph sizes from the given snapshots.
 * Body size = most common size; distinct larger sizes are ranked descending into H1..H6.
 * Returns null if there isn't enough size variation to be useful.
 * @param {Array} snapshots - Story snapshots to sample.
 * @returns {Object|null}
 */
function buildHeadingSizeMap(snapshots) {
	var counts = {};
	for (var s = 0; s < snapshots.length; s++) {
		var snap = snapshots[s];
		for (var i = 0; i < snap.length; i++) {
			if ((snap.contents[i] || "").length === 0) continue;
			var sz = roundPointSize(snap.pointSizes[i]);
			if (sz === null && snap.styles[i]) {
				try { sz = roundPointSize(snap.styles[i].pointSize); } catch (eS) {}
			}
			if (sz === null) continue;
			counts[sz] = (counts[sz] || 0) + 1;
		}
	}
	var sizes = [];
	for (var k in counts) if (counts.hasOwnProperty(k)) sizes.push({ size: parseFloat(k), count: counts[k] });
	if (sizes.length < 2) return null;
	sizes.sort(function(a, b) { return b.count - a.count; });
	var bodySize = sizes[0].size;
	var larger = [];
	for (var j = 0; j < sizes.length; j++) if (sizes[j].size > bodySize) larger.push(sizes[j].size);
	if (larger.length === 0) return null;
	larger.sort(function(a, b) { return b - a; });
	var map = {};
	for (var L = 0; L < larger.length && L < 6; L++) map[larger[L]] = L + 1;
	return map;
}

/**
 * Classifies a paragraph from the snapshot: heading (H1-H6), bullet, numbered, or body.
 * Tries the applied style's name chain (leaf + basedOn ancestors), then falls back to
 * the point-size map if one was built.
 * @param {Object} snap - Story snapshot.
 * @param {number} i - Paragraph index.
 * @returns {Object} {type: "heading|bullet|numbered|body", level?: number}
 */
function classifyParagraphStyle(snap, i) {
	var style = snap.styles[i];
	if (style) {
		var hit = classifyStyleChain(style);
		if (hit) return hit;
	}
	if (__HEADING_SIZE_LEVELS__) {
		var sz = roundPointSize(snap.pointSizes[i]);
		if (sz === null && style) {
			try { sz = roundPointSize(style.pointSize); } catch (e) {}
		}
		if (sz !== null && __HEADING_SIZE_LEVELS__[sz]) {
			return { type: "heading", level: __HEADING_SIZE_LEVELS__[sz] };
		}
	}
	return { type: "body" };
}

/**
 * Returns paragraph content for the build loops. Fast-paths to the snapshot's
 * pre-fetched `contents` array when the story has no cross-references; falls
 * back to the per-text DOM walk when it does.
 * @param {Object} snap - Story snapshot.
 * @param {number} i - Paragraph index.
 * @returns {string}
 */
function getParaContent(snap, i) {
	if (!snap.hasCrossRefs) return snap.contents[i] || "";
	return getContentWithResolvedCrossRefs(snap.objs[i]);
}

// -----------------------
// Table Handling Functions
// -----------------------
/**
 * Safely extracts and cleans text from a table cell, handling texts and contents.
 * Removes control chars, tabs, newlines, extra spaces.
 * @param {Object} cell - InDesign table cell.
 * @returns {string} Cleaned cell text.
 */
function getCellResolvedText_Safe(cell) {
	var txt = "";
	try {
		if (cell.texts && cell.texts.length > 0) {
			for (var i = 0; i < cell.texts.length; i++) {
				try {
					txt += cell.texts[i].contents;
				} catch (e0) {}
			}
		} else {
			txt = cell.contents;
		}
	} catch (e) {}
	txt = txt.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFC\uFEFF\uFFFE\uFFFF]/g, "");
	txt = txt.replace(/\t/g, " ").replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ");
	return txt.replace(/^\s+|\s+$/g, "");
}

/**
 * Converts a table to TSV format robustly, handling invalid tables, spans, non-rectangular grids.
 * Builds a grid, fills cells, expands spans with placeholders.
 * Generates meta info (id, rows, cols, location, notes).
 * @param {Object} tbl - InDesign table.
 * @returns {Object} {meta: [strings], lines: [TSV strings]}
 */
function tableToTSV_Robust(tbl) {
	if (!tbl || !tbl.isValid) {
		return {
			meta: ["TABLE id=? rows=0 cols=0", "LOCATION page= anchored=", "NOTE invalid table"],
			lines: []
		};
	}

	var rowsArr;
	try {
		rowsArr = tbl.rows.everyItem().getElements();
	} catch (eR) {
		rowsArr = [];
	}
	var cols = 0;
	try {
		cols = tbl.columns.length;
	} catch (eC) {
		cols = 0;
	}
	var totalRows = rowsArr && rowsArr.length ? rowsArr.length : 0;

	if (cols <= 0 || totalRows <= 0) {
		var meta0 = [];
		meta0.push("TABLE id=" + (tbl.id || "?") + " rows=" + totalRows + " cols=" + cols);
		var page0 = "";
		try {
			page0 = tbl.parentPage ? tbl.parentPage.name : "";
		} catch (e0) {}
		var anchored0 = false;
		try {
			anchored0 = (tbl.parent && tbl.parent.constructor && tbl.parent.constructor.name === "Character");
		} catch (e1) {}
		meta0.push("LOCATION page=" + page0 + " anchored=" + anchored0);
		meta0.push("NOTE empty or non-rectangular table");
		return { meta: meta0, lines: [] };
	}

	// Initialize empty grid. `occupied` tracks slot usage separately so a cell
	// whose text is genuinely empty still claims its slot ("" is ambiguous).
	var grid = [], occupied = [];
	for (var r = 0; r < totalRows; r++) {
		var row = [], occRow = [];
		for (var c = 0; c < cols; c++) { row.push(""); occRow.push(false); }
		grid.push(row);
		occupied.push(occRow);
	}
	var hasSpans = false;

	// Fill grid from rows and cells, handling indices and spans
	for (var r2 = 0; r2 < totalRows; r2++) {
		var rowObj = rowsArr[r2];
		if (!rowObj || !rowObj.isValid) continue;

		var cells;
		try {
			cells = rowObj.cells.everyItem().getElements();
			if (!cells || typeof cells.length === "undefined") cells = [];
		} catch (eCells) {
			cells = [];
		}

		for (var k = 0; k < cells.length; k++) {
			var cell = cells[k];
			if (!cell || !cell.isValid) continue;

			// Determine cell position (top-left)
			var top = (typeof cell.rowIndex !== "undefined") ? cell.rowIndex
				: (cell.parentRow && cell.parentRow.isValid ? cell.parentRow.index : r2);
			var left = (typeof cell.columnIndex !== "undefined") ? cell.columnIndex
				: (cell.parentColumn && cell.parentColumn.isValid ? cell.parentColumn.index : 0);

			if (top < 0 || top >= totalRows) top = r2;
			if (left < 0 || left >= cols) left = 0;

			// Find next empty slot for cell (handles overlaps)
			var rr = top, cc = left;
			while (rr < totalRows && cc < cols && occupied[rr][cc]) {
				cc++;
				if (cc >= cols) {
					rr++;
					cc = 0;
				}
			}
			if (rr >= totalRows) continue;

			grid[rr][cc] = getCellResolvedText_Safe(cell);
			occupied[rr][cc] = true;

			var rs = 1, cs = 1; try { rs = Math.max(1, cell.rowSpan); } catch(eRS) {} try { cs = Math.max(1, cell.columnSpan); } catch(eCS) {}
			if (rs > 1 || cs > 1) hasSpans = true;
		}
	}

	// Convert grid to TSV lines
	var lines = [];
	for (var r3 = 0; r3 < totalRows; r3++) {
		var line = "";
		for (var c3 = 0; c3 < cols; c3++) {
			if (c3 > 0) line += "\t";
			line += grid[r3][c3];
		}
		lines.push(line);
	}

	// Generate metadata
	var meta = [];
	meta.push("TABLE id=" + tbl.id + " rows=" + totalRows + " cols=" + cols);
	var anchored = false, pageName = "";
	try {
		anchored = (tbl.parent && tbl.parent.constructor && tbl.parent.constructor.name === "Character");
	} catch (e1) {}
	try {
		pageName = tbl.parentPage ? tbl.parentPage.name : "";
	} catch (e2) {}
	meta.push("LOCATION page=" + pageName + " anchored=" + anchored);
	if (hasSpans) meta.push("NOTE merged cells expanded with empty placeholders");

	return { meta: meta, lines: lines };
}

// -----------------------
// Markdown Table Rendering Functions
// -----------------------
/**
 * Escapes pipe characters in strings for Markdown table cells.
 * @param {string} s - Input string.
 * @returns {string} Escaped string.
 */
function mdEscapePipes(s) {
	return safeToString(s).replace(/\|/g, "\\|");
}

/**
 * Escapes a leading Markdown block marker in body/list content so prose that
 * happens to start with "#", ">", "-", "+", "*", or "1." isn't reinterpreted
 * as Markdown structure. Only the line start is touched; inline characters
 * are left alone to keep the raw file readable.
 * @param {string} s - Paragraph content.
 * @returns {string}
 */
function mdEscapeLeadingMarker(s) {
	s = safeToString(s);
	var m = s.match(/^(\s*)(\d+)([.)])(\s[\s\S]*)?$/);
	if (m) return m[1] + m[2] + "\\" + m[3] + (m[4] || "");
	m = s.match(/^(\s*)([#>])([\s\S]*)$/);
	if (m) return m[1] + "\\" + m[2] + m[3];
	m = s.match(/^(\s*)([\-+*])(\s[\s\S]*)$/);
	if (m) return m[1] + "\\" + m[2] + m[3];
	return s;
}

/**
 * Auto-detects column alignment: right for mostly numeric columns, else left.
 * Samples up to 25 values, threshold 60% numeric.
 * @param {Array} vals - Column values.
 * @returns {string} "right" or "left".
 */
function autoAlignForColumn(vals) {
	var nums = 0, total = Math.min(vals.length, 25);
	for (var i = 0; i < total; i++) {
		var v = safeTrim(vals[i]);
		if (/^[\+\-]?\$?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?%?$/.test(v)) nums++;
	}
	return nums >= Math.ceil(total * 0.6) ? "right" : "left";
}

/**
 * Converts TSV lines to a pretty Markdown table string.
 * Auto-aligns columns, detects if first row is header (if <50% numeric).
 * Uses generic headers if no real header detected.
 * @param {Array} lines - TSV lines.
 * @returns {string} Markdown table.
 */
function tsvToMarkdownTable(lines) {
	if (!lines || lines.length === 0) return "";
	var rows = [], maxCols = 0;
	for (var i = 0; i < lines.length; i++) {
		var cells = safeToString(lines[i]).split("\t");
		rows.push(cells);
		if (cells.length > maxCols) maxCols = cells.length;
	}
	// Pad rows to maxCols
	for (var r = 0; r < rows.length; r++) {
		var row = rows[r];
		while (row.length < maxCols) row.push("");
	}
	// Detect header row first so alignment sampling knows where the body starts
	var header = rows.length > 0 ? toArray(rows[0]) : [];
	var headerNumeric = 0;
	for (var c2 = 0; c2 < maxCols; c2++) {
		if (/^[\+\-]?\$?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?%?$/.test(safeTrim(header[c2]))) headerNumeric++;
	}
	var useHeader = headerNumeric < Math.ceil(maxCols * 0.5);
	// Determine alignments per column (sample body rows only)
	var aligns = [];
	var bodyStart = useHeader ? 1 : 0;
	for (var c = 0; c < maxCols; c++) {
		var sample = [];
		for (var r2 = bodyStart; r2 < Math.min(rows.length, bodyStart + 14); r2++) {
			sample.push(rows[r2][c]);
		}
		aligns.push(autoAlignForColumn(sample));
	}
	var hdr = useHeader ? header : (function(n) {
		var h = [];
		for (var i = 0; i < n; i++) h.push("Col " + (i + 1));
		return h;
	})(maxCols);
	hdr = toArray(hdr);

	// Build Markdown
	var md = "";
	var hdrCells = [];
	for (var hi = 0; hi < hdr.length; hi++) hdrCells.push(mdEscapePipes(hdr[hi]));
	md += "| " + hdrCells.join(" | ") + " |\n";
	var alineParts = [];
	for (var ai = 0; ai < aligns.length; ai++) alineParts.push(aligns[ai] === "right" ? "---:" : ":---");
	md += "| " + alineParts.join(" | ") + " |\n";
	for (var r3 = (useHeader ? 1 : 0); r3 < rows.length; r3++) {
		var body = rows[r3];
		var parts = [];
		for (var bi = 0; bi < body.length; bi++) parts.push(mdEscapePipes(body[bi]));
		md += "| " + parts.join(" | ") + " |\n";
	}
	md += "\n";
	return md;
}

/**
 * Renders a table pack as Markdown or TSV block.
 * For Markdown: pretty table. For TSV: wrapped block with optional meta.
 * @param {Object} pack - {meta, lines} from tableToTSV_Robust.
 * @param {boolean} prettyMarkdown - Use Markdown rendering.
 * @param {boolean} tableCaptions - Include table meta in TSV blocks.
 * @returns {string} Rendered block.
 */
function renderTableBlockMarkdown(pack, prettyMarkdown, tableCaptions) {
	if (!prettyMarkdown) {
		var meta = (tableCaptions && pack.meta && pack.meta.length > 0) ? (pack.meta.join("\n") + "\n") : "";
		var body = pack.lines.join("\n") + "\n";
		return "[TABLE-TSV-BEGIN]\n" + meta + body + "[TABLE-TSV-END]\n\n";
	}
	var md = "";
	md += tsvToMarkdownTable(pack.lines);
	return md;
}

/**
 * Emits tables for a story as Markdown blocks (Markdown export path).
 * Skips already emitted tables. Uses bucketed lookup for performance.
 * @param {Object} builder - {str: string} to append to.
 * @param {string} storyId - ID of the story.
 * @param {Object} tablesByStoryId - Bucketed table lookup { storyId: [rec, ...] }.
 * @param {Object} emittedTableIds - Tracked emitted IDs.
 * @param {boolean} prettyMarkdown - Use pretty rendering.
 * @param {boolean} tableCaptions - Include table captions/meta.
 * @returns {boolean} True if any tables emitted.
 */
function emitTablesForStory_MD(builder, storyId, tablesByStoryId, emittedTableIds, prettyMarkdown, tableCaptions) {
	var wrote = false;
	var list = tablesByStoryId[storyId] || [];
	for (var i = 0; i < list.length; i++) {
		var rec = list[i];
		if (emittedTableIds[rec.tableId]) continue;

		var pack = tableToTSV_Robust(rec.table);
		var mdBlock = renderTableBlockMarkdown(pack, prettyMarkdown, tableCaptions);
		if (builder.str.length > 0 && builder.str.substr(-2) !== "\n\n") builder.str += "\n";
		builder.str += mdBlock;

		emittedTableIds[rec.tableId] = true;
		wrote = true;
	}
	return wrote;
}

// -----------------------
// Frame and Story Filtering Functions
// -----------------------
/**
 * Checks if a text frame is on the pasteboard (not on a page).
 * @param {Object} textFrame - InDesign text frame.
 * @returns {boolean} True if on pasteboard.
 */
function isOnPasteboard(textFrame) {
	return textFrame.parentPage === null;
}

/**
 * Checks if a text frame meets minimum height/width requirements.
 * @param {Object} textFrame - InDesign text frame.
 * @param {number} minSize - Minimum size in points.
 * @returns {boolean} True if meets size.
 */
function meetsMinimumSize(textFrame, minSize) {
	var gb = textFrame.geometricBounds;
	return (gb[2] - gb[0] >= minSize && gb[3] - gb[1] >= minSize);
}

/**
 * Gets the word count of a story.
 * @param {Object} story - InDesign story.
 * @returns {number} Number of words.
 */
function getWordCount(story) {
	return story.words.length;
}

// -----------------------
// Story Ordering
// -----------------------
/**
 * Returns the document's stories in reading order (page order, then top-to-bottom
 * / left-to-right within a page). `doc.stories` itself returns creation order,
 * which causes exports to come out jumbled when frames weren't added in reading order.
 * Threaded stories appear at the position of their first frame. Any stories not
 * reachable from a page (pasteboard, etc.) are appended at the end so nothing is lost.
 * @param {Object} doc - InDesign document.
 * @returns {Array} Stories in reading order.
 */
function collectStoriesInReadingOrder(doc) {
	var seen = {};
	var ordered = [];
	var pages;
	try { pages = doc.pages.everyItem().getElements(); } catch (e) { pages = []; }
	for (var p = 0; p < pages.length; p++) {
		var frames;
		try { frames = pages[p].textFrames.everyItem().getElements(); } catch (eF) { frames = []; }
		// Prefetch bounds once per frame -- reading geometricBounds inside the
		// comparator costs two DOM round-trips per comparison.
		var recs = [];
		for (var f0 = 0; f0 < frames.length; f0++) {
			var top = 0, left = 0;
			try { var gb = frames[f0].geometricBounds; top = gb[0]; left = gb[1]; } catch (eB) {}
			recs.push({ frame: frames[f0], top: top, left: left });
		}
		recs.sort(function(a, b) {
			if (Math.abs(a.top - b.top) > 2) return a.top - b.top;
			return a.left - b.left;
		});
		for (var f = 0; f < recs.length; f++) {
			try {
				var story = recs[f].frame.parentStory;
				if (!story || !story.isValid) continue;
				var id = "" + story.id;
				if (seen[id]) continue;
				seen[id] = true;
				ordered.push(story);
			} catch (eP) {}
		}
	}
	try {
		var all = doc.stories.everyItem().getElements();
		for (var i = 0; i < all.length; i++) {
			var sid = "" + all[i].id;
			if (!seen[sid]) { seen[sid] = true; ordered.push(all[i]); }
		}
	} catch (eA) {}
	return ordered;
}

// -----------------------
// Table Collection and Indexing
// -----------------------
/**
 * Collects all tables from all stories, indexes with metadata (position, page).
 * Sorts by story, offset, page, position.
 * @param {Object} doc - InDesign document.
 * @returns {Array} Sorted table records.
 */
function collectAllTables(doc) {
	var all = [];
	try {
		var stories = doc.stories.everyItem().getElements();
		for (var s = 0; s < stories.length; s++) {
			var story = stories[s];
			var tlist;
			try {
				tlist = story.tables.everyItem().getElements();
			} catch (e) {
				tlist = [];
			}
			for (var i = 0; i < tlist.length; i++) {
				var t = tlist[i];
				var idx = -1;
				try {
					idx = t.storyOffset.index;
				} catch (e1) {}
				var page = "";
				try {
					page = t.parentPage ? t.parentPage.name
						: (story.parentTextFrames && story.parentTextFrames.length ? story.parentTextFrames[0].parentPage.name : "");
				} catch (e2) {
					page = "";
				}
				var frame = null;
				try {
					frame = t.parent;
				} catch (e3) {
					frame = null;
				}
				var gb = null;
				try {
					gb = (frame && frame.isValid && frame.geometricBounds && typeof frame.geometricBounds.length !== "undefined") ? frame.geometricBounds : null;
				} catch (e4) {
					gb = null;
				}
				var topVal = 0, leftVal = 0;
				if (gb && gb.length >= 2) {
					topVal = gb[0];
					leftVal = gb[1];
				}

				all.push({
					table: t,
					tableId: "" + t.id,
					storyId: "" + story.id,
					storyOffset: idx,
					pageName: page,
					top: topVal,
					left: leftVal
				});
			}
		}
	} catch (eAll) {}
	// Sort primarily by story, then offset/page/position
	all.sort(function(a, b) {
		if (a.storyId !== b.storyId) return (a.storyId < b.storyId) ? -1 : 1;
		if (a.storyOffset >= 0 && b.storyOffset >= 0) return a.storyOffset - b.storyOffset;
		if (a.storyOffset >= 0) return -1;
		if (b.storyOffset >= 0) return 1;
		if (a.pageName !== b.pageName) return (a.pageName < b.pageName) ? -1 : 1;
		if (a.top !== b.top) return a.top - b.top;
		return a.left - b.left;
	});
	return all;
}

/**
 * Buckets a flat table index by storyId for O(1) per-story lookup.
 * @param {Array} allTables - Flat table index from collectAllTables.
 * @returns {Object} { storyId: [rec, ...] }
 */
function bucketTablesByStoryId(allTables) {
	var bucket = {};
	for (var i = 0; i < allTables.length; i++) {
		var rec = allTables[i];
		if (!bucket[rec.storyId]) bucket[rec.storyId] = [];
		bucket[rec.storyId].push(rec);
	}
	return bucket;
}

// -----------------------
// Story Content Building and Export Functions
// -----------------------
/**
 * Writes a string to a UTF-8 file (opens, writes, closes).
 * @param {Object} outputFile - InDesign File object.
 * @param {string} s - Content to write.
 */
function writeStringToFile(outputFile, s) {
	outputFile.open("w"); outputFile.encoding = "UTF-8"; outputFile.write(s); outputFile.close();
}

/**
 * Builds Markdown content for a story snapshot: paragraphs with styles, lists, headings,
 * then tables. Operates on pre-fetched arrays so the inner loop avoids the DOM entirely
 * (except for the cross-reference fast path).
 * @param {Object} snap - Story snapshot from getStoryParaSnapshot.
 * @param {boolean} preserveNumbering - Use actual markers.
 * @param {boolean} prettyMarkdown - Enable pretty tables.
 * @param {boolean} tableCaptions - Include table captions/meta.
 * @returns {string}
 */
function buildStoryAsMarkdown(snap, preserveNumbering, prettyMarkdown, tableCaptions) {
	var builder = { str: "" };

	var tablesByStoryId = __TABLES_BY_STORY_ID__ || {};
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};
	var hasAnyTables    = !!__ALL_TABLES_INDEX__ && __ALL_TABLES_INDEX__.length > 0;

	var listIndents = precomputeListIndents(snap);
	var indentStep  = computeListIndentStep(listIndents);

	for (var i = 0; i < snap.length; i++) {
		if ((snap.contents[i] || "").length === 0) continue;

		var style = classifyParagraphStyle(snap, i);
		var structural = listIndents[i] !== -1;
		var prefix = "";
		var isListForSpacing = (style.type === "bullet" || style.type === "numbered" || structural) && style.type !== "heading";

		if (style.type === "heading") {
			// Ensure a blank line before the heading; lists end with a single "\n".
			if (builder.str.length > 0 && builder.str.substr(-2) !== "\n\n") builder.str += "\n";
			prefix = repeat("#", style.level) + " ";
		} else if (structural || style.type === "bullet" || style.type === "numbered") {
			var mi = findMinListIndent(listIndents, i);
			var nesting = getListNestingLevel(snap.leftIndents[i] || 0, mi, indentStep);
			var ind = repeat("\t", nesting);
			var bullet = snap.bullets[i] || "";
			if (preserveNumbering && bullet.length > 0) {
				var marker = trim(bullet);
				prefix = ind + (isBulletMarker(marker) ? "- " : (marker + " "));
			} else if (style.type === "numbered") {
				prefix = ind + "1. ";
			} else {
				prefix = ind + "- ";
			}
		}

		var content = cleanSpecialCharacters(getParaContent(snap, i));
		if (style.type !== "heading") content = mdEscapeLeadingMarker(content);
		var line = prefix + content.replace(/\r$/, "");
		if (line.replace(__RE_TRIM__, "").length === 0) continue;

		builder.str += isListForSpacing ? (line + "\n") : (line + "\n\n");
	}

	if (hasAnyTables) emitTablesForStory_MD(builder, "" + snap.story.id, tablesByStoryId, emittedTableIds, prettyMarkdown, tableCaptions);
	builder.str = builder.str.replace(/\n+$/, "");
	return builder.str;
}

/**
 * Builds Plain Text content for a story snapshot: paragraphs with list prefixes, tables as TSV.
 * Simpler than Markdown; uses double newlines for paras, single for lists.
 * @param {Object} snap - Story snapshot.
 * @param {boolean} preserveNumbering - Use actual markers.
 * @param {boolean} tableCaptions - Include table captions/meta.
 * @returns {string}
 */
function buildStoryAsPlainText(snap, preserveNumbering, tableCaptions) {
	var builder = { str: "" };

	var tablesByStoryId = __TABLES_BY_STORY_ID__ || {};
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};
	var hasAnyTables    = !!__ALL_TABLES_INDEX__ && __ALL_TABLES_INDEX__.length > 0;

	var listIndents = precomputeListIndents(snap);

	for (var i = 0; i < snap.length; i++) {
		var content = cleanSpecialCharacters(getParaContent(snap, i));
		if (content.replace(__RE_TRIM__, "").length === 0) continue;

		var style = classifyParagraphStyle(snap, i);
		var structural = listIndents[i] !== -1;
		var bullet = snap.bullets[i] || "";
		var hasMarker = bullet.length > 0;
		var listPrefix = (preserveNumbering && hasMarker) ? bullet : "";

		var line = listPrefix + content.replace(/\r$/, "");
		var isListItem = (preserveNumbering && hasMarker)
			|| (!preserveNumbering && (style.type === "bullet" || style.type === "numbered"))
			|| structural;

		builder.str += isListItem ? (line + "\n") : (line + "\n\n");
	}

	if (hasAnyTables) emitAllTablesForStory(builder, "" + snap.story.id, tablesByStoryId, emittedTableIds, tableCaptions);
	builder.str = builder.str.replace(/\n+$/, "");
	return builder.str;
}

/**
 * Emits tables for a story as TSV blocks (Plain Text export path).
 * Uses bucketed lookup; optionally includes meta based on tableCaptions flag.
 * @param {Object} builder - {str: string} to append to.
 * @param {string} storyId - Story ID.
 * @param {Object} tablesByStoryId - Bucketed table lookup.
 * @param {Object} emittedTableIds - Tracked IDs.
 * @param {boolean} tableCaptions - Include table meta in output.
 * @returns {boolean} True if emitted.
 */
function emitAllTablesForStory(builder, storyId, tablesByStoryId, emittedTableIds, tableCaptions) {
	var wrote = false;
	var list = tablesByStoryId[storyId] || [];
	for (var i = 0; i < list.length; i++) {
		var rec = list[i];
		if (emittedTableIds[rec.tableId]) continue;
		var pack = tableToTSV_Robust(rec.table);
		var metaPart = (tableCaptions && pack.meta && pack.meta.length > 0) ? (pack.meta.join("\n") + "\n") : "";
		var payload = metaPart + pack.lines.join("\n") + "\n";
		var block = "[TABLE-TSV-BEGIN]\n" + payload + "[TABLE-TSV-END]\n\n";
		if (builder.str.length > 0 && builder.str.substr(-2) !== "\n\n") builder.str += "\n";
		builder.str += block;
		emittedTableIds[rec.tableId] = true;
		wrote = true;
	}
	return wrote;
}

// -----------------------
// Main Workflow Functions
// -----------------------
/**
 * Initializes the script: sets interaction level, checks document/stories, shows dialog.
 */
function initializeScript() {
	app.scriptPreferences.userInteractionLevel = UserInteractionLevels.interactWithAll;
	if (app.documents.length !== 0) {
		if (app.activeDocument.stories.length !== 0) {
			showExportDialog();
		} else {
			alert("The document does not contain any text. Please open a document containing text and try again.");
		}
	} else {
		alert("No documents are open. Please open a document and try again.");
	}
}

/**
 * Renders the "leftover tables" block (tables not anchored to any exported story).
 * Appends to target ({str:""}); marks emitted ids in __EMITTED_TABLE_IDS__.
 * @param {Object} target - {str: string} builder to append to.
 * @param {boolean} isMarkdown - Use Markdown formatting.
 * @param {boolean} prettyMarkdown - Use pretty Markdown tables.
 * @param {boolean} tableCaptions - Include table captions/meta.
 * @param {number} headingHash - Heading level (number of # chars) for the section heading.
 * @returns {boolean} True if any standalone tables were appended.
 */
function appendStandaloneTablesBlock(target, isMarkdown, prettyMarkdown, tableCaptions, headingHash) {
	var allTables = __ALL_TABLES_INDEX__ || [];
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};
	var remaining = [];
	for (var i = 0; i < allTables.length; i++) { var rec = allTables[i]; if (!emittedTableIds[rec.tableId]) remaining.push(rec); }
	if (remaining.length === 0) return false;

	// Story builders trim trailing newlines; make sure the block starts on its own
	// paragraph rather than butting up against the last story's text.
	if (target.str.length > 0 && target.str.substr(-2) !== "\n\n") {
		target.str += (target.str.substr(-1) === "\n") ? "\n" : "\n\n";
	}

	if (isMarkdown) target.str += repeat("#", headingHash) + " Standalone Tables\n\n";
	else target.str += "Standalone Tables\n-----------------\n\n";

	var currentPage = null;
	for (var t = 0; t < remaining.length; t++) {
		var rec2 = remaining[t];
		if (rec2.pageName !== currentPage) {
			currentPage = rec2.pageName;
			if (isMarkdown) target.str += "\n" + repeat("#", headingHash + 1) + " Page " + currentPage + "\n\n";
			else target.str += "\nPage " + currentPage + "\n\n";
		}
		var pack = tableToTSV_Robust(rec2.table);
		if (isMarkdown) {
			target.str += renderTableBlockMarkdown(pack, prettyMarkdown, tableCaptions);
		} else {
			var metaPart = (tableCaptions && pack.meta && pack.meta.length > 0) ? (pack.meta.join("\n") + "\n") : "";
			target.str += "[TABLE-TSV-BEGIN]\n" + metaPart + pack.lines.join("\n") + "\n[TABLE-TSV-END]\n\n";
		}
		emittedTableIds[rec2.tableId] = true;
	}
	return true;
}

/**
 * Run convert+export inside a single undo step, then revert it. Atomic and exception-safe.
 * @param {Object} story - InDesign story.
 * @param {number} exportFormatConst - FORMAT_RTF or FORMAT_TAGGED_TEXT constant.
 * @param {Object} outFile - File object to export to.
 * @param {boolean} preserveNumbering - Convert numbering to text before export.
 */
function exportRtfOrTaggedAtomic(story, exportFormatConst, outFile, preserveNumbering) {
	var idFmt = (exportFormatConst === FORMAT_RTF) ? ExportFormat.RTF : ExportFormat.TAGGED_TEXT;
	if (!preserveNumbering) {
		story.exportFile(idFmt, outFile);
		return;
	}
	var didMutate = false;
	try {
		app.doScript(function() {
			// Iterate in reverse: convertNumberingToText() inserts text into the
			// paragraph, which shifts indices in the live collection if walked forward.
			var paras = story.paragraphs;
			for (var p = paras.length - 1; p >= 0; p--) {
				var para = paras[p];
				if (para.bulletsAndNumberingResultText.length > 0) {
					para.convertNumberingToText();
					didMutate = true;
				}
			}
			story.exportFile(idFmt, outFile);
		}, ScriptLanguage.JAVASCRIPT, undefined, UndoModes.ENTIRE_SCRIPT, "Export Story (with numbering converted)");
	} finally {
		if (didMutate) { try { app.activeDocument.undo(); } catch(eU) {} }
	}
}

/**
 * Reveals a File or Folder in the OS file browser (Finder on Mac, Explorer on Windows).
 * On Mac, uses AppleScript "open -R" so the file is selected inside its folder.
 * Falls back to opening the parent folder if the reveal command fails.
 * @param {File|Folder} target - File or Folder to reveal.
 */
function revealInFinder(target) {
	try {
		if (File.fs === "Macintosh") {
			// fsName is already a POSIX path on modern macOS; quote it directly.
			// Escape backslashes/quotes so the path survives AppleScript string syntax.
			var posix = target.fsName.replace(/[\\"]/g, "\\$&");
			app.doScript(
				'do shell script "open -R " & quoted form of "' + posix + '"',
				ScriptLanguage.APPLESCRIPT_LANGUAGE
			);
			return;
		}
	} catch (eR) {}
	// Windows fallback (or Mac fallback): open the containing folder.
	try {
		var folder = (target instanceof File) ? target.parent : target;
		folder.execute();
	} catch (eF) {}
}

/**
 * Shows the export configuration dialog, loads/saves preferences via labels.
 * Handles format selection, options, path. Calls exportStories on OK.
 */
function showExportDialog() {
	var lastFormat = parseIntOr(app.extractLabel("exportStories.format"), FORMAT_MARKDOWN);
	if (lastFormat < FORMAT_RTF || lastFormat > FORMAT_TAGGED_TEXT) lastFormat = FORMAT_MARKDOWN;

	var lastMinWords = app.extractLabel("exportStories.minWords");
	if (lastMinWords === "") lastMinWords = "30";
	var lastMinSize = app.extractLabel("exportStories.minFrameSize");
	if (lastMinSize === "") lastMinSize = "72";
	var lastPreserve = app.extractLabel("exportStories.preserveNumbering");
	if (lastPreserve === "") lastPreserve = "1";
	var lastIncludeTables = app.extractLabel("exportStories.includeTables");
	if (lastIncludeTables === "") lastIncludeTables = "1";
	var lastTableCaptions = app.extractLabel("exportStories.tableCaptions");
	if (lastTableCaptions === "") lastTableCaptions = "1";
	var lastInferHeadings = app.extractLabel("exportStories.inferHeadings");
	if (lastInferHeadings === "") lastInferHeadings = "0";

	var lastDoc = app.extractLabel("exportStories.lastDoc");
	var lastPath = app.extractLabel("exportStories.lastPath");
	var docName = app.activeDocument.name.replace(/\.indd$/i, "");
	if (lastPath === "" || lastDoc !== docName || !new Folder(lastPath).exists) {
		lastPath = Folder.desktop.fsName;
	}

	var dialog = app.dialogs.add({ name: "Export All Stories" });
	var formatButtons, preserveCheckbox, includeTablesCheckbox, tableCaptionsCheckbox, inferHeadingsCheckbox, minWordCountField, minFrameSizeField, pathEditbox;
	with (dialog) {
		with (dialogColumns.add()) {
			with (dialogRows.add()) {
				with (dialogColumns.add()) {
					with (borderPanels.add()) {
						staticTexts.add({ staticLabel: "Export as:" });
						formatButtons = radiobuttonGroups.add();
						with (formatButtons) {
							radiobuttonControls.add({ staticLabel: "Rich Text (rtf)" });
							radiobuttonControls.add({ staticLabel: "Plain Text (txt)" });
							radiobuttonControls.add({ staticLabel: "Markdown (md)" });
							radiobuttonControls.add({ staticLabel: "InDesign Tagged Text (txt)" });
						}
						formatButtons.radiobuttonControls[lastFormat].checkedState = true;
					}
				}
				with (dialogColumns.add()) {
					var inner = dialogColumns.add();
					with (inner.dialogRows.add()) {
						with (dialogColumns.add()) {
							staticTexts.add({ staticLabel: "Export Options:" });
						}
					}
					with (inner.dialogRows.add()) {
						with (dialogColumns.add()) {
							staticTexts.add({ staticLabel: "Minimum number of words per story:", justify: "right" });
							staticTexts.add({ staticLabel: "Minimum text frame size (in points):", justify: "right" });
						}
						with (dialogColumns.add()) {
							minWordCountField = textEditboxes.add({ editContents: lastMinWords, minWidth: 50 });
							minFrameSizeField = textEditboxes.add({ editContents: lastMinSize, minWidth: 50 });
						}
					}
					with (inner.dialogRows.add()) {
						with (dialogColumns.add()) {
							preserveCheckbox = checkboxControls.add({ staticLabel: "Include list markers (Markdown/Plain Text only)", checkedState: lastPreserve === "1" });
						}
					}
					with (inner.dialogRows.add()) {
						with (dialogColumns.add()) {
							includeTablesCheckbox = checkboxControls.add({ staticLabel: "Include tables", checkedState: lastIncludeTables === "1" });
						}
					}
					with (inner.dialogRows.add()) {
						with (dialogColumns.add()) {
							tableCaptionsCheckbox = checkboxControls.add({ staticLabel: "Table captions (id, page, notes)", checkedState: lastTableCaptions === "1" });
						}
					}
					with (inner.dialogRows.add()) {
						with (dialogColumns.add()) {
							inferHeadingsCheckbox = checkboxControls.add({ staticLabel: "Infer headings from text size (Markdown only)", checkedState: lastInferHeadings === "1" });
						}
					}
				}
			}
			with (borderPanels.add()) {
				staticTexts.add({ staticLabel: "Output Folder:" });
				pathEditbox = textEditboxes.add({ editContents: lastPath, minWidth: 580 });
			}
		}
	}

	if (dialog.show()) {
		var exportFormat = formatButtons.selectedButton;
		var userPreserveChoice = preserveCheckbox.checkedState;

		var isMarkdownOrPlainText = (exportFormat === FORMAT_PLAIN_TEXT || exportFormat === FORMAT_MARKDOWN);
		var isMarkdown = (exportFormat === FORMAT_MARKDOWN);

		var includeTables = includeTablesCheckbox.checkedState;
		var tableCaptions = tableCaptionsCheckbox.checkedState;
		var userInferHeadingsChoice = inferHeadingsCheckbox.checkedState;

		var preserveNumbering = userPreserveChoice && isMarkdownOrPlainText;
		var prettyMarkdown = isMarkdown; // auto-on for Markdown
		var inferHeadings = userInferHeadingsChoice && isMarkdown;

		var minWordCount = parseIntOr(minWordCountField.editContents, 30);
		var minFrameSize = parseIntOr(minFrameSizeField.editContents, 72);
		var minWordsRaw = minWordCountField.editContents;
		var minSizeRaw = minFrameSizeField.editContents;
		var chosenPath = pathEditbox.editContents;
		dialog.destroy();

		// Validate the output folder before persisting preferences, so a bad
		// path isn't remembered and pre-filled on the next run.
		var outFolder = new Folder(chosenPath);
		if (!outFolder.exists) {
			if (!outFolder.create()) {
				alert("Error: Could not create or access the folder.\n" + outFolder.fsName);
				return;
			}
		}

		// Save preferences
		app.insertLabel("exportStories.format", exportFormat.toString());
		app.insertLabel("exportStories.preserveNumbering", userPreserveChoice ? "1" : "0");
		app.insertLabel("exportStories.includeTables", includeTables ? "1" : "0");
		app.insertLabel("exportStories.tableCaptions", tableCaptions ? "1" : "0");
		app.insertLabel("exportStories.inferHeadings", userInferHeadingsChoice ? "1" : "0");
		app.insertLabel("exportStories.minWords", minWordsRaw);
		app.insertLabel("exportStories.minFrameSize", minSizeRaw);
		app.insertLabel("exportStories.lastDoc", docName);
		app.insertLabel("exportStories.lastPath", chosenPath);

		if (app.activeDocument.stories.length !== 0) {
			exportStories(exportFormat, outFolder, minWordCount, minFrameSize, preserveNumbering, includeTables, prettyMarkdown, tableCaptions, inferHeadings);
		}
	} else {
		dialog.destroy();
	}
}

/**
 * Main export function: filters stories, collects tables, exports per format/options.
 * Handles single-file mode, standalone tables, atomic undo for RTF/Tagged numbering conversion.
 * @param {number} exportFormat - Export format constant (FORMAT_*).
 * @param {Object} targetFolder - Output folder.
 * @param {number} minWordCount - Min words filter.
 * @param {number} minFrameSize - Min frame size filter.
 * @param {boolean} preserveNumbering - Preserve lists.
 * @param {boolean} includeTables - Export tables.
 * @param {boolean} prettyMarkdown - Pretty MD tables.
 * @param {boolean} tableCaptions - Include table captions/meta.
 * @param {boolean} inferHeadings - Build a point-size heading map (Markdown only).
 */
function exportStories(exportFormat, targetFolder, minWordCount, minFrameSize, preserveNumbering, includeTables, prettyMarkdown, tableCaptions, inferHeadings) {
	var exportedCount = 0, skippedCount = 0, failedCount = 0;
	var isMarkdown  = (exportFormat === FORMAT_MARKDOWN);
	var isPlainText = (exportFormat === FORMAT_PLAIN_TEXT);

	// Show a progress palette so InDesign doesn't appear frozen.
	// win.update() also gives the OS enough event-loop time to animate the cursor.
	var progWin = null, progStatus = null, progBar = null;
	try {
		progWin   = new Window("palette", "Exporting Stories…", undefined, {closeButton: false});
		progWin.spacing = 8; progWin.margins = [12, 12, 12, 12];
		progStatus = progWin.add("statictext", undefined, "Preparing…");
		progStatus.preferredSize.width = 340;
		progBar    = progWin.add("progressbar", [0, 0, 340, 12], 0, 100);
		progWin.layout.layout(true);
		progWin.show();
		progWin.update();
	} catch (eWin) { progWin = null; }

	function setProgress(msg, pct) {
		if (!progWin) return;
		try { progStatus.text = msg; progBar.value = Math.min(100, Math.max(0, pct | 0)); progWin.update(); } catch (eP) {}
	}

	// Suppress screen redraws during DOM-heavy work; restore unconditionally on exit.
	var prevRedraw = false;
	try { prevRedraw = app.scriptPreferences.enableRedraw; app.scriptPreferences.enableRedraw = false; } catch (eRD) {}

	var revealTarget = targetFolder; // overwritten to the single output File for MD/PT
	try {

	if (includeTables) {
		setProgress("Collecting tables…", 2);
		__ALL_TABLES_INDEX__   = collectAllTables(app.activeDocument);
		__TABLES_BY_STORY_ID__ = bucketTablesByStoryId(__ALL_TABLES_INDEX__);
		__EMITTED_TABLE_IDS__  = {};
	} else {
		__ALL_TABLES_INDEX__   = [];
		__TABLES_BY_STORY_ID__ = {};
		__EMITTED_TABLE_IDS__  = {};
	}

	setProgress("Ordering stories…", 5);
	// Walk stories in reading order (doc.stories returns creation order, which jumbles output).
	var orderedStories = collectStoriesInReadingOrder(app.activeDocument);
	var nOrdered = orderedStories.length;

	var docName = sanitizeFilename(app.activeDocument.name.replace(/\.indd$/i, ""), "Document");

	if (isMarkdown || isPlainText) {
		// Combined filter + snapshot pass for MD / Plain Text.
		// Building the snapshot here lets us count words from the already-batched
		// paragraph contents instead of calling story.words.length (which forces
		// InDesign to tokenize the entire story as a separate DOM round-trip).
		// hasTables is resolved from the pre-built __TABLES_BY_STORY_ID__ index
		// instead of story.tables.length, which is another per-story DOM call.
		var snapshots = [];
		for (var i = 0; i < nOrdered; i++) {
			var story = orderedStories[i];
			setProgress("Scanning " + (i + 1) + " of " + nOrdered + " stories…", 5 + Math.round(i / nOrdered * 40));

			if (story.storyType == StoryTypes.TOC_STORY) { skippedCount++; continue; }

			// hasTables from the pre-built index -- no DOM call needed.
			var storyIdStr = "" + story.id;
			var hasTables = includeTables && !!(__TABLES_BY_STORY_ID__[storyIdStr] && __TABLES_BY_STORY_ID__[storyIdStr].length > 0);

			var shouldExport = false;
			var containers = story.textContainers;
			var nContainers = containers.length;
			for (var j = 0; j < nContainers; j++) {
				// try/catch per container: textContainers can include TextPath objects,
				// which have no geometricBounds -- treat those as not qualifying.
				try {
					var tf = containers[j];
					if (!isOnPasteboard(tf) && meetsMinimumSize(tf, minFrameSize)) {
						shouldExport = true; break;
					}
				} catch (eTC) {}
			}
			if (!shouldExport) { skippedCount++; continue; }

			var snap = null;
			try { snap = getStoryParaSnapshot(story); } catch (eSnap) {}
			if (!snap) { failedCount++; continue; }

			// Count words from the batched snapshot contents -- avoids story.words.length.
			// Split on any whitespace so tabs (common in InDesign content) count as word breaks.
			var wordCount = 0;
			for (var w = 0; w < snap.length; w++) {
				var wc = trim(snap.contents[w] || "");
				if (wc.length > 0) wordCount += wc.split(/\s+/).length;
			}
			if (wordCount < minWordCount && !hasTables) { skippedCount++; continue; }

			snapshots.push(snap);
		}

		setProgress("Analysing heading sizes…", 46);
		__HEADING_SIZE_LEVELS__ = inferHeadings ? buildHeadingSizeMap(snapshots) : null;

		var bigBuilder = { str: "" };
		var nSnaps = snapshots.length;
		for (var s = 0; s < nSnaps; s++) {
			var snap = snapshots[s];
			setProgress("Building story " + (s + 1) + " of " + nSnaps + "…", 47 + Math.round(s / nSnaps * 46));
			try {
				// Build first, append after: if the build throws, the file shouldn't
				// be left with a dangling story separator.
				var piece = isMarkdown
					? buildStoryAsMarkdown(snap, preserveNumbering, prettyMarkdown, tableCaptions)
					: buildStoryAsPlainText(snap, preserveNumbering, tableCaptions);
				if (bigBuilder.str.length > 0) bigBuilder.str += "\n\n--------\n\n";
				bigBuilder.str += piece;
				exportedCount++;
			} catch (eS) { failedCount++; }
		}

		if (includeTables) appendStandaloneTablesBlock(bigBuilder, isMarkdown, prettyMarkdown, tableCaptions, 2);

		setProgress("Writing file…", 95);
		var ext = isMarkdown ? ".md" : ".txt";
		// Build paths from fsName: stringifying the Folder yields its URI form, and the
		// File constructor URI-decodes it, mangling names containing "%" or "#".
		var out = new File(targetFolder.fsName + "/" + docName + "_all_stories" + ext);
		var c = 1; while (out.exists) { out = new File(targetFolder.fsName + "/" + docName + "_all_stories_" + c + ext); c++; }
		writeStringToFile(out, bigBuilder.str.replace(/\n+$/, "") + "\n");
		revealTarget = out;

	} else {
		// RTF / Tagged Text: per-story export (InDesign's exportFile is the only way
		// to preserve native styling, and it writes one story per file).
		__HEADING_SIZE_LEVELS__ = null;

		// Filter pass for RTF / Tagged Text.
		// story.words.length is kept here since exportFile costs far more than word-counting.
		var storiesToProcess = [];
		for (var i = 0; i < nOrdered; i++) {
			var story = orderedStories[i];
			if (story.storyType == StoryTypes.TOC_STORY) { skippedCount++; continue; }

			var storyIdStr = "" + story.id;
			var hasTables = includeTables && !!(__TABLES_BY_STORY_ID__[storyIdStr] && __TABLES_BY_STORY_ID__[storyIdStr].length > 0);

			var shouldExport = false;
			var containers = story.textContainers;
			var nContainers = containers.length;
			for (var j = 0; j < nContainers; j++) {
				// try/catch per container: textContainers can include TextPath objects,
				// which have no geometricBounds -- treat those as not qualifying.
				try {
					var tf = containers[j];
					if (!isOnPasteboard(tf) && meetsMinimumSize(tf, minFrameSize)) {
						shouldExport = true; break;
					}
				} catch (eTC) {}
			}
			if (!shouldExport) { skippedCount++; continue; }

			if (getWordCount(story) < minWordCount && !hasTables) { skippedCount++; continue; }

			storiesToProcess.push(story);
		}

		var nProcess = storiesToProcess.length;
		for (var idx = 0; idx < nProcess; idx++) {
			var story2 = storiesToProcess[idx];
			setProgress("Exporting story " + (idx + 1) + " of " + nProcess + "…", 10 + Math.round(idx / nProcess * 85));
			try {
				// Derive a filename from the first few words. Grab a single leading
				// character range in one DOM call instead of one call per word.
				var rawName = "";
				try {
					var charCount = story2.characters.length;
					if (charCount > 0) {
						var head = story2.characters.itemByRange(0, Math.min(charCount, 80) - 1).contents;
						var wordsArr = trim(safeToString(head).replace(/\s+/g, " ")).split(" ");
						rawName = wordsArr.slice(0, 5).join(" ");
					}
				} catch (eNm) { rawName = ""; }
				var fileName = sanitizeFilename(rawName, "Story_" + story2.id);

				var extension = (exportFormat === FORMAT_RTF) ? ".rtf" : ".txt";
				var outFile = new File(targetFolder.fsName + "/" + fileName + extension);
				var counter = 1; while (outFile.exists) { outFile = new File(targetFolder.fsName + "/" + fileName + "_" + counter + extension); counter++; }

				exportRtfOrTaggedAtomic(story2, exportFormat, outFile, preserveNumbering);
				exportedCount++;
			} catch (eStory) { failedCount++; }
		}
	}

	setProgress("Done.", 100);

	} finally {
		try { app.scriptPreferences.enableRedraw = prevRedraw; } catch (eRD) {}
		try { if (progWin) { progWin.hide(); progWin.close(); } } catch (eWC) {}
	}

	if (exportedCount === 0 || failedCount > 0) {
		var msg = exportedCount === 0
			? "Export produced no output.\n\nSkipped: " + skippedCount + " (TOC, too short, on pasteboard, or below minimum size)"
				+ (failedCount > 0 ? "\nFailed: " + failedCount : "")
				+ "\n\nTry lowering the Minimum words or Minimum frame size filters."
			: "Export completed with " + failedCount + " failed " + (failedCount === 1 ? "story" : "stories") + ".\n\nExported: " + exportedCount + "\nSkipped: " + skippedCount + "\nFailed: " + failedCount + "\n\nFiles saved to:\n" + targetFolder.fsName;
		alert(msg);
	} else {
		revealInFinder(revealTarget);
	}
}

// Entry point
initializeScript();

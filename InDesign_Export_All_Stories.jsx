/*
ExportAllStories.jsx

An InDesign JavaScript to export all stories.
Copyright © 2009 Adobe Systems Incorporated.
https://console.adobe.io/downloads/id
Revision: Architectural Research Consultants, Incorporated under Adobe SDK License + MIT.

Date: 2025-09-30
Revised: 2025-11-11

Update of Adobe's default script called "ExportAllStories.jsx".
Exports all stories in an InDesign document in a specified text format.
Ignores small text frames, items on pasteboard, and very short text snippets.

This script provides options to export stories as RTF, Plain Text, Markdown, or InDesign Tagged Text.
It includes advanced features like preserving list numbering, handling tables as TSV or Markdown tables,
filtering stories by word count and frame size, and options for single-file export.

Key Features:
- Dialog for user configuration (format, filters, options).
- Automatic detection and export of tables within stories.
- Support for cross-references resolution in content.
- Classification of paragraphs for better Markdown rendering (headings, lists).
- Standalone table export for tables not tied to exported stories.
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

// -----------------------
// Utility Functions
// -----------------------
/**
 * Trims leading and trailing whitespace from a string.
 * @param {string} str - The input string.
 * @returns {string} Trimmed string.
 */
function trim(str) {
	return str.replace(/^\s+|\s+$/g, "");
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
	var s = safeToString(x);
	if (typeof s.trim === "function") return s.trim();
	return s.replace(/^\s+|\s+$/g, "");
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
 * Cleans special characters from content: replaces tabs, control chars, multiple spaces.
 * Specifically handles right indent tabs, page placeholders, and invisible chars.
 * @param {string} content - The input content.
 * @returns {string} Cleaned content.
 */
function cleanSpecialCharacters(content) {
	content = content.replace(/\u0019/g, " "); // right indent tab
	content = content.replace(/\t/g, " ");     // tabs -> spaces (paragraph text only)
	content = content.replace(/(\b[Pp]age\s+)[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFC\uFEFF\uFFFE\uFFFF]/g, "$1XXX");
	content = content.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFC\uFEFF\uFFFE\uFFFF]/g, "");
	content = content.replace(/ +/g, " ");
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
						content += (x.resultText || "XXX");
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
 * Determines if a marker is a bullet (non-numeric list symbol).
 * @param {string} marker - The list marker text.
 * @returns {boolean} True if bullet marker.
 */
function isBulletMarker(marker) {
	if (/^[•·‣⁃◦▪▫]/.test(marker)) return true;
	if (!/^\d/.test(marker)) return true;
	return false;
}

// One pass over the story; -1 marks "not a list item" so findMinListIndent can ignore it.
function precomputeListIndents(story) {
	var paras = story.paragraphs;
	var n = paras.length;
	var indents = [];
	for (var i = 0; i < n; i++) {
		var para = paras[i];
		var prev = i > 0 ? paras[i - 1] : null;
		var next = i < n - 1 ? paras[i + 1] : null;
		var isList = false;
		try { isList = isStructuralListItem(para, prev, next) || para.bulletsAndNumberingResultText.length > 0; } catch(e) {}
		if (isList) {
			var li = 0; try { li = para.leftIndent; } catch(e2) {}
			indents.push(li);
		} else indents.push(-1);
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
 * Calculates nesting level for lists based on relative indent (assuming 20pt per level).
 * @param {Object} para - InDesign paragraph.
 * @param {number} minIndent - Baseline indent.
 * @returns {number} Nesting level.
 */
function getListNestingLevel(para, minIndent) {
	var rel = para.leftIndent - minIndent;
	if (rel <= 0) return 0;
	return Math.floor(rel / 20);
}

/**
 * Detects if a paragraph is part of a structural list (hanging indent, marker, context).
 * Used for inferring lists without explicit styling.
 * @param {Object} para - Current paragraph.
 * @param {Object|null} prevPara - Previous paragraph.
 * @param {Object|null} nextPara - Next paragraph.
 * @returns {boolean} True if structural list item.
 */
function isStructuralListItem(para, prevPara, nextPara) {
	var hasHangingIndent = para.leftIndent > 0 && para.firstLineIndent < 0;
	var hasLeftIndent = para.leftIndent > 0;
	var content = trim(cleanSpecialCharacters(getContentWithResolvedCrossRefs(para)));
	var shortLine = content.length > 0 && content.length < 200;
	var hasListMarker = para.bulletsAndNumberingResultText.length > 0;
	var hasListContext = false;
	if (prevPara && prevPara.leftIndent > 0 && Math.abs(prevPara.leftIndent - para.leftIndent) < 5) hasListContext = true;
	if (nextPara && nextPara.leftIndent > 0 && Math.abs(nextPara.leftIndent - para.leftIndent) < 5) hasListContext = true;

	if (hasHangingIndent) return true;
	if (hasListMarker) return true;
	if (hasLeftIndent && shortLine && hasListContext) return true;
	return false;
}

/**
 * Classifies paragraph style: heading (H1-H6), bullet, numbered, or body.
 * Based on style name patterns.
 * @param {Object} para - InDesign paragraph.
 * @returns {Object} {type: "heading|bullet|numbered|body", level?: number}
 */
function classifyParagraphStyle(para) {
	var n = trim(para.appliedParagraphStyle.name.toLowerCase());
	var m = n.match(/(h|head|heading|header|title|banner)[^\d]*(\d+)/);
	if (m) {
		var level = parseInt(m[2], 10);
		if (level >= 1 && level <= 6) return { type: "heading", level: level };
	}
	if (n.indexOf("bullet") > -1 || /^b\d+/.test(n)) return { type: "bullet" };
	if (n.indexOf("number") > -1 || n.indexOf("num") > -1 || /^n\d+/.test(n)) return { type: "numbered" };
	return { type: "body" };
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

	// Initialize empty grid
	var grid = [];
	for (var r = 0; r < totalRows; r++) {
		var row = [];
		for (var c = 0; c < cols; c++) row.push("");
		grid.push(row);
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
			while (rr < totalRows && cc < cols && grid[rr][cc] !== "") {
				cc++;
				if (cc >= cols) {
					rr++;
					cc = 0;
				}
			}
			if (rr >= totalRows) continue;

			grid[rr][cc] = getCellResolvedText_Safe(cell);

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
	// Determine alignments per column (sample body rows)
	var aligns = [];
	for (var c = 0; c < maxCols; c++) {
		var sample = [];
		for (var r2 = 1; r2 < Math.min(rows.length, 15); r2++) {
			sample.push(rows[r2][c]);
		}
		aligns.push(autoAlignForColumn(sample));
	}
	// Detect header row
	var header = rows.length > 0 ? toArray(rows[0]) : [];
	var headerNumeric = 0;
	for (var c2 = 0; c2 < maxCols; c2++) {
		if (/^[\+\-]?\$?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?%?$/.test(safeTrim(header[c2]))) headerNumeric++;
	}
	var useHeader = headerNumeric < Math.ceil(maxCols * 0.5);
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
	return (textFrame.geometricBounds[2] - textFrame.geometricBounds[0] >= minSize &&
			textFrame.geometricBounds[3] - textFrame.geometricBounds[1] >= minSize);
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
 * Builds Markdown content for a story: paragraphs with styles, lists, headings, tables.
 * Handles spacing, prefixes, nesting. Emits tables inline, falls back to end.
 * @param {Object} story - InDesign story.
 * @param {boolean} preserveNumbering - Use actual markers.
 * @param {boolean} prettyMarkdown - Enable pretty tables.
 * @param {boolean} tableCaptions - Include table captions/meta.
 * @returns {string} Markdown content.
 */
function buildStoryAsMarkdown(story, preserveNumbering, prettyMarkdown, tableCaptions) {
	var builder = { str: "" };
	var prevWasHeading = false;

	var tablesByStoryId = __TABLES_BY_STORY_ID__ || {};
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};
	var hasAnyTables    = !!__ALL_TABLES_INDEX__ && __ALL_TABLES_INDEX__.length > 0;

	var wroteTables = hasAnyTables
		? emitTablesForStory_MD(builder, "" + story.id, tablesByStoryId, emittedTableIds, prettyMarkdown, tableCaptions)
		: false;

	var paras = story.paragraphs;
	var listIndents = precomputeListIndents(story);

	for (var i = 0; i < paras.length; i++) {
		var para = paras[i];
		if (para.contents.length === 0) continue;

		var prev = i > 0 ? paras[i - 1] : null;
		var next = i < paras.length - 1 ? paras[i + 1] : null;
		var style = classifyParagraphStyle(para);
		var structural = isStructuralListItem(para, prev, next);
		var prefix = "";
		var isListForSpacing = (style.type === "bullet" || style.type === "numbered" || structural) && style.type !== "heading";

		if (style.type === "heading") {
			if (builder.str.length > 0 && !prevWasHeading) builder.str += "\n";
			prefix = repeat("#", style.level) + " ";
			prevWasHeading = true;
		} else if (structural || style.type === "bullet" || style.type === "numbered") {
			var mi = findMinListIndent(listIndents, i);
			var nesting = getListNestingLevel(para, mi);
			var ind = repeat("\t", nesting);
			if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) {
				var marker = trim(para.bulletsAndNumberingResultText);
				prefix = ind + (isBulletMarker(marker) ? "- " : (marker + " "));
			} else if (style.type === "numbered") {
				prefix = ind + "1. ";
			} else {
				prefix = ind + "- ";
			}
			prevWasHeading = false;
		} else {
			prevWasHeading = false;
		}

		var content = cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
		var line = prefix + content.replace(/\r$/, "");
		if (line.replace(/^\s+|\s+$/g, "").length === 0) continue;

		builder.str += isListForSpacing ? (line + "\n") : (line + "\n\n");
	}

	if (hasAnyTables && !wroteTables) emitTablesForStory_MD(builder, "" + story.id, tablesByStoryId, emittedTableIds, prettyMarkdown, tableCaptions);
	return builder.str;
}

/**
 * Exports a story as Markdown to a file.
 * @param {Object} story - InDesign story.
 * @param {Object} outputFile - File object.
 * @param {boolean} preserveNumbering - Preserve markers.
 * @param {boolean} prettyMarkdown - Pretty tables.
 * @param {boolean} tableCaptions - Include table captions/meta.
 */
function exportStoryAsMarkdown(story, outputFile, preserveNumbering, prettyMarkdown, tableCaptions) {
	writeStringToFile(outputFile, buildStoryAsMarkdown(story, preserveNumbering, prettyMarkdown, tableCaptions));
}

/**
 * Builds Plain Text content for a story: paragraphs with list prefixes, tables as TSV.
 * Simpler than Markdown; uses double newlines for paras, single for lists.
 * @param {Object} story - InDesign story.
 * @param {boolean} preserveNumbering - Use actual markers.
 * @param {boolean} tableCaptions - Include table captions/meta.
 * @returns {string} Plain text content.
 */
function buildStoryAsPlainText(story, preserveNumbering, tableCaptions) {
	var builder = { str: "" };

	var tablesByStoryId = __TABLES_BY_STORY_ID__ || {};
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};
	var hasAnyTables    = !!__ALL_TABLES_INDEX__ && __ALL_TABLES_INDEX__.length > 0;

	var wroteTables = hasAnyTables
		? emitAllTablesForStory(builder, "" + story.id, tablesByStoryId, emittedTableIds, tableCaptions)
		: false;

	var paras = story.paragraphs;
	for (var i = 0; i < paras.length; i++) {
		var para = paras[i];
		var content = cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
		if (content.replace(/^\s+|\s+$/g, "").length === 0) continue;

		var prev = i > 0 ? paras[i - 1] : null;
		var next = i < paras.length - 1 ? paras[i + 1] : null;
		var style = classifyParagraphStyle(para);
		var structural = isStructuralListItem(para, prev, next);
		var listPrefix = "";

		if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) listPrefix = para.bulletsAndNumberingResultText;

		var line = listPrefix + content.replace(/\r$/, "");
		var isListItem = (preserveNumbering && para.bulletsAndNumberingResultText.length > 0)
			|| (!preserveNumbering && (style.type === "bullet" || style.type === "numbered"))
			|| structural;

		builder.str += isListItem ? (line + "\n") : (line + "\n\n");
	}

	if (hasAnyTables && !wroteTables) emitAllTablesForStory(builder, "" + story.id, tablesByStoryId, emittedTableIds, tableCaptions);
	builder.str = builder.str.replace(/\n+$/, "");
	return builder.str;
}

/**
 * Exports a story as Plain Text to a file.
 * @param {Object} story - InDesign story.
 * @param {Object} outputFile - File object.
 * @param {boolean} preserveNumbering - Preserve markers.
 * @param {boolean} tableCaptions - Include table captions/meta.
 */
function exportStoryAsPlainText(story, outputFile, preserveNumbering, tableCaptions) {
	writeStringToFile(outputFile, buildStoryAsPlainText(story, preserveNumbering, tableCaptions));
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
	if (app.documents.length != 0) {
		if (app.activeDocument.stories.length != 0) {
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
			var paras = story.paragraphs;
			for (var p = 0; p < paras.length; p++) {
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
 * Shows the export configuration dialog, loads/saves preferences via labels.
 * Handles format selection, options, path. Calls exportStories on OK.
 */
function showExportDialog() {
	var lastFormat = parseInt(app.extractLabel("exportStories.format"), 10);
	if (isNaN(lastFormat) || lastFormat < FORMAT_RTF || lastFormat > FORMAT_TAGGED_TEXT) lastFormat = FORMAT_MARKDOWN;

	var lastMinWords = app.extractLabel("exportStories.minWords");
	if (lastMinWords === "") lastMinWords = "30";
	var lastMinSize = app.extractLabel("exportStories.minFrameSize");
	if (lastMinSize === "") lastMinSize = "72";
	var lastPreserve = app.extractLabel("exportStories.preserveNumbering");
	if (lastPreserve === "") lastPreserve = "1";
	var lastSingleFile = app.extractLabel("exportStories.singleFile");
	if (lastSingleFile === "") lastSingleFile = "0";
	var lastIncludeTables = app.extractLabel("exportStories.includeTables");
	if (lastIncludeTables === "") lastIncludeTables = "1";
	var lastTableCaptions = app.extractLabel("exportStories.tableCaptions");
	if (lastTableCaptions === "") lastTableCaptions = "1";

	var lastDoc = app.extractLabel("exportStories.lastDoc");
	var lastPath = app.extractLabel("exportStories.lastPath");
	var docName = app.activeDocument.name.replace(/\.indd$/i, "");
	if (lastPath === "" || lastDoc !== docName || !new Folder(lastPath).parent.exists) {
		lastPath = Folder.desktop.fsName + "/" + docName + "_Export";
	}

	var dialog = app.dialogs.add({ name: "Export All Stories" });
	var formatButtons, preserveCheckbox, singleFileCheckbox, includeTablesCheckbox, tableCaptionsCheckbox, minWordCountField, minFrameSizeField, pathEditbox;
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
							singleFileCheckbox = checkboxControls.add({ staticLabel: "Export as single file (Markdown/Plain Text only)", checkedState: lastSingleFile === "1" });
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
		var userSingleFileChoice = singleFileCheckbox.checkedState;

		var isMarkdownOrPlainText = (exportFormat === FORMAT_PLAIN_TEXT || exportFormat === FORMAT_MARKDOWN);
		var isMarkdown = (exportFormat === FORMAT_MARKDOWN);

		var includeTables = includeTablesCheckbox.checkedState;
		var tableCaptions = tableCaptionsCheckbox.checkedState;

		// Single-file is meaningless for RTF/Tagged Text. Warn the user up front
		// rather than silently exporting per-story (or hitting the old dead alert).
		if (userSingleFileChoice && !isMarkdownOrPlainText) {
			alert("Single file export only works for Markdown or Plain Text. Exporting per-story instead.");
		}

		var preserveNumbering = userPreserveChoice && isMarkdownOrPlainText;
		var singleFile = userSingleFileChoice && isMarkdownOrPlainText;
		var prettyMarkdown = isMarkdown; // auto-on for Markdown

		var minWordCount = parseInt(minWordCountField.editContents);
		var minFrameSize = parseInt(minFrameSizeField.editContents);
		var chosenPath = pathEditbox.editContents;

		// Save preferences
		app.insertLabel("exportStories.format", exportFormat.toString());
		app.insertLabel("exportStories.preserveNumbering", userPreserveChoice ? "1" : "0");
		app.insertLabel("exportStories.singleFile", userSingleFileChoice ? "1" : "0");
		app.insertLabel("exportStories.includeTables", includeTables ? "1" : "0");
		app.insertLabel("exportStories.tableCaptions", tableCaptions ? "1" : "0");
		app.insertLabel("exportStories.minWords", minWordCountField.editContents);
		app.insertLabel("exportStories.minFrameSize", minFrameSizeField.editContents);
		app.insertLabel("exportStories.lastDoc", docName);
		app.insertLabel("exportStories.lastPath", chosenPath);
		dialog.destroy();

		var outFolder = new Folder(chosenPath);
		if (!outFolder.exists) {
			if (!outFolder.create()) {
				alert("Error: Could not create or access the folder.\n" + outFolder.fsName);
				return;
			}
		}

		if (app.activeDocument.stories.length != 0) {
			exportStories(exportFormat, outFolder, minWordCount, minFrameSize, preserveNumbering, singleFile, includeTables, prettyMarkdown, tableCaptions);
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
 * @param {boolean} singleFile - Single file mode.
 * @param {boolean} includeTables - Export tables.
 * @param {boolean} prettyMarkdown - Pretty MD tables.
 * @param {boolean} tableCaptions - Include table captions/meta.
 */
function exportStories(exportFormat, targetFolder, minWordCount, minFrameSize, preserveNumbering, singleFile, includeTables, prettyMarkdown, tableCaptions) {
	var exportedCount = 0, skippedCount = 0, failedCount = 0;
	var isMarkdown  = (exportFormat === FORMAT_MARKDOWN);
	var isPlainText = (exportFormat === FORMAT_PLAIN_TEXT);
	var storiesToProcess = [];

	if (includeTables) {
		__ALL_TABLES_INDEX__   = collectAllTables(app.activeDocument);
		__TABLES_BY_STORY_ID__ = bucketTablesByStoryId(__ALL_TABLES_INDEX__);
		__EMITTED_TABLE_IDS__  = {};
	} else {
		__ALL_TABLES_INDEX__   = [];
		__TABLES_BY_STORY_ID__ = {};
		__EMITTED_TABLE_IDS__  = {};
	}

	// Filter stories: skip TOC, pasteboard/small frames, short stories (unless tables)
	for (var i = 0; i < app.activeDocument.stories.length; i++) {
		var story = app.activeDocument.stories.item(i);
		if (story.storyType == StoryTypes.TOC_STORY) {
			continue;
		}

		var hasTables = false;
		try {
			hasTables = story.tables.length > 0;
		} catch (eHT) {
			hasTables = false;
		}

		var shouldExport = false;
		for (var j = 0; j < story.textContainers.length; j++) {
			var tf = story.textContainers[j];
			if (!isOnPasteboard(tf) && meetsMinimumSize(tf, minFrameSize)) {
				shouldExport = true;
				break;
			}
		}
		if (!shouldExport) {
			skippedCount++;
			continue;
		}

		if (getWordCount(story) < minWordCount && !(includeTables && hasTables)) {
			skippedCount++;
			continue;
		}

		storiesToProcess.push(story);
	}

	if (singleFile && (isMarkdown || isPlainText)) {
		var bigBuilder = { str: "" };
		for (var s = 0; s < storiesToProcess.length; s++) {
			var st = storiesToProcess[s];
			try {
				if (s > 0) bigBuilder.str += "\n\n--------\n\n";
				if (isMarkdown) bigBuilder.str += buildStoryAsMarkdown(st, preserveNumbering, prettyMarkdown, tableCaptions);
				else bigBuilder.str += buildStoryAsPlainText(st, preserveNumbering, tableCaptions);
				exportedCount++;
			} catch(eS) { failedCount++; }
		}

		if (includeTables) appendStandaloneTablesBlock(bigBuilder, isMarkdown, prettyMarkdown, tableCaptions, 2);

		var docName = app.activeDocument.name.replace(/\.indd$/i, "");
		var ext = isMarkdown ? ".md" : ".txt";
		var out = new File(targetFolder + "/" + docName + "_all_stories" + ext);
		var c = 1; while (out.exists) { out = new File(targetFolder + "/" + docName + "_all_stories_" + c + ext); c++; }
		writeStringToFile(out, bigBuilder.str);

	} else {
		for (var idx = 0; idx < storiesToProcess.length; idx++) {
			var story2 = storiesToProcess[idx];
			try {
				var fileName = "";
				if (story2.words.length > 0) { var wc = Math.min(5, story2.words.length); for (var w = 0; w < wc; w++) fileName += story2.words[w].contents + " "; }
				fileName = fileName.replace(/^\s+|\s+$/g, "");
				var illegal = ["/", "\\", ":", "*", "?", "\"", "<", ">", "|"]; for (var k = 0; k < illegal.length; k++) fileName = fileName.split(illegal[k]).join("");
				fileName = fileName.substring(0, 60);
				if (fileName === "") fileName = "Story_" + story2.id;

				var extension;
				if (isMarkdown) extension = ".md";
				else if (isPlainText) extension = ".txt";
				else if (exportFormat === FORMAT_RTF) extension = ".rtf";
				else extension = ".txt"; // FORMAT_TAGGED_TEXT

				var outFile = new File(targetFolder + "/" + fileName + extension);
				var counter = 1; while (outFile.exists) { outFile = new File(targetFolder + "/" + fileName + "_" + counter + extension); counter++; }

				if (isMarkdown) exportStoryAsMarkdown(story2, outFile, preserveNumbering, prettyMarkdown, tableCaptions);
				else if (isPlainText) exportStoryAsPlainText(story2, outFile, preserveNumbering, tableCaptions);
				else exportRtfOrTaggedAtomic(story2, exportFormat, outFile, preserveNumbering);

				exportedCount++;
			} catch(eStory) { failedCount++; }
		}

		if (includeTables && (isMarkdown || isPlainText) && __ALL_TABLES_INDEX__.length > 0) {
			var stBuilder = { str: "" };
			var any = appendStandaloneTablesBlock(stBuilder, isMarkdown, prettyMarkdown, tableCaptions, 1);
			if (any) {
				var docName2 = app.activeDocument.name.replace(/\.indd$/i, "");
				var ext2 = isMarkdown ? ".md" : ".txt";
				var stFile = new File(targetFolder + "/" + docName2 + "_standalone_tables" + ext2);
				var cc = 1; while (stFile.exists) { stFile = new File(targetFolder + "/" + docName2 + "_standalone_tables_" + cc + ext2); cc++; }
				writeStringToFile(stFile, stBuilder.str);
			}
		}
	}

	var msg = "Export complete!\n\n" +
		"Exported: " + exportedCount + " stories\n" +
		"Skipped: "  + skippedCount  + " stories\n";
	if (failedCount > 0) msg += "Failed: " + failedCount + " stories\n";
	msg += "\nFiles saved to:\n" + targetFolder.fsName + "\n";
	alert(msg);
}

// Entry point
initializeScript();

/*
ExportAllStories.jsx

An InDesign JavaScript to export all stories.
Author: Adobe Systems, Inc.
Revision: Architectural Research Consultants, Incorporated

Date: 2025-09-30
Revised: 2025-11-07

Update of Adobe's default script called "ExportAllStories.jsx".
Exports all stories in an InDesign document in a specified text format.
Ignores small text frames, items on pasteboard, and very short text snippets.
*/

// -----------------------
// Globals
// -----------------------
var __ALL_TABLES_INDEX__ = null;   // [{table, tableId, storyId, storyOffset, pageName, top, left}]
var __EMITTED_TABLE_IDS__ = null;  // { tableId: true }

// -----------------------
// Utilities
// -----------------------
function trim(str){ return str.replace(/^\s+|\s+$/g,""); }
function repeat(str,t){ var r=""; for (var i=0;i<t;i++) r+=str; return r; }

function safeToString(x){
	if (x === null || typeof x === "undefined") return "";
	try { return "" + x; } catch (e) { return ""; }
}
function safeTrim(x){
	var s = safeToString(x);
	if (typeof s.trim === "function") return s.trim();
	return s.replace(/^\s+|\s+$/g, "");
}
function toArray(a){
	if (!a) return [];
	if (a instanceof Array) return a;
	try { var arr=[]; for (var i=0;i<a.length;i++) arr.push(a[i]); return arr; } catch(e){ return []; }
}

function cleanSpecialCharacters(content){
	content = content.replace(/\u0019/g," "); // right indent tab
	content = content.replace(/\t/g," ");     // tabs -> spaces (paragraph text only)
	content = content.replace(/(\b[Pp]age\s+)[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFC\uFEFF\uFFFE\uFFFF]/g,"$1XXX");
	content = content.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFC\uFEFF\uFFFE\uFFFF]/g,"");
	content = content.replace(/ +/g," ");
	return content;
}

function getContentWithResolvedCrossRefs(para){
	var content="";
	try{
		if (para.texts && para.texts.length>0){
			for (var t=0;t<para.texts.length;t++){
				try{
					var ti=para.texts[t];
					if (ti.crossReferenceSources && ti.crossReferenceSources.length>0){
						var x=ti.crossReferenceSources[0];
						content += (x.resultText || "XXX");
					} else content += ti.contents;
				} catch (ei){ try{ content += para.texts[t].contents; }catch(ei2){} }
			}
		} else content = para.contents;
	} catch(e){ content = para.contents; }
	return content;
}

// -----------------------
// Lists and classification
// -----------------------
function isBulletMarker(marker){ if(/^[•·‣⁃◦▪▫]/.test(marker)) return true; if(!/^\d/.test(marker)) return true; return false; }

function findMinListIndent(story, startIndex){
	var minIndent=999999;
	for (var i=Math.max(0,startIndex-5); i<Math.min(story.paragraphs.length,startIndex+6); i++){
		var para=story.paragraphs[i];
		var prev=i>0? story.paragraphs[i-1] : null;
		var next=i<story.paragraphs.length-1? story.paragraphs[i+1] : null;
		if (isStructuralListItem(para,prev,next) || para.bulletsAndNumberingResultText.length>0){
			if (para.leftIndent < minIndent) minIndent = para.leftIndent;
		}
	}
	return minIndent===999999? 0 : minIndent;
}

function getListNestingLevel(para,minIndent){
	var rel = para.leftIndent - minIndent;
	if (rel<=0) return 0;
	return Math.floor(rel/20);
}

function isStructuralListItem(para,prevPara,nextPara){
	var hasHangingIndent = para.leftIndent>0 && para.firstLineIndent<0;
	var hasLeftIndent = para.leftIndent>0;
	var content = trim(cleanSpecialCharacters(getContentWithResolvedCrossRefs(para)));
	var shortLine = content.length>0 && content.length<200;
	var hasListMarker = para.bulletsAndNumberingResultText.length>0;
	var hasListContext=false;
	if (prevPara && prevPara.leftIndent>0 && Math.abs(prevPara.leftIndent-para.leftIndent)<5) hasListContext=true;
	if (nextPara && nextPara.leftIndent>0 && Math.abs(nextPara.leftIndent-para.leftIndent)<5) hasListContext=true;

	if (hasHangingIndent) return true;
	if (hasListMarker) return true;
	if (hasLeftIndent && shortLine && hasListContext) return true;
	return false;
}

function classifyParagraphStyle(para){
	var n = trim(para.appliedParagraphStyle.name.toLowerCase());
	var m = n.match(/(h|head|heading|header|title|banner)[^\d]*(\d+)/);
	if (m){ var level=parseInt(m[2],10); if (level>=1 && level<=6) return {type:"heading", level:level}; }
	if (n.indexOf("bullet")>-1 || /^b\d+/.test(n)) return {type:"bullet"};
	if (n.indexOf("number")>-1 || n.indexOf("num")>-1 || /^n\d+/.test(n)) return {type:"numbered"};
	return {type:"body"};
}

// -----------------------
// Table helpers
// -----------------------
function getCellResolvedText_Safe(cell){
	var txt="";
	try{
		if (cell.texts && cell.texts.length>0){
			for (var i=0;i<cell.texts.length;i++){ try{ txt += cell.texts[i].contents; }catch(e0){} }
		} else { txt = cell.contents; }
	}catch(e){}
	txt = txt.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\uFFFC\uFEFF\uFFFE\uFFFF]/g,"");
	txt = txt.replace(/\t/g," ").replace(/[\r\n]+/g," ").replace(/ {2,}/g," ");
	return txt.replace(/^\s+|\s+$/g,"");
}

function tableToTSV_Robust(tbl){
	if (!tbl || !tbl.isValid){
		return { meta:["TABLE id=? rows=0 cols=0","LOCATION page= anchored=","NOTE invalid table"], lines:[] };
	}
	var rowsArr; try{ rowsArr = tbl.rows.everyItem().getElements(); }catch(eR){ rowsArr=[]; }
	var cols=0; try{ cols=tbl.columns.length; }catch(eC){ cols=0; }
	var totalRows = rowsArr && rowsArr.length ? rowsArr.length : 0;

	if (cols<=0 || totalRows<=0){
		var meta0=[]; meta0.push("TABLE id="+(tbl.id||"?")+" rows="+totalRows+" cols="+cols);
		var page0=""; try{ page0 = tbl.parentPage ? tbl.parentPage.name : ""; }catch(e0){}
		var anchored0=false; try{ anchored0 = (tbl.parent && tbl.parent.constructor && tbl.parent.constructor.name==="Character"); }catch(e1){}
		meta0.push("LOCATION page="+page0+" anchored="+anchored0);
		meta0.push("NOTE empty or non-rectangular table");
		return { meta:meta0, lines:[] };
	}

	var grid=[]; for (var r=0;r<totalRows;r++){ var row=[]; for (var c=0;c<cols;c++) row.push(""); grid.push(row); }
	var hasSpans=false;

	for (var r2=0;r2<totalRows;r2++){
		var rowObj = rowsArr[r2];
		if (!rowObj || !rowObj.isValid) continue;

		var cells;
		try { cells = rowObj.cells.everyItem().getElements(); if (!cells || typeof cells.length==="undefined") cells = []; }
		catch(eCells){ cells = []; }

		for (var k=0;k<cells.length;k++){
			var cell = cells[k];
			if (!cell || !cell.isValid) continue;

			var top = (typeof cell.rowIndex!=="undefined") ? cell.rowIndex
					: (cell.parentRow && cell.parentRow.isValid ? cell.parentRow.index : r2);
			var left = (typeof cell.columnIndex!=="undefined") ? cell.columnIndex
					 : (cell.parentColumn && cell.parentColumn.isValid ? cell.parentColumn.index : 0);

			if (top<0 || top>=totalRows) top=r2;
			if (left<0 || left>=cols) left=0;

			var rr=top, cc=left;
			while (rr<totalRows && cc<cols && grid[rr][cc]!==""){ cc++; if (cc>=cols){ rr++; cc=0; } }
			if (rr>=totalRows) continue;

			grid[rr][cc] = getCellResolvedText_Safe(cell);

			var rs=1, cs=1; try{ rs=Math.max(1,cell.rowSpan); }catch(eRS){} try{ cs=Math.max(1,cell.columnSpan); }catch(eCS){}
			if (rs>1 || cs>1){
				hasSpans=true;
				for (var dr=0;dr<rs;dr++){
					for (var dc=0;dc<cs;dc++){
						if (dr===0 && dc===0) continue;
						var rfill=rr+dr, cfill=cc+dc;
						if (rfill>=0 && rfill<totalRows && cfill>=0 && cfill<cols){
							if (grid[rfill][cfill]==="") grid[rfill][cfill] = "";
						}
					}
				}
			}
		}
	}

	var lines=[];
	for (var r3=0;r3<totalRows;r3++){
		var line=""; for (var c3=0;c3<cols;c3++){ if (c3>0) line+="\t"; line+=grid[r3][c3]; }
		lines.push(line);
	}

	var meta=[];
	meta.push("TABLE id="+tbl.id+" rows="+totalRows+" cols="+cols);
	var anchored=false, pageName="";
	try{ anchored=(tbl.parent && tbl.parent.constructor && tbl.parent.constructor.name==="Character"); }catch(e1){}
	try{ pageName = tbl.parentPage ? tbl.parentPage.name : ""; }catch(e2){}
	meta.push("LOCATION page="+pageName+" anchored="+anchored);
	if (hasSpans) meta.push("NOTE merged cells expanded with empty placeholders");

	return { meta:meta, lines:lines };
}

// ---------- Pretty Markdown rendering ----------
function mdEscapePipes(s){ return safeToString(s).replace(/\|/g,"\\|"); }

function autoAlignForColumn(vals){
	var nums=0, total=Math.min(vals.length,25);
	for (var i=0;i<total;i++){
		var v = safeTrim(vals[i]);
		if (/^[\+\-]?\$?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?%?$/.test(v)) nums++;
	}
	return nums >= Math.ceil(total*0.6) ? "right" : "left";
}

function tsvToMarkdownTable(lines){
	if (!lines || lines.length===0) return "";
	var rows=[], maxCols=0;
	for (var i=0;i<lines.length;i++){
		var cells = safeToString(lines[i]).split("\t");
		rows.push(cells);
		if (cells.length>maxCols) maxCols=cells.length;
	}
	for (var r=0;r<rows.length;r++){
		var row=rows[r];
		while (row.length<maxCols) row.push("");
	}
	var aligns=[];
	for (var c=0;c<maxCols;c++){
		var sample=[];
		for (var r2=1; r2<Math.min(rows.length,15); r2++){ sample.push(rows[r2][c]); }
		aligns.push(autoAlignForColumn(sample));
	}
	var header = rows.length>0 ? toArray(rows[0]) : [];
	var headerNumeric=0;
	for (var c2=0;c2<maxCols;c2++){
		if (/^[\+\-]?\$?(\d{1,3}(,\d{3})*|\d+)(\.\d+)?%?$/.test(safeTrim(header[c2]))) headerNumeric++;
	}
	var useHeader = headerNumeric < Math.ceil(maxCols*0.5);
	var hdr = useHeader ? header : (function(n){ var h=[]; for (var i=0;i<n;i++) h.push("Col "+(i+1)); return h; })(maxCols);
	hdr = toArray(hdr);

	var md="";
	var hdrCells=[]; for (var hi=0; hi<hdr.length; hi++) hdrCells.push(mdEscapePipes(hdr[hi]));
	md += "| " + hdrCells.join(" | ") + " |\n";
	var alineParts=[]; for (var ai=0; ai<aligns.length; ai++) alineParts.push(aligns[ai]==="right" ? "---:" : ":---");
	md += "| " + alineParts.join(" | ") + " |\n";
	for (var r3=(useHeader?1:0); r3<rows.length; r3++){
		var body=rows[r3];
		var parts=[]; for (var bi=0; bi<body.length; bi++) parts.push(mdEscapePipes(body[bi]));
		md += "| " + parts.join(" | ") + " |\n";
	}
	md += "\n";
	return md;
}

function renderTableBlockMarkdown(pack, prettyMarkdown, tableCaptions){
	// TSV fallback: include meta only if captions are requested
	if (!prettyMarkdown){
		var body = pack.lines.join("\n") + "\n";
		if (tableCaptions && pack.meta && pack.meta.length>0){
			var meta = pack.meta.join("\n") + "\n";
			return "[TABLE-TSV-BEGIN]\n" + meta + body + "[TABLE-TSV-END]\n\n";
		}
		return "[TABLE-TSV-BEGIN]\n" + body + "[TABLE-TSV-END]\n\n";
	}
	// Pretty Markdown: optional caption line
	var caption="";
	// if (tableCaptions){
	// 	var m0=pack.meta[0]||"", m1=pack.meta[1]||"", m2=pack.meta[2]||"";
	// 	caption = m0 + " • " + m1 + (m2? (" • " + m2) : "");
	// }
	var md="";
	if (caption.length>0) md += caption + "\n\n";
	md += tsvToMarkdownTable(pack.lines);
	return md;
}

function emitTablesForStory_MD(builder, storyId, allTables, emittedTableIds, prettyMarkdown, tableCaptions){
	var wrote=false;
	for (var i=0;i<allTables.length;i++){
		var rec=allTables[i];
		if (rec.storyId !== storyId) continue;
		if (emittedTableIds[rec.tableId]) continue;

		var pack=tableToTSV_Robust(rec.table);
		var mdBlock=renderTableBlockMarkdown(pack, prettyMarkdown, tableCaptions);
		if (builder.str.length>0 && builder.str.substr(-2)!=="\n\n") builder.str+="\n";
		builder.str += mdBlock;

		emittedTableIds[rec.tableId]=true;
		wrote=true;
	}
	return wrote;
}

// -----------------------
// Frame/story filters
// -----------------------
function isOnPasteboard(textFrame){ return textFrame.parentPage===null; }
function meetsMinimumSize(textFrame, minSize){
	return (textFrame.geometricBounds[2]-textFrame.geometricBounds[0] >= minSize &&
			textFrame.geometricBounds[3]-textFrame.geometricBounds[1] >= minSize);
}
function getWordCount(story){ return story.words.length; }

// -----------------------
// Table indexing (before exportStories)
// -----------------------
function collectAllTables(doc){
	var all=[];
	try{
		var stories = doc.stories.everyItem().getElements();
		for (var s=0; s<stories.length; s++){
			var story = stories[s];
			var tlist; try{ tlist = story.tables.everyItem().getElements(); }catch(e){ tlist=[]; }
			for (var i=0;i<tlist.length;i++){
				var t = tlist[i];
				var idx=-1; try{ idx = t.storyOffset.index; }catch(e1){}
				var page = "";
				try {
					page = t.parentPage ? t.parentPage.name
						  : (story.parentTextFrames && story.parentTextFrames.length ? story.parentTextFrames[0].parentPage.name : "");
				} catch (e2){ page=""; }
				var frame=null; try{ frame = t.parent; }catch(e3){ frame=null; }
				var gb=null;
				try { gb = (frame && frame.isValid && frame.geometricBounds && typeof frame.geometricBounds.length!=="undefined") ? frame.geometricBounds : null; }
				catch (e4){ gb=null; }
				var topVal=0, leftVal=0;
				if (gb && gb.length>=2){ topVal=gb[0]; leftVal=gb[1]; }

				all.push({
					table: t,
					tableId: ""+t.id,
					storyId: ""+story.id,
					storyOffset: idx,
					pageName: page,
					top: topVal,
					left: leftVal
				});
			}
		}
	}catch(eAll){}
	all.sort(function(a,b){
		if (a.storyId!==b.storyId) return (a.storyId<b.storyId)? -1:1;
		if (a.storyOffset>=0 && b.storyOffset>=0) return a.storyOffset - b.storyOffset;
		if (a.storyOffset>=0) return -1;
		if (b.storyOffset>=0) return 1;
		if (a.pageName!==b.pageName) return (a.pageName<b.pageName)? -1:1;
		if (a.top!==b.top) return a.top - b.top;
		return a.left - b.left;
	});
	return all;
}

// -----------------------
// Exporters
// -----------------------
function exportStoryAsMarkdown(story, outputFile, preserveNumbering, prettyMarkdown, tableCaptions){
	var builder={str:""};
	var prevWasHeading=false;

	var allTables = __ALL_TABLES_INDEX__ || [];
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};

	var wroteTables = (allTables.length>0) ? emitTablesForStory_MD(builder, ""+story.id, allTables, emittedTableIds, prettyMarkdown, tableCaptions) : false;

	for (var i=0;i<story.paragraphs.length;i++){
		var para=story.paragraphs[i];
		if (para.contents.length==0) continue;

		var prev=i>0?story.paragraphs[i-1]:null;
		var next=i<story.paragraphs.length-1?story.paragraphs[i+1]:null;
		var style=classifyParagraphStyle(para);
		var structural=isStructuralListItem(para,prev,next);
		var prefix="";
		var isListForSpacing=(style.type==="bullet"||style.type==="numbered"||structural)&&style.type!=="heading";

		if (style.type==="heading"){
			if (builder.str.length>0 && !prevWasHeading) builder.str+="\n";
			prefix = repeat("#", style.level) + " ";
			prevWasHeading = true;
		} else if (structural || style.type==="bullet" || style.type==="numbered"){
			var mi=findMinListIndent(story,i);
			var nesting=getListNestingLevel(para,mi);
			var ind=repeat("\t",nesting);
			if (preserveNumbering && para.bulletsAndNumberingResultText.length>0){
				var marker=trim(para.bulletsAndNumberingResultText);
				prefix = ind + (isBulletMarker(marker)? "- " : (marker + " "));
			} else if (style.type==="numbered"){
				prefix = ind + "1. ";
			} else {
				prefix = ind + "- ";
			}
			prevWasHeading=false;
		} else {
			prevWasHeading=false;
		}

		var content=cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
		var line=prefix+content.replace(/\r$/,"");
		if (line.replace(/^\s+|\s+$/g,"").length==0) continue;

		builder.str += isListForSpacing ? (line+"\n") : (line+"\n\n");
	}

	if (allTables.length>0 && !wroteTables) emitTablesForStory_MD(builder, ""+story.id, allTables, emittedTableIds, prettyMarkdown, tableCaptions);

	outputFile.open("w"); outputFile.encoding="UTF-8"; outputFile.write(builder.str); outputFile.close();
}

function getStoryContentAsMarkdown(story, preserveNumbering, prettyMarkdown, tableCaptions){
	var builder={str:""};

	var allTables = __ALL_TABLES_INDEX__ || [];
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};

	var wroteTables = (allTables.length>0) ? emitTablesForStory_MD(builder, ""+story.id, allTables, emittedTableIds, prettyMarkdown, tableCaptions) : false;

	for (var i=0;i<story.paragraphs.length;i++){
		var para=story.paragraphs[i];
		if (para.contents.length==0) continue;

		var prev=i>0?story.paragraphs[i-1]:null;
		var next=i<story.paragraphs.length-1?story.paragraphs[i+1]:null;
		var style=classifyParagraphStyle(para);
		var structural=isStructuralListItem(para,prev,next);
		var prefix="";
		var isListForSpacing=(style.type==="bullet"||style.type==="numbered"||structural)&&style.type!=="heading";

		if (style.type==="heading"){
			if (builder.str.length>0) builder.str+="\n";
			prefix = repeat("#", style.level) + " ";
		} else if (structural || style.type==="bullet" || style.type==="numbered"){
			var mi=findMinListIndent(story,i);
			var nesting=getListNestingLevel(para,mi);
			var ind=repeat("\t",nesting);
			if (preserveNumbering && para.bulletsAndNumberingResultText.length>0){
				var marker=trim(para.bulletsAndNumberingResultText);
				prefix = ind + (isBulletMarker(marker)? "- " : (marker + " "));
			} else if (style.type==="numbered") prefix = ind + "1. ";
			else prefix = ind + "- ";
		}

		var content=cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
		var line=prefix+content.replace(/\r$/,"");
		if (line.replace(/^\s+|\s+$/g,"").length==0) continue;

		builder.str += isListForSpacing ? (line+"\n") : (line+"\n\n");
	}

	if (allTables.length>0 && !wroteTables) emitTablesForStory_MD(builder, ""+story.id, allTables, emittedTableIds, prettyMarkdown, tableCaptions);
	return builder.str;
}

function exportStoryAsPlainText(story, outputFile, preserveNumbering){
	var builder={str:""};

	var allTables = __ALL_TABLES_INDEX__ || [];
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};

	var wroteTables = (allTables.length>0) ? emitAllTablesForStory(builder, false, ""+story.id, allTables, emittedTableIds) : false;

	for (var i=0;i<story.paragraphs.length;i++){
		var para=story.paragraphs[i];
		var content=cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
		if (content.replace(/^\s+|\s+$/g,"").length==0) continue;

		var prev=i>0?story.paragraphs[i-1]:null;
		var next=i<story.paragraphs.length-1?story.paragraphs[i+1]:null;
		var style=classifyParagraphStyle(para);
		var structural=isStructuralListItem(para,prev,next);
		var listPrefix="";

		if (preserveNumbering && para.bulletsAndNumberingResultText.length>0) listPrefix=para.bulletsAndNumberingResultText;

		var line=listPrefix+content.replace(/\r$/,"");
		var isListItem=(preserveNumbering && para.bulletsAndNumberingResultText.length>0)
			|| (!preserveNumbering && (style.type==="bullet"||style.type==="numbered"))
			|| structural;

		builder.str += isListItem ? (line+"\n") : (line+"\n\n");
	}

	if (allTables.length>0 && !wroteTables) emitAllTablesForStory(builder, false, ""+story.id, allTables, emittedTableIds);
	builder.str = builder.str.replace(/\n+$/,"");

	outputFile.open("w"); outputFile.encoding="UTF-8"; outputFile.write(builder.str); outputFile.close();
}

function getStoryContentAsPlainText(story, preserveNumbering){
	var builder={str:""};

	var allTables = __ALL_TABLES_INDEX__ || [];
	var emittedTableIds = __EMITTED_TABLE_IDS__ || {};

	var wroteTables = (allTables.length>0) ? emitAllTablesForStory(builder, false, ""+story.id, allTables, emittedTableIds) : false;

	for (var i=0;i<story.paragraphs.length;i++){
		var para=story.paragraphs[i];
		var content=cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
		if (content.replace(/^\s+|\s+$/g,"").length==0) continue;

		var prev=i>0?story.paragraphs[i-1]:null;
		var next=i<story.paragraphs.length-1?story.paragraphs[i+1]:null;
		var style=classifyParagraphStyle(para);
		var structural=isStructuralListItem(para,prev,next);
		var listPrefix="";

		if (preserveNumbering && para.bulletsAndNumberingResultText.length>0) listPrefix=para.bulletsAndNumberingResultText;

		var line=listPrefix+content.replace(/\r$/,"");
		var isListItem=(preserveNumbering && para.bulletsAndNumberingResultText.length>0)
			|| (!preserveNumbering && (style.type==="bullet"||style.type==="numbered"))
			|| structural;

		builder.str += isListItem ? (line+"\n") : (line+"\n\n");
	}

	if (allTables.length>0 && !wroteTables) emitAllTablesForStory(builder, false, ""+story.id, allTables, emittedTableIds);
	builder.str = builder.str.replace(/\n+$/,"");
	return builder.str;
}

// Legacy TSV emitter for Plain Text paths
function emitAllTablesForStory(builder, isMarkdown, storyId, allTables, emittedTableIds){
	var wrote=false;
	var showMeta = (app.extractLabel("exportStories.tableCaptions")==="1");
	for (var i=0;i<allTables.length;i++){
		var rec=allTables[i];
		if (rec.storyId !== storyId) continue;
		if (emittedTableIds[rec.tableId]) continue;
		var pack=tableToTSV_Robust(rec.table);
		var metaPart = (showMeta && pack.meta && pack.meta.length>0) ? (pack.meta.join("\n")+"\n") : "";
		var payload= metaPart + pack.lines.join("\n")+"\n";
		var block="[TABLE-TSV-BEGIN]\n"+payload+"[TABLE-TSV-END]\n\n";
		if (builder.str.length>0 && builder.str.substr(-2)!=="\n\n") builder.str+="\n";
		builder.str += block;
		emittedTableIds[rec.tableId]=true;
		wrote=true;
	}
	return wrote;
}

// -----------------------
// Main workflow
// -----------------------
initializeScript();

function initializeScript(){
	app.scriptPreferences.userInteractionLevel = UserInteractionLevels.interactWithAll;
	if (app.documents.length!=0){
		if (app.activeDocument.stories.length!=0) showExportDialog();
		else alert("The document does not contain any text. Please open a document containing text and try again.");
	} else alert("No documents are open. Please open a document and try again.");
}

function showExportDialog(){
	var lastFormat=parseInt(app.extractLabel("exportStories.format"),10);
	if (isNaN(lastFormat)||lastFormat<0||lastFormat>3) lastFormat=2;

	var lastMinWords=app.extractLabel("exportStories.minWords"); if (lastMinWords==="") lastMinWords="30";
	var lastMinSize=app.extractLabel("exportStories.minFrameSize"); if (lastMinSize==="") lastMinSize="72";
	var lastPreserve=app.extractLabel("exportStories.preserveNumbering"); if (lastPreserve==="") lastPreserve="1";
	var lastSingleFile=app.extractLabel("exportStories.singleFile"); if (lastSingleFile==="") lastSingleFile="0";
	var lastIncludeTables=app.extractLabel("exportStories.includeTables"); if (lastIncludeTables==="") lastIncludeTables="1";
	var lastTableCaptions=app.extractLabel("exportStories.tableCaptions"); if (lastTableCaptions==="") lastTableCaptions="1";

	var lastDoc=app.extractLabel("exportStories.lastDoc");
	var lastPath=app.extractLabel("exportStories.lastPath");
	var docName=app.activeDocument.name.replace(/\.indd$/i,"");
	if (lastPath==="" || lastDoc!==docName || !new Folder(lastPath).parent.exists){
		lastPath = Folder.desktop.fsName + "/" + docName + "_Export";
	}

	var dialog=app.dialogs.add({ name:"Export All Stories" });
	var formatButtons,preserveCheckbox,singleFileCheckbox,includeTablesCheckbox,tableCaptionsCheckbox,minWordCountField,minFrameSizeField,pathEditbox;
	with(dialog){
		var col=dialogColumns.add();
		with(col){
			with(dialogRows.add()){
				with(dialogColumns.add()){
					with(borderPanels.add()){
						staticTexts.add({ staticLabel:"Export as:" });
						formatButtons=radiobuttonGroups.add();
						with(formatButtons){
							radiobuttonControls.add({ staticLabel:"Rich Text (rtf)" });
							radiobuttonControls.add({ staticLabel:"Plain Text (txt)" });
							radiobuttonControls.add({ staticLabel:"Markdown (md)" });
							radiobuttonControls.add({ staticLabel:"InDesign Tagged Text (txt)" });
						}
						formatButtons.radiobuttonControls[lastFormat].checkedState=true;
					}
				}
				with(dialogColumns.add()){
					var inner=dialogColumns.add();
					with(inner.dialogRows.add()){ with(dialogColumns.add()){ staticTexts.add({ staticLabel:"Export Options:" }); } }
					with(inner.dialogRows.add()){
						with(dialogColumns.add()){
							staticTexts.add({ staticLabel:"Minimum number of words per story:", justify:"right" });
							staticTexts.add({ staticLabel:"Minimum text frame size (in points):", justify:"right" });
						}
						with(dialogColumns.add()){
							minWordCountField=textEditboxes.add({ editContents:lastMinWords, minWidth:50 });
							minFrameSizeField=textEditboxes.add({ editContents:lastMinSize, minWidth:50 });
						}
					}
					with(inner.dialogRows.add()){
						with(dialogColumns.add()){
							preserveCheckbox=checkboxControls.add({ staticLabel:"Include list markers (Markdown/Plain Text only)", checkedState:lastPreserve==="1" });
						}
					}
					with(inner.dialogRows.add()){
						with(dialogColumns.add()){
							includeTablesCheckbox=checkboxControls.add({ staticLabel:"Include tables", checkedState:lastIncludeTables==="1" });
						}
					}
					with(inner.dialogRows.add()){
						with(dialogColumns.add()){
							tableCaptionsCheckbox=checkboxControls.add({ staticLabel:"Table captions (id, page, notes)", checkedState:lastTableCaptions==="1" });
						}
					}
					with(inner.dialogRows.add()){
						with(dialogColumns.add()){
							singleFileCheckbox=checkboxControls.add({ staticLabel:"Export as single file (Markdown/Plain Text only)", checkedState:lastSingleFile==="1" });
						}
					}

				}
			}
			with(borderPanels.add()){
				staticTexts.add({ staticLabel:"Output Folder:" });
				pathEditbox=textEditboxes.add({ editContents:lastPath, minWidth:580 });
			}
		}
	}

	if (dialog.show()){
		var exportFormat=formatButtons.selectedButton;
		var userPreserveChoice=preserveCheckbox.checkedState;
		var userSingleFileChoice=singleFileCheckbox.checkedState;

		var isMarkdownOrPlainText=(exportFormat==1||exportFormat==2);
		var isMarkdown = (exportFormat==2);

		var includeTables = includeTablesCheckbox.checkedState;
		var tableCaptions = tableCaptionsCheckbox.checkedState;

		var preserveNumbering=userPreserveChoice && isMarkdownOrPlainText;
		var singleFile=userSingleFileChoice && isMarkdownOrPlainText;
		var prettyMarkdown = isMarkdown; // auto-on for Markdown

		var minWordCount=parseInt(minWordCountField.editContents);
		var minFrameSize=parseInt(minFrameSizeField.editContents);
		var chosenPath=pathEditbox.editContents;

		app.insertLabel("exportStories.format", exportFormat.toString());
		app.insertLabel("exportStories.preserveNumbering", userPreserveChoice ? "1":"0");
		app.insertLabel("exportStories.singleFile", userSingleFileChoice ? "1":"0");
		app.insertLabel("exportStories.includeTables", includeTables ? "1":"0");
		app.insertLabel("exportStories.tableCaptions", tableCaptions ? "1":"0");
		app.insertLabel("exportStories.minWords", minWordCountField.editContents);
		app.insertLabel("exportStories.minFrameSize", minFrameSizeField.editContents);
		app.insertLabel("exportStories.lastDoc", docName);
		app.insertLabel("exportStories.lastPath", chosenPath);
		dialog.destroy();

		var outFolder=new Folder(chosenPath);
		if (!outFolder.exists){ if (!outFolder.create()){ alert("Error: Could not create or access the folder.\n"+outFolder.fsName); return; } }

		if (app.activeDocument.stories.length!=0){
			exportStories(exportFormat,outFolder,minWordCount,minFrameSize,preserveNumbering,singleFile,includeTables,prettyMarkdown,tableCaptions);
		}
	} else dialog.destroy();
}

function exportStories(exportFormat,targetFolder,minWordCount,minFrameSize,preserveNumbering,singleFile,includeTables,prettyMarkdown,tableCaptions){
	var exportedCount=0, skippedCount=0, tocSkippedCount=0;
	var isMarkdown=(exportFormat==2), isPlainText=(exportFormat==1);
	var singleFileContent="";
	var storiesToProcess=[];
	var exportedStoryIds={};

	if (includeTables && typeof collectAllTables === "function"){
		__ALL_TABLES_INDEX__ = collectAllTables(app.activeDocument);
		__EMITTED_TABLE_IDS__ = {};
	} else {
		__ALL_TABLES_INDEX__ = [];
		__EMITTED_TABLE_IDS__ = {};
	}
	var allTables = __ALL_TABLES_INDEX__;
	var emittedTableIds = __EMITTED_TABLE_IDS__;

	for (var i=0;i<app.activeDocument.stories.length;i++){
		var story=app.activeDocument.stories.item(i);
		if (story.storyType==StoryTypes.TOC_STORY){ tocSkippedCount++; continue; }

		var hasTables=false; try{ hasTables = story.tables.length>0; }catch(eHT){ hasTables=false; }

		var shouldExport=false;
		for (var j=0;j<story.textContainers.length;j++){
			var tf=story.textContainers[j];
			if (!isOnPasteboard(tf) && meetsMinimumSize(tf,minFrameSize)){ shouldExport=true; break; }
		}
		if (!shouldExport){ skippedCount++; continue; }

		if (getWordCount(story) < minWordCount && !(includeTables && hasTables)){ skippedCount++; continue; }

		storiesToProcess.push(story);
		exportedStoryIds[""+story.id]=true;
	}

	if (singleFile && (isMarkdown||isPlainText)){
		for (var s=0;s<storiesToProcess.length;s++){
			var story=storiesToProcess[s];
			if (s>0) singleFileContent += "\n\n--------\n\n";
			if (isMarkdown) singleFileContent += getStoryContentAsMarkdown(story, preserveNumbering, prettyMarkdown, tableCaptions);
			else singleFileContent += getStoryContentAsPlainText(story, preserveNumbering);
			exportedCount++;
		}

		if (includeTables && allTables.length>0){
			var remaining=[];
			for (var r=0;r<allTables.length;r++){ var rec=allTables[r]; if (!emittedTableIds[rec.tableId]) remaining.push(rec); }
			if (remaining.length>0){
				if (isMarkdown) singleFileContent += "\n\n## Standalone Tables\n\n";
				else singleFileContent += "\n\nStandalone Tables\n-----------------\n\n";
				var currentPage=null;
				for (var t=0;t<remaining.length;t++){
					var rec2=remaining[t];
					if (rec2.pageName!==currentPage){
						currentPage=rec2.pageName;
						if (isMarkdown) singleFileContent += "\n### Page "+currentPage+"\n\n";
						else singleFileContent += "\nPage "+currentPage+"\n\n";
					}
					var pack2=tableToTSV_Robust(rec2.table);
					if (isMarkdown){
						singleFileContent += renderTableBlockMarkdown(pack2, prettyMarkdown, tableCaptions);
					} else {
						var metaPart = (tableCaptions && pack2.meta && pack2.meta.length>0) ? (pack2.meta.join("\n")+"\n") : "";
						var payload2= metaPart + pack2.lines.join("\n")+"\n";
						singleFileContent += "[TABLE-TSV-BEGIN]\n" + payload2 + "[TABLE-TSV-END]\n\n";
					}
					emittedTableIds[rec2.tableId]=true;
				}
			}
		}

		var docName=app.activeDocument.name.replace(/\.indd$/i,"");
		var ext=isMarkdown?".md":".txt";
		var out=new File(targetFolder+"/"+docName+"_all_stories"+ext);
		var c=1; while(out.exists){ out=new File(targetFolder+"/"+docName+"_all_stories_"+c+ext); c++; }
		out.open("w"); out.encoding="UTF-8"; out.write(singleFileContent); out.close();

	} else if (singleFile){
		alert("Single file export is only supported for Markdown and Plain Text formats.");
		return;

	} else {
		for (var idx=0;idx<storiesToProcess.length;idx++){
			var story=storiesToProcess[idx];

			var numConverts=0;
			if (preserveNumbering && (exportFormat===0 || exportFormat===3)){
				for (var p=0;p<story.paragraphs.length;p++){
					var para=story.paragraphs[p];
					if (para.bulletsAndNumberingResultText.length>0){ para.convertNumberingToText(); numConverts++; }
				}
			}

			var fileName="";
			if (story.words.length>0){ var wc=Math.min(5,story.words.length); for (var w=0;w<wc;w++) fileName += story.words[w].contents+" "; }
			fileName = fileName.replace(/^\s+|\s+$/g,"");
			var illegal=["/","\\",":","*","?","\"", "<",">","|"]; for (var k=0;k<illegal.length;k++) fileName=fileName.split(illegal[k]).join("");
			fileName = fileName.substring(0,60);
			if (fileName==="") fileName = "Story_"+story.id;

			var format, extension;
			if (isMarkdown) extension=".md";
			else if (isPlainText) extension=".txt";
			else { switch (exportFormat){ case 0: format=ExportFormat.RTF; extension=".rtf"; break; case 3: format=ExportFormat.TAGGED_TEXT; extension=".txt"; break; } }

			var outFile=new File(targetFolder+"/"+fileName+extension);
			var counter=1; while(outFile.exists){ outFile=new File(targetFolder+"/"+fileName+"_"+counter+extension); counter++; }

			if (isMarkdown) exportStoryAsMarkdown(story,outFile,preserveNumbering,prettyMarkdown,tableCaptions);
			else if (isPlainText) exportStoryAsPlainText(story,outFile,preserveNumbering);
			else story.exportFile(format,outFile);

			for (var u=0;u<numConverts;u++) app.activeDocument.undo();
			exportedCount++;
		}

		if (includeTables && (isMarkdown || isPlainText) && __ALL_TABLES_INDEX__.length>0){
			var remaining2=[];
			for (var r2=0;r2<__ALL_TABLES_INDEX__.length;r2++){ var rec3=__ALL_TABLES_INDEX__[r2]; if (!__EMITTED_TABLE_IDS__[rec3.tableId]) remaining2.push(rec3); }
			if (remaining2.length>0){
				var docName2=app.activeDocument.name.replace(/\.indd$/i,"");
				var ext2=isMarkdown?".md":".txt";
				var stFile=new File(targetFolder+"/"+docName2+"_standalone_tables"+ext2);
				var cc=1; while(stFile.exists){ stFile=new File(targetFolder+"/"+docName2+"_standalone_tables_"+cc+ext2); cc++; }
				var buf="";
				if (isMarkdown) buf+="# Standalone Tables\n\n";
				else buf+="Standalone Tables\n-----------------\n\n";
				var currentPage2=null;
				for (var t2=0;t2<remaining2.length;t2++){
					var rec4=remaining2[t2];
					if (rec4.pageName!==currentPage2){
						currentPage2=rec4.pageName;
						if (isMarkdown) buf+="\n## Page "+currentPage2+"\n\n";
						else buf+="\nPage "+currentPage2+"\n\n";
					}
					var pack4=tableToTSV_Robust(rec4.table);
					if (isMarkdown){
						buf += renderTableBlockMarkdown(pack4, prettyMarkdown, tableCaptions);
					} else {
						var metaPart2 = (tableCaptions && pack4.meta && pack4.meta.length>0) ? (pack4.meta.join("\n")+"\n") : "";
						var payload4= metaPart2 + pack4.lines.join("\n")+"\n";
						buf += "[TABLE-TSV-BEGIN]\n" + payload4 + "[TABLE-TSV-END]\n\n";
					}
					__EMITTED_TABLE_IDS__[rec4.tableId]=true;
				}
				stFile.open("w"); stFile.encoding="UTF-8"; stFile.write(buf); stFile.close();
			}
		}
	}

	alert(
		"Export complete!\n\n" +
		"Exported: " + exportedCount + " stories\n" +
		"Skipped: " + skippedCount + " stories\n\n" +
		"Files saved to:\n" + targetFolder.fsName + "\n"
	);
}

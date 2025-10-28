/*

ExportAllStories.jsx

An InDesign JavaScript to export all stories.
Author: Adobe Systems, Inc.
Revision: Architectural Research Consultants, Incorporated

Date: 2025-09-30
Revised: 2025-10-28

Update of Adobe's default script called "ExportAllStories.jsx".
Exports all stories in an InDesign document in a specified text format.
Ignores small text frames, items on pasteboard, and very short text snippets.

Improvements:

- Added a classifyParagraphStyle function for more flexible and readable
  detection of paragraph styles (headings, bullets, numbered lists, body).
  Uses regex to match common patterns like "h3", "heading 3", "title1", etc.,
  without exhaustive listing of variants. Defaults to body text for unknowns.

- Refactored exportStoryAsMarkdown and exportStoryAsPlainText to use the
  new classifier, reducing duplication and improving maintainability.

- Added comments for clarity, especially around style classification logic.

- Minor tweaks for consistency (e.g., handling numbered lists simply as "1. "
  in Markdown, without full enumeration to avoid complexity).

- Fixed ExtendScript compatibility: Added manual trim function since String.prototype.trim() is not available in ES3.

- Added manual repeat function for heading levels since String.prototype.repeat() is not available in ES3.

- Updated output path logic: Now persists the last chosen path *per document* (based on document name without extension).
  If the current document's name differs from the last saved one, or no path is saved, it defaults to a folder on the desktop named after the current document.
  This balances persistence (for repeated work on the same doc) with resetting for new docs, avoiding the annoyance of carrying over paths from unrelated files.

- Added checkbox "Include list markers" to preserve bullets and numbering in exports.
  For RTF and Tagged Text: Temporarily converts to static text, exports, then undoes the conversion.
  For Markdown and Plain Text: Prepends the computed list marker (from bulletsAndNumberingResultText) to the content without modifying the document.
  Adjusts spacing and prefixes accordingly (e.g., numbered headings become "# 1. Title" in Markdown).

- Added checkbox "Export as single file" to combine all stories into one file with "--------" dividers between stories.
  Content appears in document order.

- Fixed special character handling for table of contents: Replaces right indent tabs and regular tabs with appropriate spacing to prevent unprintable characters in output.

- Added logic to skip Table of Contents stories (StoryTypes.TOC_STORY) to avoid exporting auto-generated TOC content.

- Enhanced list detection using structural analysis: Examines paragraph indents, line length, and consecutive paragraph patterns to identify list items beyond style names alone.

- Fixed Markdown bullet formatting: Always uses "-" for bullets (never bullet characters), with proper tab-based hierarchy for nested lists.

- Fixed heading formatting: Headings never get indentation or list markers, only the appropriate number of # symbols followed by a single space.

- Fixed Markdown list indentation: Calculates nesting relative to the minimum indent level in context, ensuring top-level bullets start at left margin as Markdown requires.

- Added smart spacing for headings: Inserts blank line before headings when preceded by non-heading content, but not between consecutive headings.

- Added cross-reference resolution: Resolves InDesign cross-references to their displayed values (e.g., "on page 42") instead of unprintable marker characters.

*/

function trim(str) {
  return str.replace(/^\s+|\s+$/g, "");
}

function repeat(str, times) {
  var result = "";
  for (var i = 0; i < times; i++) {
	result += str;
  }
  return result;
}

function cleanSpecialCharacters(content) {
  // Replace right indent tab (Unicode 0x0019) with space
  // This is the special tab used in InDesign ToCs between entry and page number
  content = content.replace(/\u0019/g, " ");
  
  // Replace regular tab characters with spaces
  content = content.replace(/\t/g, " ");
  
  // Replace any remaining unprintable characters with XXX as fallback
  // These might be cross-reference markers that weren't resolved
  content = content.replace(/[\u0000-\u001F\u007F-\u009F\uFEFF\uFFFC\uFFFD]/g, "XXX");
  
  // Clean up multiple consecutive spaces
  content = content.replace(/  +/g, " ");
  
  return content;
}

/**
 * Processes paragraph content to resolve cross-references to their displayed values.
 * InDesign cross-references have a resultText property that contains the resolved value.
 *
 * @param {Paragraph} para - The InDesign paragraph object.
 * @returns {string} The paragraph content with cross-references resolved.
 */
function getContentWithResolvedCrossRefs(para) {
  var content = "";
  
  try {
	// Try to access cross-reference sources in the paragraph
	var xrefs = para.crossReferenceSources;
	
	if (xrefs && xrefs.length > 0) {
	  // If there are cross-references, build content by walking through text
	  // and replacing cross-ref markers with their resultText
	  content = para.contents;
	  
	  // Process cross-references in reverse order to maintain correct positions
	  for (var i = xrefs.length - 1; i >= 0; i--) {
		var xref = xrefs[i];
		try {
		  // Get the actual displayed text of the cross-reference
		  var resolvedText = xref.resultText || "XXX";
		  
		  // Get the position of this cross-ref in the paragraph
		  var xrefStart = xref.storyOffset.index - para.storyOffset.index;
		  var xrefLength = xref.length;
		  
		  // Replace the cross-ref marker with the resolved text
		  content = content.substring(0, xrefStart) + 
				   resolvedText + 
				   content.substring(xrefStart + xrefLength);
		} catch (e) {
		  // If we can't resolve this particular cross-ref, leave it as-is
		}
	  }
	} else {
	  // No cross-references, just return normal contents
	  content = para.contents;
	}
  } catch (e) {
	// If cross-reference access fails, fall back to normal contents
	content = para.contents;
  }
  
  return content;
}

/**
 * Checks if a marker is a bullet character (not a number).
 *
 * @param {string} marker - The list marker string.
 * @returns {boolean} True if the marker is a bullet character.
 */
function isBulletMarker(marker) {
  // Check for common bullet characters
  if (/^[•·‣⁃◦▪▫]/.test(marker)) {
	return true;
  }
  // Check if it's NOT a number (numbered lists start with digits)
  if (!/^\d/.test(marker)) {
	return true;
  }
  return false;
}

/**
 * Finds the minimum left indent among list items in a consecutive sequence.
 * This is used to calculate relative nesting levels.
 *
 * @param {Story} story - The InDesign story object.
 * @param {number} startIndex - The starting paragraph index.
 * @returns {number} The minimum left indent value in points.
 */
function findMinListIndent(story, startIndex) {
  var minIndent = 999999;
  
  // Look backwards and forwards from current position to find list context
  for (var i = Math.max(0, startIndex - 5); i < Math.min(story.paragraphs.length, startIndex + 6); i++) {
	var para = story.paragraphs[i];
	var prevPara = i > 0 ? story.paragraphs[i - 1] : null;
	var nextPara = i < story.paragraphs.length - 1 ? story.paragraphs[i + 1] : null;
	
	if (isStructuralListItem(para, prevPara, nextPara) || 
		para.bulletsAndNumberingResultText.length > 0) {
	  if (para.leftIndent < minIndent) {
		minIndent = para.leftIndent;
	  }
	}
  }
  
  return minIndent === 999999 ? 0 : minIndent;
}

/**
 * Calculates the nesting level of a paragraph based on its left indent
 * RELATIVE to the minimum indent in its list context.
 * Returns the number of tabs needed for proper Markdown hierarchy.
 *
 * @param {Paragraph} para - The InDesign paragraph object.
 * @param {number} minIndent - The minimum indent of the list context.
 * @returns {number} The nesting level (0 for top level, 1+ for nested).
 */
function getListNestingLevel(para, minIndent) {
  // Calculate relative indent from the baseline
  var relativeIndent = para.leftIndent - minIndent;
  
  if (relativeIndent <= 0) {
	return 0;
  }
  
  // Each ~20 points of additional indent represents one nesting level
  return Math.floor(relativeIndent / 20);
}

/**
 * Determines if a paragraph appears to be a list item based on structural
 * characteristics rather than just style names. Looks at indentation,
 * line length, and context.
 *
 * @param {Paragraph} para - The InDesign paragraph object.
 * @param {Paragraph} prevPara - The previous paragraph (or null).
 * @param {Paragraph} nextPara - The next paragraph (or null).
 * @returns {boolean} True if the paragraph appears to be a list item.
 */
function isStructuralListItem(para, prevPara, nextPara) {
  // Check for hanging indent pattern (positive left indent + negative first line indent)
  var hasHangingIndent = para.leftIndent > 0 && para.firstLineIndent < 0;
  
  // Check for non-zero left indent (common in lists)
  var hasLeftIndent = para.leftIndent > 0;
  
  // Check if line is relatively short (less than 400 points, roughly 5-6 inches)
  var content = trim(cleanSpecialCharacters(getContentWithResolvedCrossRefs(para)));
  var isShortLine = content.length > 0 && content.length < 200; // Character count as proxy
  
  // Check if bullets/numbering is present
  var hasListMarker = para.bulletsAndNumberingResultText.length > 0;
  
  // Check context: if previous or next paragraph also has similar indentation
  var hasListContext = false;
  if (prevPara && prevPara.leftIndent > 0 && Math.abs(prevPara.leftIndent - para.leftIndent) < 5) {
	hasListContext = true;
  }
  if (nextPara && nextPara.leftIndent > 0 && Math.abs(nextPara.leftIndent - para.leftIndent) < 5) {
	hasListContext = true;
  }
  
  // A paragraph is likely a list item if it has:
  // - A hanging indent pattern, OR
  // - List markers (bullets/numbering), OR
  // - Left indent + short line + list context
  if (hasHangingIndent) {
	return true;
  }
  
  if (hasListMarker) {
	return true;
  }
  
  if (hasLeftIndent && isShortLine && hasListContext) {
	return true;
  }
  
  return false;
}

initializeScript();

function initializeScript() {
  // Make certain that user interaction (display of dialogs, etc.) is turned on.
  app.scriptPreferences.userInteractionLevel =
	UserInteractionLevels.interactWithAll;
  if (app.documents.length != 0) {
	if (app.activeDocument.stories.length != 0) {
	  showExportDialog();
	} else {
	  alert(
		"The document does not contain any text. Please open a document containing text and try again.",
	  );
	}
  } else {
	alert("No documents are open. Please open a document and try again.");
  }
}


function showExportDialog() {
  // Load preferences
  var lastFormat = parseInt(app.extractLabel("exportStories.format"), 10);
  if (isNaN(lastFormat) || lastFormat < 0 || lastFormat > 3) {
	lastFormat = 2;
  }

  var lastMinWords = app.extractLabel("exportStories.minWords");
  if (lastMinWords === "") {
	lastMinWords = "30";
  }

  var lastMinSize = app.extractLabel("exportStories.minFrameSize");
  if (lastMinSize === "") {
	lastMinSize = "72";
  }

  var lastPreserve = app.extractLabel("exportStories.preserveNumbering");
  if (lastPreserve === "") {
	lastPreserve = "1";
  }

  var lastSingleFile = app.extractLabel("exportStories.singleFile");
  if (lastSingleFile === "") {
	lastSingleFile = "0";
  }

  // Load last used path and doc name for per-document persistence, or generate a default one
  var lastDoc = app.extractLabel("exportStories.lastDoc");
  var lastPath = app.extractLabel("exportStories.lastPath");
  var docName = app.activeDocument.name.replace(/\.indd$/i, "");
  if (
	lastPath === "" ||
	lastDoc !== docName ||
	!new Folder(lastPath).parent.exists
  ) {
	// Reset to default if no path saved, doc changed, or path invalid (e.g., deleted/moved folder)
	lastPath = Folder.desktop.fsName + "/" + docName + "_Export";
  }

  var dialog = app.dialogs.add({ name: "Export All Stories" });
  var formatButtons,
	preserveCheckbox,
	singleFileCheckbox,
	minWordCountField,
	minFrameSizeField,
	pathEditbox;
  with (dialog) {
	var dialogColumn = dialogColumns.add(); // Main vertical container
	with (dialogColumn) {
	  // This row holds the two top panels side-by-side
	  with (dialogRows.add()) {
		// === COLUMN A ===
		with (dialogColumns.add()) {
		  // PANEL 1: EXPORT FORMAT
		  with (borderPanels.add()) {
			staticTexts.add({ staticLabel: "Export as:" });
			formatButtons = radiobuttonGroups.add();
			with (formatButtons) {
			  radiobuttonControls.add({ staticLabel: "Markdown (md)" });
			  radiobuttonControls.add({ staticLabel: "Plain Only (txt)" });
			  radiobuttonControls.add({ staticLabel: "Rich Text (rtf)" });
			  radiobuttonControls.add({ staticLabel: "InDesign Tagged Text (txt)" });
			}
		  }
		  formatButtons.radiobuttonControls[lastFormat].checkedState = true;
		}

		// === COLUMN B ===
		with (dialogColumns.add()) {
		  // PANEL 2: EXPORT OPTIONS
		  var innerColumn = dialogColumns.add();
		  // Header row spanning full width
		  with (innerColumn.dialogRows.add()) {
			with (dialogColumns.add()) {
			  staticTexts.add({
				staticLabel: "Export Options:",
			  });
			}
		  }
		  // Row for minimum fields
		  with (innerColumn.dialogRows.add()) {
			with (dialogColumns.add()) {
			  staticTexts.add({
				staticLabel: "Minimum number of words per story:",
				justify: "right",
			  });
			  staticTexts.add({
				staticLabel: "Minimum text frame size (in points):",
				justify: "right",
			  });
			}
			with (dialogColumns.add()) {
			  minWordCountField = textEditboxes.add({
				editContents: lastMinWords,
				minWidth: 50,
			  });
			  minFrameSizeField = textEditboxes.add({
				editContents: lastMinSize,
				minWidth: 50,
			  });
			}
		  }
		  // Row for checkboxes spanning full width
		  with (innerColumn.dialogRows.add()) {
			with (dialogColumns.add()) {
			  preserveCheckbox = checkboxControls.add({
				staticLabel: "Include list markers (Markdown/Plain Text only)",
				checkedState: lastPreserve === "1",
			  });
			}
		  }
		  with (innerColumn.dialogRows.add()) {
			with (dialogColumns.add()) {
			  singleFileCheckbox = checkboxControls.add({
				staticLabel: "Export as single file (Markdown/Plain Text only)",
				checkedState: lastSingleFile === "1",
			  });
			}
		  }
		}
	  }

	  // PANEL 3: OUTPUT FOLDER
	  with (borderPanels.add()) {
		staticTexts.add({ staticLabel: "Output Folder:" });
		pathEditbox = textEditboxes.add({
		  editContents: lastPath,
		  minWidth: 580,
		});
	  }
	}
  }

  if (dialog.show()) {
	var exportFormat = formatButtons.selectedButton;
	
	// Save the actual checkbox states (not the computed values)
	var userPreserveChoice = preserveCheckbox.checkedState;
	var userSingleFileChoice = singleFileCheckbox.checkedState;
	
	// Identify format types
	var isTaggedText = (exportFormat == 3);
	var isRTF = (exportFormat == 0);
	var isMarkdownOrPlainText = (exportFormat == 1 || exportFormat == 2);
	
	// Only apply these options for Markdown and Plain Text
	var preserveNumbering = userPreserveChoice && isMarkdownOrPlainText;
	var singleFile = userSingleFileChoice && isMarkdownOrPlainText;
	
	var minWordCount = parseInt(minWordCountField.editContents);
	var minFrameSize = parseInt(minFrameSizeField.editContents);
	var chosenPath = pathEditbox.editContents;

	// Save preferences for next time - save user's actual choices, not computed values
	app.insertLabel("exportStories.format", exportFormat.toString());
	app.insertLabel(
	  "exportStories.preserveNumbering",
	  userPreserveChoice ? "1" : "0",
	);
	app.insertLabel(
	  "exportStories.singleFile",
	  userSingleFileChoice ? "1" : "0",
	);
	app.insertLabel("exportStories.minWords", minWordCountField.editContents);
	app.insertLabel(
	  "exportStories.minFrameSize",
	  minFrameSizeField.editContents,
	);

	// Save per-document path info
	app.insertLabel("exportStories.lastDoc", docName);
	app.insertLabel("exportStories.lastPath", chosenPath);

	dialog.destroy();

	var finalTargetFolder = new Folder(chosenPath);

	// Create the folder if it doesn't exist
	if (!finalTargetFolder.exists) {
	  if (!finalTargetFolder.create()) {
		alert(
		  "Error: Could not create or access the folder at the specified path.\nPlease check the path and permissions.\n" +
			finalTargetFolder.fsName,
		);
		return;
	  }
	}

	if (app.activeDocument.stories.length != 0) {
	  exportStories(
		exportFormat,
		finalTargetFolder,
		minWordCount,
		minFrameSize,
		preserveNumbering,
		singleFile,
	  );
	}
  } else {
	dialog.destroy();
  }
}






/**
 * Classifies a paragraph's applied style into one of: 'heading' (with level 1-6),
 * 'bullet', 'numbered', or 'body'. Uses regex for flexible matching of common
 * patterns (e.g., "h3", "heading 2", "title1", "Bullet List") without exhaustive
 * variants. Defaults to 'body' for unknowns.
 *
 * @param {Paragraph} para - The InDesign paragraph object.
 * @returns {Object} Classification object, e.g., {type: 'heading', level: 3}.
 */
function classifyParagraphStyle(para) {
  var name = trim(para.appliedParagraphStyle.name.toLowerCase());

  // Heading: Match patterns like "h3", "heading 2", "header-1", "title 4", etc.
  // Captures the first digit 1-6 after a heading-related word.
  var headingMatch = name.match(
	/(h|head|heading|header|title|banner)[^\d]*(\d+)/,
  );
  if (headingMatch) {
	var level = parseInt(headingMatch[2], 10);
	if (level >= 1 && level <= 6) {
	  return { type: "heading", level: level };
	}
  }

  // Bullet: Contains "bullet" or starts with "b" followed by digit (e.g., "b1").
  if (name.indexOf("bullet") > -1 || /^b\d+/.test(name)) {
	return { type: "bullet" };
  }

  // Numbered: Contains "number" or "num" or starts with "n" followed by digit (e.g., "n1").
  if (
	name.indexOf("number") > -1 ||
	name.indexOf("num") > -1 ||
	/^n\d+/.test(name)
  ) {
	return { type: "numbered" };
  }

  // Default to body text.
  return { type: "body" };
}

function isOnPasteboard(textFrame) {
  return textFrame.parentPage === null;
}

function meetsMinimumSize(textFrame, minSize) {
  return (
	textFrame.geometricBounds[2] - textFrame.geometricBounds[0] >= minSize &&
	textFrame.geometricBounds[3] - textFrame.geometricBounds[1] >= minSize
  );
}

function getWordCount(story) {
  return story.words.length;
}

function exportStoryAsMarkdown(story, outputFile, preserveNumbering) {
  var markdownString = "";
  var prevWasHeading = false;
  
  for (var i = 0; i < story.paragraphs.length; i++) {
	var para = story.paragraphs[i];
	if (para.contents.length == 0) {
	  continue;
	}

	var prevPara = i > 0 ? story.paragraphs[i - 1] : null;
	var nextPara = i < story.paragraphs.length - 1 ? story.paragraphs[i + 1] : null;

	var style = classifyParagraphStyle(para);
	var isStructuralList = isStructuralListItem(para, prevPara, nextPara);
	var prefix = "";
	
	// Headings are never treated as lists
	var isListForSpacing = (style.type === "bullet" || style.type === "numbered" || isStructuralList) && style.type !== "heading";

	// Heading prefix (headings get no indentation, just # symbols)
	if (style.type === "heading") {
	  // Add blank line before heading if previous line was NOT a heading
	  if (markdownString.length > 0 && !prevWasHeading) {
		markdownString += "\n";
	  }
	  prefix = repeat("#", style.level) + " ";
	  prevWasHeading = true;
	}
	// List prefix with nesting support (only for non-headings)
	else if (isStructuralList || style.type === "bullet" || style.type === "numbered") {
	  // Find minimum indent in local context for relative nesting
	  var minIndent = findMinListIndent(story, i);
	  var nestingLevel = getListNestingLevel(para, minIndent);
	  var indentPrefix = repeat("\t", nestingLevel);
	  
	  if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) {
		var marker = trim(para.bulletsAndNumberingResultText);
		
		// For Markdown: Replace ALL bullet characters with dash
		if (isBulletMarker(marker)) {
		  prefix = indentPrefix + "- ";
		} else {
		  // Keep numbered markers as-is
		  prefix = indentPrefix + marker + " ";
		}
	  } else if (style.type === "numbered") {
		prefix = indentPrefix + "1. ";
	  } else {
		// Default to dash for bullets (Markdown standard)
		prefix = indentPrefix + "- ";
	  }
	  prevWasHeading = false;
	} else {
	  prevWasHeading = false;
	}

	var content = cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
	var line = prefix + content.replace(/\r$/, "");

	if (line.replace(/^\s+|\s+$/g, "").length == 0) {
	  continue;
	}

	if (isListForSpacing) {
	  markdownString += line + "\n";
	} else {
	  markdownString += line + "\n\n";
	}
  }

  outputFile.open("w");
  outputFile.encoding = "UTF-8";
  outputFile.write(markdownString);
  outputFile.close();
}

function getStoryContentAsMarkdown(story, preserveNumbering) {
  var markdownString = "";
  var prevWasHeading = false;
  
  for (var i = 0; i < story.paragraphs.length; i++) {
	var para = story.paragraphs[i];
	if (para.contents.length == 0) {
	  continue;
	}

	var prevPara = i > 0 ? story.paragraphs[i - 1] : null;
	var nextPara = i < story.paragraphs.length - 1 ? story.paragraphs[i + 1] : null;

	var style = classifyParagraphStyle(para);
	var isStructuralList = isStructuralListItem(para, prevPara, nextPara);
	var prefix = "";
	
	// Headings are never treated as lists
	var isListForSpacing = (style.type === "bullet" || style.type === "numbered" || isStructuralList) && style.type !== "heading";

	// Heading prefix (headings get no indentation, just # symbols)
	if (style.type === "heading") {
	  // Add blank line before heading if previous line was NOT a heading
	  if (markdownString.length > 0 && !prevWasHeading) {
		markdownString += "\n";
	  }
	  prefix = repeat("#", style.level) + " ";
	  prevWasHeading = true;
	}
	// List prefix with nesting support (only for non-headings)
	else if (isStructuralList || style.type === "bullet" || style.type === "numbered") {
	  // Find minimum indent in local context for relative nesting
	  var minIndent = findMinListIndent(story, i);
	  var nestingLevel = getListNestingLevel(para, minIndent);
	  var indentPrefix = repeat("\t", nestingLevel);
	  
	  if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) {
		var marker = trim(para.bulletsAndNumberingResultText);
		
		// For Markdown: Replace ALL bullet characters with dash
		if (isBulletMarker(marker)) {
		  prefix = indentPrefix + "- ";
		} else {
		  // Keep numbered markers as-is
		  prefix = indentPrefix + marker + " ";
		}
	  } else if (style.type === "numbered") {
		prefix = indentPrefix + "1. ";
	  } else {
		// Default to dash for bullets (Markdown standard)
		prefix = indentPrefix + "- ";
	  }
	  prevWasHeading = false;
	} else {
	  prevWasHeading = false;
	}

	var content = cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));
	var line = prefix + content.replace(/\r$/, "");

	if (line.replace(/^\s+|\s+$/g, "").length == 0) {
	  continue;
	}

	if (isListForSpacing) {
	  markdownString += line + "\n";
	} else {
	  markdownString += line + "\n\n";
	}
  }
  return markdownString;
}

function exportStoryAsPlainText(story, outputFile, preserveNumbering) {
  var plainTextString = "";
  for (var i = 0; i < story.paragraphs.length; i++) {
	var para = story.paragraphs[i];
	var content = cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));

	// Skip empty paragraphs.
	if (content.replace(/^\s+|\s+$/g, "").length == 0) {
	  continue;
	}

	var prevPara = i > 0 ? story.paragraphs[i - 1] : null;
	var nextPara = i < story.paragraphs.length - 1 ? story.paragraphs[i + 1] : null;

	var style = classifyParagraphStyle(para);
	var isStructuralList = isStructuralListItem(para, prevPara, nextPara);
	var listPrefix = "";
	if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) {
	  listPrefix = para.bulletsAndNumberingResultText;
	}

	// For non-preserve lists, no prefix added (as in original), just spacing.
	var line = listPrefix + content.replace(/\r$/, "");
	var isListItem =
	  (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) ||
	  (!preserveNumbering && (style.type === "bullet" || style.type === "numbered")) ||
	  isStructuralList;

	if (isListItem) {
	  plainTextString += line + "\n";
	} else {
	  plainTextString += line + "\n\n";
	}
  }

  // Trim any trailing newlines from the end of the whole string.
  plainTextString = plainTextString.replace(/\n+$/, "");

  outputFile.open("w");
  outputFile.encoding = "UTF-8";
  outputFile.write(plainTextString);
  outputFile.close();
}

function getStoryContentAsPlainText(story, preserveNumbering) {
  var plainTextString = "";
  for (var i = 0; i < story.paragraphs.length; i++) {
	var para = story.paragraphs[i];
	var content = cleanSpecialCharacters(getContentWithResolvedCrossRefs(para));

	// Skip empty paragraphs.
	if (content.replace(/^\s+|\s+$/g, "").length == 0) {
	  continue;
	}

	var prevPara = i > 0 ? story.paragraphs[i - 1] : null;
	var nextPara = i < story.paragraphs.length - 1 ? story.paragraphs[i + 1] : null;

	var style = classifyParagraphStyle(para);
	var isStructuralList = isStructuralListItem(para, prevPara, nextPara);
	var listPrefix = "";
	if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) {
	  listPrefix = para.bulletsAndNumberingResultText;
	}

	// For non-preserve lists, no prefix added (as in original), just spacing.
	var line = listPrefix + content.replace(/\r$/, "");
	var isListItem =
	  (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) ||
	  (!preserveNumbering && (style.type === "bullet" || style.type === "numbered")) ||
	  isStructuralList;

	if (isListItem) {
	  plainTextString += line + "\n";
	} else {
	  plainTextString += line + "\n\n";
	}
  }

  // Trim any trailing newlines from the end of the whole string.
  plainTextString = plainTextString.replace(/\n+$/, "");
  return plainTextString;
}

function exportStories(
  exportFormat,
  targetFolder,
  minWordCount,
  minFrameSize,
  preserveNumbering,
  singleFile,
) {
  var exportedCount = 0;
  var skippedCount = 0;
  var tocSkippedCount = 0;
  var isMarkdown = exportFormat == 2;
  var isPlainText = exportFormat == 1;
  
  // For single file export
  var singleFileContent = "";
  var singleFileNumConverts = 0;
  var storiesToProcess = [];

  // First pass: identify which stories to export
  for (var i = 0; i < app.activeDocument.stories.length; i++) {
	var story = app.activeDocument.stories.item(i);

	// Skip TOC stories
	if (story.storyType == StoryTypes.TOC_STORY) {
	  tocSkippedCount++;
	  continue;
	}

	// Skip if story is too short.
	if (getWordCount(story) < minWordCount) {
	  skippedCount++;
	  continue;
	}

	// Check all text frames in the story.
	var shouldExport = false;
	for (var j = 0; j < story.textContainers.length; j++) {
	  var textFrame = story.textContainers[j];
	  if (
		!isOnPasteboard(textFrame) &&
		meetsMinimumSize(textFrame, minFrameSize)
	  ) {
		shouldExport = true;
		break;
	  }
	}

	if (!shouldExport) {
	  skippedCount++;
	  continue;
	}

	storiesToProcess.push(story);
  }

  // Process stories
  if (singleFile && (isMarkdown || isPlainText)) {
	// Single file export for Markdown or Plain Text
	for (var idx = 0; idx < storiesToProcess.length; idx++) {
	  var story = storiesToProcess[idx];
	  
	  if (idx > 0) {
		singleFileContent += "\n\n--------\n\n";
	  }
	  
	  if (isMarkdown) {
		singleFileContent += getStoryContentAsMarkdown(story, preserveNumbering);
	  } else {
		singleFileContent += getStoryContentAsPlainText(story, preserveNumbering);
	  }
	  
	  exportedCount++;
	}
	
	// Write the single file
	var docName = app.activeDocument.name.replace(/\.indd$/i, "");
	var extension = isMarkdown ? ".md" : ".txt";
	var outputFile = new File(targetFolder + "/" + docName + "_all_stories" + extension);
	var counter = 1;
	while (outputFile.exists) {
	  outputFile = new File(
		targetFolder + "/" + docName + "_all_stories_" + counter + extension,
	  );
	  counter++;
	}
	
	outputFile.open("w");
	outputFile.encoding = "UTF-8";
	outputFile.write(singleFileContent);
	outputFile.close();
	
  } else if (singleFile) {
	// Single file export not supported for RTF or Tagged Text
	alert(
	  "Single file export is only supported for Markdown and Plain Text formats.\n" +
	  "Please change the export format or disable the single file option."
	);
	return;
	
  } else {
	// Individual file export (original behavior)
	for (var idx = 0; idx < storiesToProcess.length; idx++) {
	  var story = storiesToProcess[idx];
	  
	  // Temporarily convert numbering/bullets to text for RTF/Tagged Text if preserving.
	  var numConverts = 0;
	  if (preserveNumbering && (exportFormat === 0 || exportFormat === 3)) {
		for (var p = 0; p < story.paragraphs.length; p++) {
		  var para = story.paragraphs[p];
		  if (para.bulletsAndNumberingResultText.length > 0) {
			para.convertNumberingToText();
			numConverts++;
		  }
		}
	  }

	  // Create a descriptive file name from the first 5 words of the story.
	  var fileName = "";
	  if (story.words.length > 0) {
		var wordCount = Math.min(5, story.words.length);
		for (var w = 0; w < wordCount; w++) {
		  fileName += story.words[w].contents + " ";
		}
		fileName = fileName.replace(/^\s+|\s+$/g, "");
		
		// Sanitize for use as a filename.
		var illegalChars = ["/", "\\", ":", "*", "?", '"', "<", ">", "|"];
		for (var c = 0; c < illegalChars.length; c++) {
		  fileName = fileName.split(illegalChars[c]).join("");
		}
		fileName = fileName.substring(0, 60);
	  }

	  // If the filename is empty or story was empty, use the story ID as a fallback.
	  if (fileName == "") {
		fileName = "Story_" + story.id;
	  }

	  var format, extension;
	  if (isMarkdown) {
		extension = ".md";
	  } else if (isPlainText) {
		extension = ".txt";
	  } else {
		switch (exportFormat) {
		  case 0:
			format = ExportFormat.RTF;
			extension = ".rtf";
			break;
		  case 3:
			format = ExportFormat.TAGGED_TEXT;
			extension = ".txt";
			break;
		}
	  }

	  var outputFile = new File(targetFolder + "/" + fileName + extension);
	  var counter = 1;
	  // Handle potential filename collisions by appending a number.
	  while (outputFile.exists) {
		outputFile = new File(
		  targetFolder + "/" + fileName + "_" + counter + extension,
		);
		counter++;
	  }

	  if (isMarkdown) {
		exportStoryAsMarkdown(story, outputFile, preserveNumbering);
	  } else if (isPlainText) {
		exportStoryAsPlainText(story, outputFile, preserveNumbering);
	  } else {
		story.exportFile(format, outputFile);
	  }

	  // Revert the conversions by undoing each one.
	  for (var u = 0; u < numConverts; u++) {
		app.activeDocument.undo();
	  }

	  exportedCount++;
	}
  }

  // Show summary.
  var preserveNote = preserveNumbering
	? "\n(List markers included where applicable.)"
	: "";
  var singleFileNote = singleFile && (isMarkdown || isPlainText)
	? "\n(All stories exported to a single file with dividers.)"
	: "";
  var tocNote = tocSkippedCount > 0
	? "\n(Table of Contents stories excluded.)"
	: "";
  alert(
	"Export complete!" +
	  preserveNote +
	  singleFileNote +
	  tocNote +
	  "\n\n" +
	  "Exported: " +
	  exportedCount +
	  " stories\n" +
	  "Skipped: " +
	  skippedCount +
	  " stories\n" +
	  (tocSkippedCount > 0 ? "TOC stories skipped: " + tocSkippedCount + "\n" : "") +
	  "\nFiles saved to:\n" +
	  targetFolder.fsName +
	  "\n\n" +
	  "Stories were skipped if they:\n" +
	  "- Were Table of Contents stories\n" +
	  "- Had fewer than " +
	  minWordCount +
	  " words\n" +
	  "- Were only on the pasteboard\n" +
	  "- Had no text frames larger than " +
	  minFrameSize +
	  " points",
  );
}

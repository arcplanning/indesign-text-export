/*
  ExportAllStories.jsx
  An InDesign JavaScript to export all stories.

  Author: Adobe Systems, Inc.
  Revision:  Architectural Research Consultants, Incorporated
  Date: 2025-09-30
  Revised: 2025-10-15

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
              radiobuttonControls.add({ staticLabel: "RTF" });
              radiobuttonControls.add({ staticLabel: "Text Only" });
              radiobuttonControls.add({ staticLabel: "Markdown" });
              radiobuttonControls.add({ staticLabel: "InDesign Tagged Text" });
            }
            formatButtons.radiobuttonControls[lastFormat].checkedState = true;
          }
        }

        // === COLUMN B ===
        with (dialogColumns.add()) {
          // PANEL 2: EXPORT OPTIONS
          //with (borderPanels.add()) {
            // Add an inner column to the border panel to hold the rows
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

            // Row for checkbox spanning full width
            with (innerColumn.dialogRows.add()) {
              with (dialogColumns.add()) {
                preserveCheckbox = checkboxControls.add({
                  staticLabel: "Include list markers, such as numbering and bullets",
                  checkedState: lastPreserve === "1",
                });
              }
            }
          //}
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

    if (dialog.show()) {
      var exportFormat = formatButtons.selectedButton;
      var preserveNumbering = preserveCheckbox.checkedState;
      var minWordCount = parseInt(minWordCountField.editContents);
      var minFrameSize = parseInt(minFrameSizeField.editContents);
      var chosenPath = pathEditbox.editContents;

      // Save preferences for next time
      app.insertLabel("exportStories.format", exportFormat.toString());
      app.insertLabel(
        "exportStories.preserveNumbering",
        preserveNumbering ? "1" : "0",
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
        );
      }
    } else {
      dialog.destroy();
    }
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
  for (var i = 0; i < story.paragraphs.length; i++) {
    var para = story.paragraphs[i];
    if (para.contents.length == 0) {
      continue;
    }

    var style = classifyParagraphStyle(para);
    var prefix = "";
    var isListForSpacing = style.type === "bullet" || style.type === "numbered";

    // Heading prefix
    if (style.type === "heading") {
      prefix = repeat("#", style.level) + " ";
    }

    // List prefix
    var listPrefix = "";
    if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) {
      listPrefix = para.bulletsAndNumberingResultText;
    } else if (style.type === "bullet") {
      listPrefix = "- ";
    } else if (style.type === "numbered") {
      listPrefix = "1. "; // Simple static numbering; full enumeration would require tracking counters.
    }

    prefix += listPrefix;

    var content = para.contents;

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

function exportStoryAsPlainText(story, outputFile, preserveNumbering) {
  var plainTextString = "";
  for (var i = 0; i < story.paragraphs.length; i++) {
    var para = story.paragraphs[i];
    var content = para.contents;

    // Skip empty paragraphs.
    if (content.replace(/^\s+|\s+$/g, "").length == 0) {
      continue;
    }

    var style = classifyParagraphStyle(para);
    var listPrefix = "";
    if (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) {
      listPrefix = para.bulletsAndNumberingResultText;
    }
    // For non-preserve lists, no prefix added (as in original), just spacing.

    var line = listPrefix + content.replace(/\r$/, "");

    var isListItem =
      (preserveNumbering && para.bulletsAndNumberingResultText.length > 0) ||
      (!preserveNumbering &&
        (style.type === "bullet" || style.type === "numbered"));

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

function exportStories(
  exportFormat,
  targetFolder,
  minWordCount,
  minFrameSize,
  preserveNumbering,
) {
  var exportedCount = 0;
  var skippedCount = 0;

  for (var i = 0; i < app.activeDocument.stories.length; i++) {
    var story = app.activeDocument.stories.item(i);

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
      var illegalChars = ["/", "\\\\", ":", "*", "?", '"', "<", ">", "|"];
      for (var c = 0; c < illegalChars.length; c++) {
        // InDesign's JS engine doesn't like .replaceAll(), so we use split/join.
        fileName = fileName.split(illegalChars[c]).join("");
      }
      fileName = fileName.substring(0, 60);
    }

    // If the filename is empty or story was empty, use the story ID as a fallback.
    if (fileName == "") {
      fileName = "Story_" + story.id;
    }

    var format, extension;
    var isMarkdown = exportFormat == 2; // Index for Markdown.
    var isPlainText = exportFormat == 1; // Index for Text Only.

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
        case 3: // Index for Tagged Text is now 3.
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

  // Show summary.
  var preserveNote = preserveNumbering
    ? "\n(List markers included where applicable.)"
    : "";
  alert(
    "Export complete!" +
      preserveNote +
      "\n\n" +
      "Exported: " +
      exportedCount +
      " stories\n" +
      "Skipped: " +
      skippedCount +
      " stories\n\n" +
      "Files saved to:\n" +
      targetFolder.fsName +
      "\n\n" +
      "Stories were skipped if they:\n" +
      "- Had fewer than " +
      minWordCount +
      " words\n" +
      "- Were only on the pasteboard\n" +
      "- Had no text frames larger than " +
      minFrameSize +
      " points",
  );
}
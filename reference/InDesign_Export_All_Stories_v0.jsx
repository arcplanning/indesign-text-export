/*
  ExportAllStories.jsx
  An InDesign JavaScript to export all stories.

  Author: Adobe Systems, Inc. (Updated by dvorak)
  Date: 2025-09-30

  Update of Adobe's default script called "ExportAllStories.jsx".
  Exports all stories in an InDesign document in a specified text format.
  Ignores small text frames, items on pasteboard, and very short text snippets.
*/

initializeScript();

function initializeScript() {
  //Make certain that user interaction (display of dialogs, etc.) is turned on.
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

  // Load last used path, or generate a default one
  var lastPath = app.extractLabel("exportStories.lastPath");
  if (lastPath === "" || !new Folder(lastPath).parent.exists) {
    // Also check if parent exists, in case of moved/deleted folders
    var docName = app.activeDocument.name.replace(/\.indd$/i, "");
    lastPath = Folder.desktop.fsName + "/" + docName + "_Export";
  }

  var dialog = app.dialogs.add({ name: "Export All Stories" });
  var formatButtons, minWordCountField, minFrameSizeField, pathEditbox;

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
          // PANEL 2: MINIMUMS
          with (borderPanels.add()) {
            // Use a two-column grid for alignment
            with (dialogRows.add()) {
              with (dialogColumns.add()) {
                staticTexts.add({
                  staticLabel: "Mininum words:",
                  justify: "right",
                });
                staticTexts.add({
                  staticLabel: "Mininum size (pt):",
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

            staticTexts.add({
              staticLabel: "Tip: Enter 0 to disable each filter.",
            });
          }
        }
      }

      // PANEL 3: OUTPUT FOLDER
      with (borderPanels.add()) {
        staticTexts.add({ staticLabel: "Output Folder:" });
        pathEditbox = textEditboxes.add({
          editContents: lastPath,
          minWidth: 380,
        });
      }
    }

    if (dialog.show()) {
      var exportFormat = formatButtons.selectedButton;
      var minWordCount = parseInt(minWordCountField.editContents);
      var minFrameSize = parseInt(minFrameSizeField.editContents);
      var chosenPath = pathEditbox.editContents;

      // Save preferences for next time
      app.insertLabel("exportStories.format", exportFormat.toString());
      app.insertLabel("exportStories.minWords", minWordCountField.editContents);
      app.insertLabel(
        "exportStories.minFrameSize",
        minFrameSizeField.editContents,
      );
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
        );
      }
    } else {
      dialog.destroy();
    }
  }
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

function exportStoryAsMarkdown(story, outputFile) {
  var markdownString = "";
  for (var i = 0; i < story.paragraphs.length; i++) {
    var para = story.paragraphs[i];
    if (para.contents.length == 0) {
      continue;
    }
    var paraStyleName = para.appliedParagraphStyle.name.toLowerCase();
    var prefix = "";

    // This is the part that needs to be customized based on the document's styles.
    // We are using flexible matching to detect style names.
    if (
      paraStyleName.indexOf("h1") > -1 ||
      paraStyleName.indexOf("heading 1") > -1
    ) {
      prefix = "# ";
    } else if (
      paraStyleName.indexOf("h2") > -1 ||
      paraStyleName.indexOf("heading 2") > -1
    ) {
      prefix = "## ";
    } else if (
      paraStyleName.indexOf("h3") > -1 ||
      paraStyleName.indexOf("heading 3") > -1
    ) {
      prefix = "### ";
    } else if (
      paraStyleName.indexOf("h4") > -1 ||
      paraStyleName.indexOf("heading 4") > -1
    ) {
      prefix = "#### ";
    } else if (
      paraStyleName.indexOf("bullet") > -1 ||
      paraStyleName.match(/^b\\d/)
    ) {
      prefix = "- "; // Use a dash for bullet points as requested.
    } else if (paraStyleName.indexOf("number") > -1) {
      prefix = "1. ";
    }

    var content = para.contents;

    if (content.replace(/^\s+|\s+$/g, "").length == 0) {
      continue;
    }

    // Remove the trailing return character from InDesign paragraphs
    content = content.replace(/\r$/, "");

    markdownString += prefix + content + "\n\n";
  }

  outputFile.open("w");
  outputFile.encoding = "UTF-8";
  outputFile.write(markdownString);
  outputFile.close();
}

function exportStoryAsPlainText(story, outputFile) {
  var plainTextString = "";
  for (var i = 0; i < story.paragraphs.length; i++) {
    var para = story.paragraphs[i];
    var content = para.contents;

    // Skip empty paragraphs
    if (content.replace(/^\s+|\s+$/g, "").length == 0) {
      continue;
    }

    // Remove the trailing return character from InDesign paragraphs
    content = content.replace(/\r$/, "");

    var paraStyleName = para.appliedParagraphStyle.name.toLowerCase();
    var isListItem = false;
    if (
      paraStyleName.indexOf("bullet") > -1 ||
      paraStyleName.match(/^b\\d/) ||
      paraStyleName.indexOf("number") > -1
    ) {
      isListItem = true;
    }

    if (isListItem) {
      plainTextString += content + "\n";
    } else {
      plainTextString += content + "\n\n";
    }
  }

  // Trim any trailing newlines from the end of the whole string.
  plainTextString = plainTextString.replace(/\n+$/, "");

  outputFile.open("w");
  outputFile.encoding = "UTF-8";
  outputFile.write(plainTextString);
  outputFile.close();
}

function exportStories(exportFormat, targetFolder, minWordCount, minFrameSize) {
  var exportedCount = 0;
  var skippedCount = 0;

  for (var i = 0; i < app.activeDocument.stories.length; i++) {
    var story = app.activeDocument.stories.item(i);

    // Skip if story is too short
    if (getWordCount(story) < minWordCount) {
      skippedCount++;
      continue;
    }

    // Check all text frames in the story
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
        // InDesign's JS engine doesn't like .replaceAll(), so we use split/join
        fileName = fileName.split(illegalChars[c]).join("");
      }
      fileName = fileName.substring(0, 60);
    }

    // If the filename is empty or story was empty, use the story ID as a fallback.
    if (fileName == "") {
      fileName = "Story_" + story.id;
    }

    var format, extension;
    var isMarkdown = exportFormat == 2; // Index for Markdown
    var isPlainText = exportFormat == 1; // Index for Text Only

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
        case 3: // Index for Tagged Text is now 3
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
      exportStoryAsMarkdown(story, outputFile);
    } else if (isPlainText) {
      exportStoryAsPlainText(story, outputFile);
    } else {
      story.exportFile(format, outputFile);
    }
    exportedCount++;
  }

  // Show summary
  alert(
    "Export complete!\n\n" +
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

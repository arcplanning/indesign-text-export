# InDesign Export All Stories

An [Adobe InDesign](https://www.adobe.com/products/indesign.html) JavaScript script to export document content as plain text.

## Description

This script extracts text content from an Adobe InDesign document and saves the result as [plain text](https://amontalenti.com/2016/06/11/simple-and-universal-a-history-of-plain-text-and-why-it-matters), [Markdown](https://www.markdownguide.org/cheat-sheet/), Rich Text, or InDesign Tagged Text. Use it for data exchange, automated processing, backups, search indexing, or moving content into other tools.

Markdown and Plain Text exports go into a single file per document, with stories ordered by page, then top-to-bottom and left-to-right within a page. RTF and Tagged Text exports use one file per story, matching InDesign’s native exporter.

## Features

- Walks the document in reading order (not InDesign’s frame-creation order).
- Four output formats: Plain Text (`.txt`), Markdown (`.md`), Rich Text (`.rtf`), and InDesign Tagged Text (`.txt`).
- Detects headings from style names, the `basedOn` style chain, and optionally paragraph text size.
- Handles lists: bullets, numbered lists, structural lists inferred from hanging indents, with optional preservation of original numbering.
- Extracts tables as TSV blocks or pretty Markdown tables, with optional captions (id, page, notes). Tables not anchored to any exported story collect in a "Standalone Tables" block at the end.
- Resolves cross-references in body text.
- Filters tiny text frames, items on the pasteboard, very short stories, and the Table-of-Contents story.
- Sanitizes filenames for both macOS and Windows (illegal characters, control bytes, trailing dots/spaces, and reserved device names like `CON`).
- Leaves the open document unchanged and exports non-destructively.

## Requirements

- Adobe InDesign (tested on recent versions; compatible with CS6+).
- macOS (Finder integration) or Windows (equivalent Explorer reveal).

## Installation

1. Download the script file: [InDesign_Export_All_Stories.jsx](InDesign_Export_All_Stories.jsx).
2. Open Adobe InDesign and navigate to the Scripts panel: **Window > Utilities > Scripts**.
3. In the panel, expand the **User** folder, click the panel’s flyout menu (top-right), and select **Reveal in Finder** (macOS) or **Reveal in Explorer** (Windows).

![Reveal Scripts Folder](reference/indesign-folder-reveal.png)

4. Drag `InDesign_Export_All_Stories.jsx` into the revealed folder.
5. Return to InDesign; the Scripts panel now lists the script under **User**.

![Scripts Panel](reference/indesign-scripts-menu.png)

## Usage

1. Open the InDesign document.
2. In the Scripts panel, double-click **InDesign_Export_All_Stories.jsx** under **User**.
3. In the dialog, pick a format and adjust options:
   - **Rich Text (rtf)**: Preserves InDesign’s native styling. One file per story.
   - **Plain Text (txt)**: Stripped content, list markers optional. Single consolidated file.
   - **Markdown (md)**: Headings, lists, and tables as Markdown. Single consolidated file.
   - **InDesign Tagged Text (txt)**: Lossless round-trippable text format. One file per story.

   Options:
   - **Minimum words per story** and **minimum text frame size** filter captions, page numbers, and stray fragments.
   - **Include list markers** preserves numbering / bullet glyphs (Markdown and Plain Text only).
   - **Include tables** and **Table captions** extract tables as TSV or Markdown, optionally with id/page metadata.
   - **Infer headings from text size** supports documents without consistent paragraph styles and ranks distinct point sizes into H1–H6 (Markdown only).

![Export Options](reference/indesign-export-options.png)

4. Click **OK** to export.
5. Review the output file for accuracy; structure detection is best-effort.

![Scripts Panel](reference/exported-basic-text.png)

The original InDesign document stays unchanged. The script generates a minimalistic text version for external use.

## Notes

- Enhanced adaptation of Adobe’s original `ExportAllStories.jsx` (last updated December 2009), with improved format options and Markdown support.
- For scripting details, see the [InDesign Scripting SDK](https://www.adobe.com/devnet/indesign/sdk.html) or the [InDesign Scripting Forum](https://community.adobe.com/t5/indesign-discussions/ct-p/ct-indesign?page=1&sort=latest_replies&lang=all&tabid=all).

## License

MIT License. See [license.md](license.md) and [Adobe Developer Console](https://developer.adobe.com/indesign/) for details.
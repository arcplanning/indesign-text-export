# InDesign Export All Stories

An Adobe InDesign JavaScript script to export all stories from a document as plain text.

## Description

This script exports the contents of an Adobe InDesign document as [plain text](https://amontalenti.com/2016/06/11/simple-and-universal-a-history-of-plain-text-and-why-it-matters), which is a clean, universal, format that removes all styling, graphics, and layout constraints. Ideal for data exchange, automated processing, backups, or integration with other tools.

Plain text ensures portability across systems without proprietary dependencies, making it a timeless choice for content liberation.

## Features

- Exports all document stories in one go.
- Supports multiple output formats, including plain text (`.txt`) and [Markdown](https://www.markdownguide.org/cheat-sheet/) (`.md`) for preserved structure (e.g., headings, bullets).
- Non-destructive: Works on any open InDesign document.

## Requirements

- Adobe InDesign (tested on recent versions; compatible with CS6+).
- macOS (Finder integration) or Windows (equivalent Explorer reveal).

## Installation

1. Download the script file: [InDesign_Export_All_Stories.jsx](InDesign_Export_All_Stories.jsx).
2. Open Adobe InDesign and navigate to the Scripts panel: **Window > Utilities > Scripts**.
3. In the panel, expand the **User** folder, click the panel's flyout menu (top-right), and select **Reveal in Finder** (macOS) or **Reveal in Explorer** (Windows).

![Reveal Scripts Folder](reference/indesign-folder-reveal.png)

4. Drag the downloaded `InDesign_Export_All_Stories.jsx` file into the revealed folder.
5. Return to InDesign, and the Scripts panel should now list the script under **User**.

![Scripts Panel](reference/indesign-scripts-menu.png)

## Usage

1. Open your InDesign document.
2. In the Scripts panel, double-click **InDesign_Export_All_Stories.jsx** under **User**.
3. In the dialog, select an output location and choose a format:
   - **Text (txt)**: Pure plain text.
   - **Markdown (md)**: Retains detected structure like headings and lists for enhanced readability.
   
![Export Optionsl](reference/indesign-export-options.png)  
   
4. Click **Save** to export.
5. Review the output file for accuracy (structure detection is best-effort).

![Scripts Panel](reference/exported-basic-text.png)

Your original InDesign document remains unchanged.  This script just generates a minimalistic copy for external use.


## Notes

- This is an enhanced adaptation of Adobe's original `ExportAllStories.jsx` (last updated December 2009), with improved format options and Markdown support.
- For scripting details, refer to the [InDesign Scripting SDK](https://www.adobe.com/devnet/indesign/sdk.html) or the [InDesign Scripting Forum](https://community.adobe.com/t5/indesign-discussions/ct-p/ct-indesign?page=1&sort=latest_replies&lang=all&tabid=all).

## License

MIT License. See [LICENSE](LICENSE.md) and [Adobe Developer Console](https://developer.adobe.com/indesign/) for details.
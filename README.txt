SHEET MAKER - Folder of images to print-sheet PDF
=================================================

RUN
1. Unzip the folder.
2. Double-click index.html (opens in Chrome or Edge).
3. Click "Image folder" and choose your folder (wait for the preview to load).
4. Set sheet, layout, spacing, quality.
5. Click "Create PDF". The PDF downloads automatically.
   (Cancel stops a long job at any time.)

If the folder picker does not work when opening the file directly,
open a terminal inside this folder and run ONE of these:
    php -S localhost:8000
    python -m http.server 8000
then open http://localhost:8000 in the browser.

OPTIONS
Sheet      13x19 (default), 12x18, 11x17, A3+, A3, A4, Letter, or Custom size.
           Portrait or Landscape.
Layout     1, 2, 3, 4, 6, 8, 9, 12 images per page (grid is columns x rows).
           Copies of each image (step and repeat).
           Image fit: Fit inside cell, or Fill cell (crops the edges).
           Fill order: row by row, or column by column.
           Auto-rotate 90 degrees when the image fits the cell better.
Spacing    Outer margin, gap between images.
           Cut marks On/Off and their distance from the image.
Quality    Original (no quality loss)
           High    300 DPI, JPEG 95%
           Medium  200 DPI, JPEG 85%
           Low     100 DPI, JPEG 70%   (small draft files)
           Custom  your own DPI and JPEG quality
           The page shows the lowest DPI your layout gives, so you can judge.

QUALITY DETAILS
- Original: JPEG files are embedded as the original file, PNG files keep their
  original pixel data. Transparent PNG, WEBP, GIF, BMP and rotated phone photos
  are copied pixel-for-pixel (transparency becomes white).
- Other settings only shrink images that have MORE pixels than the DPI needs.
  Images are never enlarged. A JPEG that is already small enough stays untouched.

PRINTING
- The sheet size is exact and the PDF asks the print dialog not to scale it.
- In the print dialog choose "Actual size" / 100% (not "Fit").
- Cut marks are thin black vector lines from the page edge to the image edge.

NOTES
- Nothing is uploaded. Everything runs in your browser.
- Files are placed in filename order (1, 2, 10 sorted correctly).
- Broken or unreadable images are skipped and listed when the PDF is done.
- Hidden files (names starting with a dot) are ignored.

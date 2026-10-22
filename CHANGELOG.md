# Changelog

Each version's section becomes its GitHub release's notes when its `v<version>` tag is pushed.

## 0.3.1 - 2026-10-22

### Fixed

- Prints from MakerWorld show the model's name instead of the print profile's, such as "0.2mm layer, 2 walls, 15% infill".
- The progress bar keeps its width as it fills in the desktop app.

### Changed

- The README shows a time-lapse of the pane through a print.

## 0.3.0 - 2026-10-22

### Added

- Plugin icon.
- Screenshots in the README.
- Made-up prints in `fixtures/` for screenshots and checks. A fixture can now name the printer and give the plate thumbnail.

### Fixed

- Text beside the plate thumbnail, such as a long HMS error, no longer runs past the edge of a narrow pane.

## 0.2.0 - 2026-10-22

First release: a Bambu Lab printer in a pane beside the chat, with print status, temperatures, AMS filaments, HMS errors and the plate thumbnail, live from Bambu Lab's cloud.

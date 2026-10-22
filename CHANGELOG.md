# Changelog

Each version's section becomes its GitHub release's notes when its `v<version>` tag is pushed.

## 0.4.0 - 2026-10-22

The pane is laid out like Bambu Handy.

### Added

- The print's settings under its name, such as "0.2mm layer, 2 walls, 15% infill", from the slicer's files Bambu keeps with the cloud task.
- Skip objects: pick objects on a drawing of the bed (a list in the terminal), then confirm. Objects already skipped are greyed out.
- The printer's notices, such as a calibration it asks for, in a green banner. HMS wording now comes from Bambu's table for the printer's model, which knows newer printers' codes.
- AMS humidity.

### Changed

- The print sits in a card with the thumbnail on a plate, a large percentage, a thick progress bar and its Skip, Pause and Stop buttons.
- Temperatures are chips, with icons in the desktop app.
- The AMS is a card: spools in their filament's colour in the desktop app, with what's left on each and the one in use feeding below it; a row of slots in the terminal.
- Hotkey badges are left to the terminal; the desktop app's buttons carry icons instead.
- The README shows a real print instead of the time-lapse, and new screenshots.

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

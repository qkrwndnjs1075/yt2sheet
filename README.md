# yt2sheet

yt2sheet turns the sheet music shown in a YouTube video into a PDF. Paste a YouTube link, and it saves the visible score pages as a PDF on your computer.

Use it for videos that already show readable sheet music or tablature on screen. It does not create notation that is not visible in the video.

## Install

No programming setup is required. Paste the command for your computer into a terminal.

### Windows

Open Command Prompt or PowerShell, then run:

```powershell
irm https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.ps1 | iex
```

Run this command in the current PowerShell window if you want `yt2` to be available immediately. A child command such as `powershell -Command ...` cannot update the parent window's PATH; open a new terminal after that form. The installer prints `### [n/7]` stage markers while it downloads, verifies, and installs the bundle.

### macOS, or Ubuntu 22.04/24.04 x64

Open Terminal, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.sh | sh
```

## Check the version

Print the installed yt2sheet version with any of these equivalent commands:

```sh
yt2 version
yt2 --version
yt2 -v
```

## Create a PDF

Open a new terminal after installation and run:

```sh
yt2 "https://www.youtube.com/watch?v=VIDEO_ID"
```

Without `--output`, the PDF is saved in a `yt2sheet` subfolder of the folder where you run the command.

This is a local CLI and does not depend on Chrome or another browser. In macOS Terminal, PowerShell, and other shells, wrap the entire URL in double quotes so `?` and `&` reach `yt2` unchanged.

While a PDF is being created, `yt2` reports the nine reviewed-output phases described below. Interactive terminals redraw one line; redirected output receives stable stage lines on `stderr`, while the final completion path is written to `stdout`.

## Reviewed A4 output contract

The nine phases: info, download, extraction, raster analysis, raster review, OMR, MusicXML validation, engraving, and PDF publication.

Successful processing exposes one public PDF and no public sidecar. The final path is the only success value on `stdout`; warnings are written to `stderr`. A structured approval publishes a validated engraved result. If a structured tool or validation warning occurs, yt2sheet uses a raster fallback only when the independently reviewed raster is safe. A hard block—such as an unsafe, unreadable, or clipped raster; an invalid final PDF; or a publication failure—exits nonzero and publishes no new PDF.

The PDF page uses ISO 216 A4 physical geometry: 595.28 × 841.89 points. This is separate from the embedded image resolution of 1200 × 1697 raster pixels at 145.14 DPI; pixels and points are not interchangeable.

## Bundled runtime support and networking

Standalone bundles support Windows Server 2022 x64, macOS 14 x64 or arm64, and Ubuntu 22.04/24.04 x64 only. They pin Audiveris 5.11.0 and MuseScore 4.7.4. Bootstrap limits are 750 MiB for each runtime archive, 2 GiB for installed runtimes, and 4 GiB for temporary extraction.

npm installation bootstraps bundled tools over the network; npm installation is not an offline install. After installation, local review and PDF generation support offline processing when source media is already available. Downloading a YouTube source still needs network access.

### Time range

`--start` and `--end` accept decimal seconds, `MM:SS(.fraction)`, or `H:MM:SS` and define the half-open interval `[start,end)`.
An omitted `--start` means `0`; an omitted `--end` means the video duration.
The interval requires start < end (end must be greater than start).
The range must fit the video duration: `start < duration` and `end <= duration`.
Ranges outside the video duration are rejected before media processing starts.
Before the media download begins, `yt2` prints the final duration-resolved interval.

For example, process from 1 minute 23.5 seconds through 1 hour 2 minutes 3 seconds (excluding the end):

```sh
yt2 "https://www.youtube.com/watch?v=VIDEO_ID" --start 01:23.5 --end 1:02:03
```

## Diagnose the installation

Run one command to check runtime manifest, Audiveris, MuseScore, MusicXML schemas, score fonts, license notices, SBOM, source manifest, and CLI probes, plus bundled media tools, output permissions, optional cookie configuration, and a temporary local PNG-to-MXL-to-PDF smoke test:

```sh
yt2 doctor
```

To check a specific YouTube source without downloading its video, append the URL:

```sh
yt2 doctor "https://www.youtube.com/watch?v=VIDEO_ID"
```

Use `--offline` to skip release and YouTube/source network probes. Doctor never installs or updates tools and never reads browser cookies. A failed check exits with status `1`; warnings and skipped checks keep status `0`.

## Uninstall

To remove a standalone installation, run:

```sh
yt2 uninstall
```

This removes the yt2 bundle, its launcher, and the PATH entry added by the installer. Open a new terminal afterward so the current shell refreshes its PATH.

If yt2 was installed with npm, run:

```sh
npm uninstall -g yt2sheet
```

## Compliance and limitations

The npm archive and standalone bundle root contain THIRD_PARTY_NOTICES.md, bom.cdx.json, and SOURCE_MANIFEST.json. The standalone runtime bundle additionally contains source archives under `THIRD_PARTY/sources/`. MusicXML is the structured interchange and schema-validation format. SMuFL defines music-font glyph semantics. ISO 216 defines the A4 paper geometry.

Recognition accuracy is not guaranteed. Engraving quality is not guaranteed. PDF 2.0 conformance is not guaranteed. yt2sheet does not claim that recognition is always accurate, that output conforms to ISO standards, or that produced files conform to PDF 2.0.

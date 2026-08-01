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

### macOS or Linux

Open Terminal, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/qkrwndnjs1075/yt2sheet/main/scripts/install.sh | sh
```

## Create a PDF

Open a new terminal after installation and run:

```sh
yt2 "https://www.youtube.com/watch?v=VIDEO_ID"
```

The PDF is saved in the folder where you run the command.

In PowerShell, wrap the entire URL in double quotes when it contains `&`; otherwise PowerShell treats `&` as an operator before `yt2` can receive the URL.

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

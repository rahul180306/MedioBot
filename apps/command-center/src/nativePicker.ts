import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NativePickerResult {
  readonly path?: string;
  readonly cancelled: boolean;
  readonly error?: string;
}

/**
 * Invokes the operating system's native directory picker dialog:
 * - macOS: Native Finder folder picker via osascript
 * - Windows: Native File Explorer FolderBrowserDialog via PowerShell
 * - Linux: Native desktop folder picker via zenity or kdialog
 *
 * Gracefully returns { cancelled: true } if the user dismisses the dialog.
 */
export async function pickNativeDirectory(options: { prompt?: string; defaultPath?: string } = {}): Promise<NativePickerResult> {
  const prompt = options.prompt ?? "Select Project Folder";

  if (process.platform === "darwin") {
    try {
      const script = `POSIX path of (choose folder with prompt "${prompt.replace(/"/g, '\\"')}")`;
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      const selected = stdout.trim();
      if (!selected) return { cancelled: true };
      return { path: selected, cancelled: false };
    } catch (error: any) {
      const msg = String(error?.stderr || error?.message || "");
      if (error?.code === 1 || msg.includes("User canceled") || msg.includes("-128")) {
        return { cancelled: true };
      }
      return { cancelled: true, error: msg };
    }
  }

  if (process.platform === "win32") {
    try {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "${prompt.replace(/"/g, '`"')}"
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript]);
      const selected = stdout.trim();
      if (!selected) return { cancelled: true };
      return { path: selected, cancelled: false };
    } catch (error: any) {
      return { cancelled: true, error: String(error?.message || "") };
    }
  }

  // Linux (zenity or kdialog)
  try {
    const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", `--title=${prompt}`]);
    const selected = stdout.trim();
    return selected ? { path: selected, cancelled: false } : { cancelled: true };
  } catch {
    try {
      const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory", options.defaultPath ?? process.cwd()]);
      const selected = stdout.trim();
      return selected ? { path: selected, cancelled: false } : { cancelled: true };
    } catch {
      return { cancelled: true };
    }
  }
}

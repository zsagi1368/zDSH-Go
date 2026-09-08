/**
 * Default security guard values for the upload domain (P01 §6-A / §9-F).
 * The deny list follows the Windows-flavored executable/script family:
 * PE binaries, installers, shell/batch scripts, PowerShell, WSH/VBScript
 * (including the `.js`/`.jse` WSH engines), shortcut and help-file launchers,
 * and Java archives. Operators override wholesale via
 * `upload.dangerousExtensions`.
 */
export const DEFAULT_DANGEROUS_EXTENSIONS: readonly string[] = [
  // Windows executables / libraries / installers
  'exe', 'dll', 'com', 'cpl', 'msi', 'msp', 'mst', 'scr',
  // Shell + batch
  'bat', 'cmd',
  // PowerShell family
  'ps1', 'psm1', 'psd1', 'msh', 'msh1', 'msh2',
  // Windows Script Host family (VBScript/JScript engines)
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ws',
  // Launchers that execute on open
  'hta', 'lnk', 'chm', 'reg',
  // Packaged code
  'jar',
]

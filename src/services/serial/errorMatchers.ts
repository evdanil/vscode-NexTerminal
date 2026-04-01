export function isSerialRuntimeMissingError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("serialport module not installed") || lower.includes("cannot find module 'serialport'");
}

export function isMissingSerialPortError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.startsWith("port ") && lower.includes(" not found");
}

export function isBusyOrPermissionSerialError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("permission denied") || lower.includes("access denied") || lower.includes(" busy");
}

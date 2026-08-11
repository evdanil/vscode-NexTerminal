export function isSerialRuntimeMissingError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("serialport module not installed") || lower.includes("cannot find module 'serialport'");
}

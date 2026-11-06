/** Keep diagnostics visible without letting either stream exceed the total cap. */
export function capCodeOutput(stdout: string, stderr: string, cap: number) {
  const trim = (text: string, bytes: number, tail = false) => {
    const buffer = Buffer.from(text);
    let value = (
      tail
        ? buffer.subarray(Math.max(0, buffer.length - bytes))
        : buffer.subarray(0, bytes)
    ).toString();
    while (Buffer.byteLength(value) > bytes)
      value = tail ? value.slice(1) : value.slice(0, -1);
    return value;
  };
  const error = trim(stderr, Math.min(4096, cap), true);
  return {
    stdout: trim(stdout, cap - Buffer.byteLength(error)),
    stderr: error,
    truncated:
      Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > cap ||
      Buffer.byteLength(stderr) > Math.min(4096, cap),
  };
}

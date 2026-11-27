/**
 * Await one step of the extension and fail the test instead of hanging when it never settles. Every
 * awaited event of a case goes through here, so a handler that stops settling is a failure with a
 * name and not a suite that never ends. The timer is cleared on both paths, so a step that settles
 * leaves nothing behind.
 */
export const STEP_TIMEOUT_MS = 2_000;

export async function within<Value>(
  what: string,
  work: Value | PromiseLike<Value>,
): Promise<Awaited<Value>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${STEP_TIMEOUT_MS} ms.`)),
      STEP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

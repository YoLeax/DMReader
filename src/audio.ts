/** resume() can stay pending until a user gesture. Never treat that as playable. */
export async function resumeAudio(context: Pick<AudioContext, 'state' | 'resume'>, timeoutMs = 800): Promise<boolean> {
  const isRunning = () => context.state === 'running';
  if (isRunning()) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.resume(),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    return isRunning();
  } catch (error) {
    if ((error as Error).name === 'NotAllowedError') return false;
    throw error;
  } finally { clearTimeout(timer); }
}
